/**
 * GROUPS, DUELS, DUNGEON DIFFICULTY AND INSTANCE RESET -- the wire half of the unit right-click menus.
 *
 * Nothing here draws and nothing here is a Lua global. `game/ui/group-bridge.ts` is the engine-global
 * half; this file owns the packets and the state they imply, exactly as `object/loot.ts` owns looting's.
 * The client's own `UnitPopup.lua`, `PartyMemberFrame.lua`, `StaticPopup.lua` and `UIParent.lua` are
 * already in the manifest and already draw every menu, submenu and confirmation dialogue this feeds --
 * so the deliverable is a correct event and a correct packet, never a frame.
 *
 * ## WHERE THE LAYOUTS COME FROM, said plainly
 *
 * Nothing in the game's own DATA states a packet body, so every body below is from **TrinityCore
 * 3.3.5** (`GroupHandler.cpp`, `Group::SendUpdateToPlayer`, `MiscHandler.cpp`'s difficulty handlers,
 * `Player::DuelComplete`, `InstanceSaveMgr`). That is the same class of source, with the same caveat,
 * as `object/loot.ts` and `object/items.ts`: a server implementation, labelled as such, whose oracle is
 * the residual. Every arm records `consumed` against `bodySize` so a wrong layout shows up as a wrong
 * remainder rather than as a feature that quietly misbehaves.
 *
 * The 1.12 reference (`samples/benilla`) is the STRUCTURE for the duel arc and it is quoted where it
 * decides something -- `crates/benilla/src/ui_duel.rs` is byte-pinned against WoW.exe's own duel
 * translation unit, and its four laws (symmetric challenge, client-driven countdown, arbiter-gated
 * completion, client-composed outcome line) are version-independent. Its NUMBERS are not taken: 3.3.5a
 * opcodes come from `network/game/opcode.js`, which already carried every one of them.
 *
 * ## THE OPCODES, 3.3.5a, all of them already in `opcode.js`
 *
 *   CMSG_GROUP_INVITE 0x06E   SMSG_GROUP_INVITE 0x06F   CMSG_GROUP_CANCEL 0x070
 *   CMSG_GROUP_ACCEPT 0x072   CMSG_GROUP_DECLINE 0x073  SMSG_GROUP_DECLINE 0x074
 *   CMSG_GROUP_UNINVITE 0x075 CMSG_GROUP_SET_LEADER 0x078
 *   CMSG_LOOT_METHOD 0x07A    CMSG_GROUP_DISBAND 0x07B  SMSG_GROUP_DESTROYED 0x07C
 *   SMSG_GROUP_LIST 0x07D     SMSG_PARTY_COMMAND_RESULT 0x07F
 *   SMSG_DUEL_REQUESTED 0x167 SMSG_DUEL_OUTOFBOUNDS 0x168 SMSG_DUEL_INBOUNDS 0x169
 *   SMSG_DUEL_COMPLETE 0x16A  SMSG_DUEL_WINNER 0x16B
 *   CMSG_DUEL_ACCEPTED 0x16C  CMSG_DUEL_CANCELLED 0x16D  SMSG_DUEL_COUNTDOWN 0x2B7
 *   CMSG_RESET_INSTANCES 0x31D SMSG_INSTANCE_RESET 0x31E SMSG_INSTANCE_RESET_FAILED 0x31F
 *   MSG_SET_DUNGEON_DIFFICULTY 0x329  MSG_SET_RAID_DIFFICULTY 0x4EB
 *   SMSG_INSTANCE_DIFFICULTY 0x33B    CMSG_OPT_OUT_OF_LOOT 0x409
 *
 * ## Two traps this family carries
 *
 *  - **EVERY GUID HERE IS A FULL 8-BYTE u64, NOT PACKED** -- `SMSG_GROUP_LIST`'s member rows and group
 *    guid, `SMSG_DUEL_REQUESTED`'s two guids, `CMSG_GROUP_SET_LEADER`'s target. Same as the loot family
 *    and the opposite of the combat log's. Reading a packed one desyncs the whole member list.
 *  - **`readCStr`, never `readCString`.** `net/packet.js:47-77` carries the measurement: byte-buffer's
 *    own `readCString` does not consume the terminator of an EMPTY string, and `SMSG_PARTY_COMMAND_RESULT`
 *    ships an empty member name on most results.
 */
import EventEmitter from 'events';

import { GameHandler } from '../handler';
import GameOpcode from '../opcode';
import GamePacket from '../packet';
import { GUID_BYTES, guidBytes, guidHex } from '../../guid-hex';

/** One row of `SMSG_GROUP_LIST`'s member block. */
export interface GroupMember {
  name: string;
  guid: string;
  /** The wire's `online` byte. 1 = online; the client's `UnitIsConnected` reads this. */
  online: boolean;
  /** Raid subgroup, 0-based. Always 0 in a party. */
  subGroup: number;
  /** `MEMBER_FLAG_*`: 0x01 assistant, 0x02 main tank, 0x04 main assist. */
  flags: number;
  /** 3.3's LFG role mask. 0 for a hand-made group. */
  roles: number;
}

/**
 * The party/raid mirror, plus the duel and instance state that the same menus read.
 *
 * One handler rather than three because they share exactly one thing that matters: the SELF menu's
 * entries are decided by the party state and the difficulty state together (`unitpopup.lua:455-485`
 * reads both before its first row), and a duel's availability is decided by the target's, so splitting
 * them would mean the bridge holding three handles to answer one menu.
 */
export class GroupHandler extends EventEmitter {
  private game: GameHandler;

  /** Members OTHER than us, in wire order. `party1`..`party4` are these, in this order. */
  public members: GroupMember[] = [];

  /** The group's own guid, `null` when solo. What "am I in a group at all" is decided by. */
  public groupGuid: string | null = null;

  /** `GROUP_TYPE_*` mask from `SMSG_GROUP_LIST`: 0x01 = raid. */
  public groupType = 0;

  /** The leader's guid, or null when solo. `IsPartyLeader` compares it to our own. */
  public leaderGuid: string | null = null;

  /** Loot method index, `LootMethod` order below. Only meaningful with a group. */
  public lootMethod = 0;

  /** Loot threshold, an item quality 2..4. The engine's default outside a group is 2 (Uncommon). */
  public lootThreshold = 2;

  /** Master looter's guid, or null. */
  public looterGuid: string | null = null;

  /** `SMSG_GROUP_LIST`'s dungeon difficulty (1 Normal / 2 Heroic). */
  public dungeonDifficulty = 1;

  /** `SMSG_GROUP_LIST`'s raid difficulty (1..4). */
  public raidDifficulty = 1;

  /** The name on a pending `SMSG_GROUP_INVITE`, or null. Cleared by accept, decline or a new list. */
  public pendingInviter: string | null = null;

  /**
   * The duel-flag GameObject guid of a pending or running duel; null = none.
   *
   * This is the reference's `[0xb73240]` (`benilla/src/ui_duel.rs:80-84`): set by the request, echoed
   * back on accept and cancel, and cleared ONLY by completion. Its non-null -> null edge is what fires
   * `DUEL_FINISHED`, which is what hides the popup (`uiparent.lua:692-696`).
   */
  public duelArbiter: string | null = null;

  /** The challenger's name on a pending duel, or null. */
  public duelChallenger: string | null = null;

  constructor(gameHandler: GameHandler) {
    super();
    // `this.game` FIRST -- `subscribe` reads it. Same order as `LootHandler`'s constructor.
    this.game = gameHandler;

    this.subscribe('SMSG_GROUP_INVITE', this.handleInvite);
    this.subscribe('SMSG_GROUP_DECLINE', this.handleDecline);
    this.subscribe('SMSG_GROUP_LIST', this.handleList);
    this.subscribe('SMSG_GROUP_DESTROYED', this.handleDestroyed);
    this.subscribe('SMSG_GROUP_UNINVITE', this.handleUninvited);
    this.subscribe('SMSG_PARTY_COMMAND_RESULT', this.handleCommandResult);

    this.subscribe('SMSG_DUEL_REQUESTED', this.handleDuelRequested);
    this.subscribe('SMSG_DUEL_COUNTDOWN', this.handleDuelCountdown);
    this.subscribe('SMSG_DUEL_COMPLETE', this.handleDuelComplete);
    this.subscribe('SMSG_DUEL_WINNER', this.handleDuelWinner);
    this.subscribe('SMSG_DUEL_OUTOFBOUNDS', () => this.emit('duelOutOfBounds'));
    this.subscribe('SMSG_DUEL_INBOUNDS', () => this.emit('duelInBounds'));

    this.subscribe('MSG_SET_DUNGEON_DIFFICULTY', this.handleDungeonDifficulty);
    this.subscribe('MSG_SET_RAID_DIFFICULTY', this.handleRaidDifficulty);
    this.subscribe('SMSG_INSTANCE_DIFFICULTY', this.handleInstanceDifficulty);
    this.subscribe('SMSG_INSTANCE_RESET', this.handleInstanceReset);
    this.subscribe('SMSG_INSTANCE_RESET_FAILED', this.handleInstanceResetFailed);

    // Same reason `LootHandler` and `ItemHandler` do it: this client reconnects without a page reload,
    // and a party, a pending invitation or a running duel belongs to the session that had them. A stale
    // `pendingInviter` would put a popup in front of the next character with nobody behind it.
    this.game.on('packet:receive:SMSG_LOGIN_VERIFY_WORLD', () => this.reset());
  }

  /**
   * One arm with the over-read catch, for the reason `loot.ts#subscribe` documents: `byte-buffer`
   * THROWS past the frame and an uncaught throw escapes `GameHandler#dataReceived`'s receive loop,
   * taking every packet still buffered in that data event with it.
   *
   * The residual is recorded on `window.groupWire` on BOTH paths. On a throw, `consumed` is where the
   * read cursor died, which is the most useful number available when one of these layouts is wrong.
   */
  private subscribe(name: string, arm: (gp: GamePacket) => void): void {
    this.game.on(`packet:receive:${name}`, (gp: GamePacket) => {
      const bodySize = gp.bodySize;
      try {
        arm.call(this, gp);
        groupWire.record({ opcode: name, bodySize, consumed: gp.index - gp.headerSize, threw: false });
      } catch (e) {
        groupWire.record({ opcode: name, bodySize, consumed: gp.index - gp.headerSize, threw: true });
        console.warn(`GroupHandler: ${name} decode threw`, e);
      }
    });
  }

  /** Eight little-endian bytes -> the normalised guid string. `guid-hex.ts` says why not a Number. */
  private readFullGuid(gp: GamePacket): string {
    const bytes = new Uint8Array(GUID_BYTES);
    for (let i = 0; i < GUID_BYTES; ++i) {
      bytes[i] = gp.readUnsignedByte();
    }
    return guidHex(bytes);
  }

  // -- Reads ----------------------------------------------------------------------------------------

  /**
   * `SMSG_GROUP_INVITE` (0x06F). TrinityCore `Group::SendGroupInvite` / `WorldSession::SendGroupInvite`:
   *
   *     u8  canAccept     -- 1 = a real invitation; 0 = "already in a group" notice
   *     cstr inviterName
   *     u32 unk (0)
   *     u8  count (0)     -- the 3.3 realm-transfer block's length
   *     u32 unk (0)
   *
   * Only the first two fields are read for anything; the tail is consumed so the residual is zero.
   */
  private handleInvite(gp: GamePacket): void {
    const canAccept = gp.readUnsignedByte();
    const inviter = gp.readCStr();
    gp.readUnsignedInt();
    const count = gp.readUnsignedByte();
    for (let i = 0; i < count; ++i) {
      gp.readUnsignedInt();
    }
    gp.readUnsignedInt();
    if (canAccept === 0) {
      // Not an invitation -- the server is telling us the invite could not be offered. No popup.
      return;
    }
    this.pendingInviter = inviter;
    // The EVENT, not a dialogue: `uiparent.lua:544-546` is what shows `StaticPopupDialogs["PARTY_INVITE"]`,
    // whose own OnAccept/OnCancel call `AcceptGroup`/`DeclineGroup`. Raising the event is the whole job.
    this.emit('inviteRequest', inviter);
  }

  /** `SMSG_GROUP_DECLINE` (0x074): a lone cstring, the name of whoever refused. */
  private handleDecline(gp: GamePacket): void {
    this.emit('inviteDeclined', gp.readCStr());
  }

  /**
   * `SMSG_GROUP_LIST` (0x07D) -- the whole roster, and the only feed the party frames have.
   *
   * TrinityCore 3.3.5 `Group::SendUpdateToPlayer`:
   *
   *     u8  groupType          -- 0x01 raid, 0x02 bg, 0x04 lfg
   *     u8  subGroup           -- OUR OWN subgroup
   *     u8  flags              -- OUR OWN member flags
   *     u8  roles              -- OUR OWN LFG roles (3.3)
   *     if (groupType & 0x04) { u8 lfgState; u32 dungeonId }
   *     u64 groupGuid
   *     u32 counter            -- 3.3; a sequence number, ignored here
   *     u32 memberCount        -- members OTHER than us
   *     memberCount x { cstr name; u64 guid; u8 online; u8 subGroup; u8 flags; u8 roles }
   *     u64 leaderGuid
   *     if (memberCount > 0) {
   *       u8 lootMethod; u64 looterGuid; u8 lootThreshold;
   *       u8 dungeonDifficulty; u8 raidDifficulty; u8 dynamicDifficulty
   *     }
   *
   * **A ONE-BYTE `memberCount` of 0 with a leader guid still following is the "group destroyed" form**
   * on some cores; `SMSG_GROUP_DESTROYED` is the one this client relies on, and an empty member list
   * here is treated the same way -- see `handleDestroyed`.
   */
  private handleList(gp: GamePacket): void {
    this.groupType = gp.readUnsignedByte();
    gp.readUnsignedByte(); // our subgroup
    gp.readUnsignedByte(); // our flags
    gp.readUnsignedByte(); // our LFG roles
    if ((this.groupType & 0x04) !== 0) {
      gp.readUnsignedByte();
      gp.readUnsignedInt();
    }
    this.groupGuid = this.readFullGuid(gp);
    gp.readUnsignedInt(); // 3.3 counter
    const count = gp.readUnsignedInt();
    const members: GroupMember[] = [];
    for (let i = 0; i < count; ++i) {
      const name = gp.readCStr();
      const guid = this.readFullGuid(gp);
      const online = gp.readUnsignedByte() !== 0;
      const subGroup = gp.readUnsignedByte();
      const flags = gp.readUnsignedByte();
      const roles = gp.readUnsignedByte();
      members.push({ name, guid, online, subGroup, flags, roles });
    }
    this.leaderGuid = this.readFullGuid(gp);
    if (count > 0) {
      this.lootMethod = gp.readUnsignedByte();
      this.looterGuid = this.readFullGuid(gp);
      this.lootThreshold = gp.readUnsignedByte();
      this.dungeonDifficulty = gp.readUnsignedByte();
      this.raidDifficulty = gp.readUnsignedByte();
      gp.readUnsignedByte(); // dynamic difficulty (3.3)
    }
    this.members = members;
    // An arriving roster settles any invitation we had out or in.
    this.pendingInviter = null;
    if (count === 0) {
      this.clearGroup();
      return;
    }
    this.emit('rosterChanged');
  }

  /** `SMSG_GROUP_DESTROYED` (0x07C): an EMPTY body. The group is gone. */
  private handleDestroyed(): void {
    this.clearGroup();
  }

  /** `SMSG_GROUP_UNINVITE` (0x077): an EMPTY body. WE were removed. */
  private handleUninvited(): void {
    this.clearGroup();
  }

  /**
   * `SMSG_PARTY_COMMAND_RESULT` (0x07F). TrinityCore `WorldSession::SendPartyResult`:
   *
   *     u32 operation   -- 0 invite, 1 uninvite, 2 leave, 3 swap
   *     cstr member
   *     u32 result      -- `PartyResult`; 0 = ok
   *     u32 lfgBootTime -- 3.3
   *
   * Forwarded rather than interpreted: the reason strings live in the client's own `GlobalStrings`
   * and turning a code into a line is the chat system's job, which this client does not have yet.
   */
  private handleCommandResult(gp: GamePacket): void {
    const operation = gp.readUnsignedInt();
    const member = gp.readCStr();
    const result = gp.readUnsignedInt();
    gp.readUnsignedInt();
    this.emit('commandResult', { operation, member, result });
  }

  /**
   * `SMSG_DUEL_REQUESTED` (0x167): `u64 arbiterGuid, u64 challengerGuid`. Both FULL guids.
   *
   * **THE CHALLENGE IS SYMMETRIC** and that is not a detail: the server sends this to challenger and
   * challenged alike (`benilla/src/ui_duel.rs:13-20`, byte-read from WoW.exe `0x4d49d0`). The client
   * stores the arbiter, then compares the challenger guid with its own -- EQUAL means we are the one
   * who asked, and the reference then immediately sends `CMSG_DUEL_ACCEPTED` and shows the
   * "You have requested a duel." error line rather than a popup. DIFFERENT means a real challenge.
   *
   * This handler cannot make that comparison -- it has no `SelfPlayer` -- so it publishes both guids
   * and `group-bridge.ts` (which has the world) decides. Keeping the decision on the side that knows
   * who we are is the same split `LootHandler` uses for the display-index mapping.
   */
  private handleDuelRequested(gp: GamePacket): void {
    const arbiter = this.readFullGuid(gp);
    const challenger = this.readFullGuid(gp);
    this.duelArbiter = arbiter;
    this.emit('duelRequested', { arbiter, challenger });
  }

  /**
   * `SMSG_DUEL_COUNTDOWN` (0x2B7): `u32 milliseconds`.
   *
   * **The countdown is CLIENT-driven** (`ui_duel.rs:21-25`, WoW.exe `0x4d4ae0`): the wire carries a
   * single duration, the client divides by 1000 and prints `DUEL_COUNTDOWN` as a CHAT_MSG_SYSTEM line
   * once per second while non-zero. It is not an on-screen banner. This client has no chat sink yet,
   * so the milliseconds are published and the timer is a named gap -- see `group-bridge.ts`.
   */
  private handleDuelCountdown(gp: GamePacket): void {
    this.emit('duelCountdown', gp.readUnsignedInt());
  }

  /**
   * `SMSG_DUEL_COMPLETE` (0x16A): `u8 started`.
   *
   * **Only acts if an arbiter is held** (`ui_duel.rs:26-29`, WoW.exe `0x4d4b20`). `started == 0` means
   * the duel never began, which additionally shows `ERR_DUEL_CANCELLED`. Either way the arbiter clears
   * and `DUEL_FINISHED` fires, which is what hides both duel popups (`uiparent.lua:692-696`).
   */
  private handleDuelComplete(gp: GamePacket): void {
    const started = gp.readUnsignedByte() !== 0;
    if (this.duelArbiter === null) {
      return;
    }
    this.duelArbiter = null;
    this.duelChallenger = null;
    this.emit('duelComplete', started);
  }

  /**
   * `SMSG_DUEL_WINNER` (0x16B): `u8 type, cstr name1, cstr name2`.
   *
   * The outcome LINE is composed client-side from the flag and the two names against
   * `DUEL_WINNER_KNOCKOUT` / `DUEL_WINNER_RETREAT` (`ui_duel.rs:30-32`, WoW.exe `0x4d4ba0`) and printed
   * as CHAT_MSG_SYSTEM -- bystanders read it too, because the server broadcasts it to everyone nearby.
   * With no chat sink in this client the names are published and the line is a named gap.
   */
  private handleDuelWinner(gp: GamePacket): void {
    const type = gp.readUnsignedByte();
    const winner = gp.readCStr();
    const loser = gp.readCStr();
    this.emit('duelWinner', { type, winner, loser });
  }

  /**
   * `MSG_SET_DUNGEON_DIFFICULTY` (0x329) coming BACK: `u32 difficulty, u32 unk(1), u32 isInGroup`.
   *
   * It is an `MSG_`, so the same opcode is the request and the confirmation. TrinityCore
   * `WorldSession::HandleSetDungeonDifficultyOpcode` -> `Group::SetDungeonDifficulty` ->
   * `Player::SendDungeonDifficulty`.
   */
  private handleDungeonDifficulty(gp: GamePacket): void {
    this.dungeonDifficulty = gp.readUnsignedInt();
    gp.readUnsignedInt();
    gp.readUnsignedInt();
    this.emit('difficultyChanged');
  }

  /** `MSG_SET_RAID_DIFFICULTY` (0x4EB) coming back: the same three words. */
  private handleRaidDifficulty(gp: GamePacket): void {
    this.raidDifficulty = gp.readUnsignedInt();
    gp.readUnsignedInt();
    gp.readUnsignedInt();
    this.emit('difficultyChanged');
  }

  /** `SMSG_INSTANCE_DIFFICULTY` (0x33B): `u32 difficulty, u32 isDynamic`. Sent on entering a map. */
  private handleInstanceDifficulty(gp: GamePacket): void {
    const difficulty = gp.readUnsignedInt();
    const dynamic = gp.readUnsignedInt() !== 0;
    this.emit('instanceDifficulty', { difficulty, dynamic });
  }

  /** `SMSG_INSTANCE_RESET` (0x31E): `u32 mapId`. The reset succeeded. */
  private handleInstanceReset(gp: GamePacket): void {
    this.emit('instanceReset', { mapId: gp.readUnsignedInt(), reason: null });
  }

  /** `SMSG_INSTANCE_RESET_FAILED` (0x31F): `u32 reason, u32 mapId`. */
  private handleInstanceResetFailed(gp: GamePacket): void {
    const reason = gp.readUnsignedInt();
    const mapId = gp.readUnsignedInt();
    this.emit('instanceReset', { mapId, reason });
  }

  // -- Writes ---------------------------------------------------------------------------------------

  /**
   * `CMSG_GROUP_INVITE` (0x06E): `cstr name, u32 unk(0)`.
   *
   * TrinityCore `HandleGroupInviteOpcode` reads the name and then `read_skip<uint32>()`, so the trailing
   * word is required for the frame to be the length the server expects even though its value is unused.
   */
  invite(name: string): void {
    const gp = this.packet(GameOpcode.CMSG_GROUP_INVITE, cstrBytes(name) + 4);
    gp.writeCString(name);
    gp.writeUnsignedInt(0);
    this.game.send(gp);
  }

  /**
   * `CMSG_GROUP_ACCEPT` (0x072): `u32 unk(0)`.
   *
   * NOT an empty body -- `HandleGroupAcceptOpcode`'s first statement is `recvData.read_skip<uint32>()`,
   * and a short frame is dropped by `WorldSession::Update` before the handler runs.
   */
  acceptInvite(): void {
    const gp = this.packet(GameOpcode.CMSG_GROUP_ACCEPT, 4);
    gp.writeUnsignedInt(0);
    this.game.send(gp);
    this.pendingInviter = null;
  }

  /** `CMSG_GROUP_DECLINE` (0x073): an EMPTY body. Leaves nothing behind on either side. */
  declineInvite(): void {
    this.game.send(this.packet(GameOpcode.CMSG_GROUP_DECLINE, 0));
    this.pendingInviter = null;
  }

  /** `CMSG_GROUP_UNINVITE` (0x075): `cstr name`, and nothing after it. */
  uninvite(name: string): void {
    const gp = this.packet(GameOpcode.CMSG_GROUP_UNINVITE, cstrBytes(name));
    gp.writeCString(name);
    this.game.send(gp);
  }

  /**
   * `CMSG_GROUP_DISBAND` (0x07B): an EMPTY body -- and this is what LEAVING is.
   *
   * There is no "leave party" opcode in 3.3.5a. `LeaveParty()` sends `CMSG_GROUP_DISBAND`; the server
   * removes the sender and only actually disbands when that empties the group
   * (`HandleGroupDisbandOpcode` -> `Player::RemoveFromGroup`). Naming it `leave` here rather than
   * `disband` because that is the verb the menu offers.
   */
  leave(): void {
    this.game.send(this.packet(GameOpcode.CMSG_GROUP_DISBAND, 0));
  }

  /** `CMSG_GROUP_SET_LEADER` (0x078): `u64 guid`, FULL. */
  setLeader(guid: string): void {
    const gp = this.packet(GameOpcode.CMSG_GROUP_SET_LEADER, GUID_BYTES);
    gp.write(Array.from(guidBytes(guid)));
    this.game.send(gp);
  }

  /**
   * `CMSG_LOOT_METHOD` (0x07A): `u32 method, u64 masterGuid, u32 threshold`.
   *
   * One packet carries BOTH the method and the threshold, which is why `SetLootMethod` and
   * `SetLootThreshold` both come through here with the other value taken from our own mirror.
   */
  setLootMethod(method: number, masterGuid: string | null, threshold: number): void {
    const gp = this.packet(GameOpcode.CMSG_LOOT_METHOD, 4 + GUID_BYTES + 4);
    gp.writeUnsignedInt(method);
    gp.write(Array.from(guidBytes(masterGuid ?? '0x0')));
    gp.writeUnsignedInt(threshold);
    this.game.send(gp);
  }

  /** `CMSG_OPT_OUT_OF_LOOT` (0x409): `u32 optOut`. */
  setOptOutOfLoot(on: boolean): void {
    const gp = this.packet(GameOpcode.CMSG_OPT_OUT_OF_LOOT, 4);
    gp.writeUnsignedInt(on ? 1 : 0);
    this.game.send(gp);
  }

  /** `CMSG_DUEL_ACCEPTED` (0x16C): `u64 arbiterGuid`, FULL. */
  acceptDuel(): void {
    if (this.duelArbiter === null) {
      return;
    }
    const gp = this.packet(GameOpcode.CMSG_DUEL_ACCEPTED, GUID_BYTES);
    gp.write(Array.from(guidBytes(this.duelArbiter)));
    this.game.send(gp);
  }

  /**
   * `CMSG_DUEL_CANCELLED` (0x16D): `u64 arbiterGuid`, FULL.
   *
   * The arbiter is NOT cleared here. Only `SMSG_DUEL_COMPLETE` clears it (`ui_duel.rs:26-29`); clearing
   * it on our own send would make the completion that follows a no-op and `DUEL_FINISHED` would never
   * fire, leaving the popup up.
   */
  cancelDuel(): void {
    if (this.duelArbiter === null) {
      return;
    }
    const gp = this.packet(GameOpcode.CMSG_DUEL_CANCELLED, GUID_BYTES);
    gp.write(Array.from(guidBytes(this.duelArbiter)));
    this.game.send(gp);
  }

  /** `MSG_SET_DUNGEON_DIFFICULTY` (0x329) going out: `u32 difficulty`. */
  setDungeonDifficulty(difficulty: number): void {
    const gp = this.packet(GameOpcode.MSG_SET_DUNGEON_DIFFICULTY, 4);
    gp.writeUnsignedInt(difficulty);
    this.game.send(gp);
  }

  /** `MSG_SET_RAID_DIFFICULTY` (0x4EB) going out: `u32 difficulty`. */
  setRaidDifficulty(difficulty: number): void {
    const gp = this.packet(GameOpcode.MSG_SET_RAID_DIFFICULTY, 4);
    gp.writeUnsignedInt(difficulty);
    this.game.send(gp);
  }

  /** `CMSG_RESET_INSTANCES` (0x31D): an EMPTY body. Resets every instance we are eligible to reset. */
  resetInstances(): void {
    this.game.send(this.packet(GameOpcode.CMSG_RESET_INSTANCES, 0));
  }

  // -- State ----------------------------------------------------------------------------------------

  /**
   * A packet sized EXACTLY to its body.
   *
   * `GameHandler#send` derives the declared LENGTH from the buffer size, so an over-allocated buffer
   * sends a wrong length field -- `handler.js:300-318` records that `CMSG_NAME_QUERY` has been shipping
   * 50 bytes of trailing zeros for exactly this reason. Nothing new here repeats it.
   */
  private packet(opcode: number, bodyBytes: number): GamePacket {
    return new GamePacket(opcode, GamePacket.HEADER_SIZE_OUTGOING + bodyBytes);
  }

  /** Back to solo. Emits once, so a listener that rebuilds the party frames does it one time. */
  private clearGroup(): void {
    const had = this.groupGuid !== null || this.members.length > 0;
    this.members = [];
    this.groupGuid = null;
    this.groupType = 0;
    this.leaderGuid = null;
    this.looterGuid = null;
    this.lootMethod = 0;
    this.lootThreshold = 2;
    if (had) {
      this.emit('rosterChanged');
    }
  }

  /** Everything per-login, dropped. Called on `SMSG_LOGIN_VERIFY_WORLD`. */
  private reset(): void {
    this.pendingInviter = null;
    this.duelArbiter = null;
    this.duelChallenger = null;
    this.dungeonDifficulty = 1;
    this.raidDifficulty = 1;
    this.clearGroup();
  }
}

/**
 * The byte cost of `writeCString(s)` -- the UTF-8 encoding PLUS the terminator.
 *
 * NOT `s.length + 1`, and not pedantry: `GamePacket` is a fixed-size `ByteBuffer` with
 * `implicitGrowth` off, so a name whose UTF-8 form is longer than its JS length (any non-ASCII
 * character -- a Cyrillic character name is two bytes each) writes past the end and byte-buffer THROWS
 * out of the send.
 *
 * TRANSCRIBED FROM `writeCString`'s OWN ENCODER rather than delegated to `TextEncoder`, for two
 * reasons. The branch boundaries must be byte-identical to the thing doing the writing
 * (`byte-buffer/dist/byte-buffer.js:316-368`: 1 byte to 0x7F, 2 to 0x7FF, 3 for a non-surrogate BMP
 * code unit, 4 for a surrogate PAIR consuming two units) -- and `TextEncoder` is NOT DEFINED in this
 * project's jsdom test environment, so depending on it makes the send untestable. The unpaired-surrogate
 * case the encoder throws on is counted as 4 here; it cannot occur in a character name and the encoder
 * would reject the write before the size mattered.
 */
function cstrBytes(value: string): number {
  let bytes = 1; // the terminator
  for (let i = 0; i < value.length; ++i) {
    const c = value.charCodeAt(i);
    if (c <= 0x7f) {
      bytes += 1;
    } else if (c <= 0x7ff) {
      bytes += 2;
    } else if (c <= 0xd7ff || (c >= 0xe000 && c <= 0xffff)) {
      bytes += 3;
    } else {
      bytes += 4;
      ++i; // the low surrogate, consumed by the same four-byte sequence
    }
  }
  return bytes;
}

/**
 * `LootMethod`'s wire order, which is also the order of `UnitPopupMenus["LOOT_METHOD"]`'s first five
 * entries (`unitpopup.lua:159`). The STRINGS are the ones `GetLootMethod` must answer, because
 * `UnitLootMethod[GetLootMethod()]` indexes a table by exactly these keys (`unitpopup.lua:171-176`) and
 * a miss there is a nil-index error inside `UnitPopup_ShowMenu`.
 */
export const LOOT_METHOD_NAMES = [
  'freeforall', 'roundrobin', 'master', 'group', 'needbeforegreed',
] as const;

/** The residual instrument, on `window.groupWire`. Bounded; a log would grow without limit. */
class GroupWire {
  public rows: { at: number; opcode: string; bodySize: number; consumed: number; threw: boolean }[] = [];

  record(row: { opcode: string; bodySize: number; consumed: number; threw: boolean }): void {
    this.rows.push({ at: performance.now(), ...row });
    if (this.rows.length > 200) {
      this.rows.splice(0, this.rows.length - 200);
    }
  }

  /** Every arm whose `consumed` did not equal its `bodySize` -- i.e. every layout that is wrong. */
  get bad(): typeof this.rows {
    return this.rows.filter((r) => r.threw || r.consumed !== r.bodySize);
  }
}

export const groupWire = new GroupWire();
if (typeof window !== 'undefined') {
  (window as never as Record<string, unknown>).groupWire = groupWire;
}

export default GroupHandler;
