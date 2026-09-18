/**
 * THE UNIT RIGHT-CLICK MENUS' ENGINE HALF -- groups, duels, dungeon difficulty and instance reset.
 *
 * NOTHING HERE DRAWS A MENU, AND THAT IS THE WHOLE POINT. 3.3.5a ships a complete unit-popup system:
 * `UnitPopup.lua` holds 25 menu definitions over 102 distinct entries, the conditions that show, hide,
 * enable and disable each one, and the action each one performs. `PlayerFrame.lua:45-48` and
 * `TargetFrame.lua:84-91` already hang it off the portraits through `SecureUnitButton_OnLoad`, which
 * sets `*type2 = "menu"` so the RIGHT button routes to `SecureActionButton_OnClick`, which finds the
 * handler with `rawget(self, "menu")` (`SecureTemplates.lua:515-529`) -- there is no
 * `SECURE_ACTIONS.menu`, so the frame's own `menu` field IS the path. Every step of that is the
 * client's own Lua and every step of it already runs here.
 *
 * So this file supplies engine globals and nothing else. Where a global cannot be answered it goes
 * through `notImplemented`, which puts its NAME in the load report -- never a silent no-op, because a
 * menu entry that does nothing is worse than one that is absent: the owner cannot tell it from a bug.
 *
 * ## THE CENSUS THIS FILE WAS WRITTEN FROM
 *
 * Read out of `UnitPopup.lua` itself, not from a list. 48 of the 102 entries are reachable from the two
 * portraits the owner asked about -- `SELF` (own portrait, `PlayerFrame.lua:498-503`) and
 * `PLAYER`/`PARTY`/`RAID_PLAYER`/`TARGET` (the target's, `TargetFrame.lua:646-674`) -- counting their
 * nested submenus (`PVP_FLAG`, `LOOT_METHOD`, `LOOT_THRESHOLD`, `OPT_OUT_LOOT_TITLE`,
 * `DUNGEON_DIFFICULTY`, `RAID_DIFFICULTY`, `RAID_TARGET_ICON`).
 *
 * **TWO OF THE CLIENT'S OWN RULES DECIDE MORE THAN ANY GLOBAL HERE, and both are worth knowing before
 * reading a menu and calling it wrong:**
 *
 *  1. `DUNGEON_DIFFICULTY` AND `RAID_DIFFICULTY` ARE HIDDEN BELOW LEVEL 65.
 *     `unitpopup.lua:699-706` -- `if UnitLevel("player") < 65 and GetDungeonDifficulty() == 1 then
 *     hide`. So on a level-5 character the difficulty submenus are correctly ABSENT from his own
 *     portrait, and their absence is the client working, not this file failing. They appear the moment
 *     the character is 65+, or immediately if the difficulty is already Heroic.
 *  2. `INVITE` IS HIDDEN WHEN `UnitCanCooperate("player", unit)` IS FALSE (`unitpopup.lua:494-499`,
 *     through `canCoop`). That global was a declared gap answering FALSE, which hid "Invite to group"
 *     on every player in the world. It is REAL below, and that single answer is what makes the
 *     owner's first ask visible at all.
 *
 * ## WHAT IS ANSWERED, WHAT IS DECLARED, AND WHAT CANNOT EXIST HERE
 *
 * Answered for real: the party roster (`GetNumPartyMembers`, `UnitInParty`, `IsPartyLeader`, the
 * `party1..party4` tokens), invitation (`InviteUnit`, `AcceptGroup`, `DeclineGroup`, `UninviteUnit`,
 * `LeaveParty`, `PromoteToLeader`), duels (`StartDuel`, `AcceptDuel`, `CancelDuel`), difficulty
 * (`Get`/`SetDungeonDifficulty`, `Get`/`SetRaidDifficulty`), `ResetInstances`, the group-loot settings,
 * `UnitCanCooperate`, `TargetUnit`, `FocusUnit`/`ClearFocus`, `InCombatLockdown`, `HasFullControl`.
 *
 * Declared gaps, each named in the load report with its reason: everything belonging to a system this
 * client does not have -- voice chat (16 globals), Battle.net friends (4), arena teams (2),
 * refer-a-friend (4), pets (4), vehicles (2), the friends/ignore list (3), trade, inspect, follow,
 * achievements, the PvP flag and AFK report (4), and raid officer management including the main
 * tank/assist assignments (6) and the raid target marks. None of those can be answered without a
 * subsystem that does not exist, and every one of them sits behind an entry the client's own
 * conditions already hide once its gate answers honestly.
 *
 * ## COST
 *
 * Opening a menu runs `UnitPopup_HideButtons` once over the chosen menu's entries -- at most 25 rows
 * for `PARTY`, 12 for `SELF` -- and every global it calls here is an O(1) field read or a walk of at
 * most four roster rows. Nothing here subscribes to a per-frame tick and nothing here touches the
 * widget draw list outside the dropdown frames the client's own Lua already creates, so the offscreen
 * target's fingerprint is dirtied when the list appears and when it closes, and not in between. That
 * is the same shape the skills list measured (144 frames / 12 dirty at 500 draw items).
 */
import type World from '../world';
import type { GroupHandler, GroupMember } from '../../network/game/object/group';
import { LOOT_METHOD_NAMES } from '../../network/game/object/group';
import { LuaVM } from './framexml/lua/vm';
import { notImplemented } from './framexml/lua/methods/region';
import { fireEvent } from './framexml/lua/events';
import { emptySnapshot, getUnit, setUnit } from './framexml/lua/api/units';
import { snapshotOf } from './unit-bridge';
import { resolveUnitToken } from '../world/unit-tokens';
import type Unit from '../classes/unit';
import { REACTION_FRIENDLY } from '../world/faction';
import { spellData } from '../pipeline/dbc/spell-data';
import castWithRefusal from './cast-refusal';

/**
 * `SPELL_EFFECT_DUEL`.
 *
 * MEASURED in the served `12340/dbfilesclient/spell.dbc`: spell **7266 "Duel"** reads
 * `Effect[0..2] = 83, 0, 0` (effect column 71, name column 136 -- see `dbc/spell-data.ts#COL.effect`).
 *
 * The lookup is by EFFECT and not by the id 7266, because that is what the reference client does: its
 * spell-learned walk stores the id of any learned spell whose `SpellRec+0xf4` is `0x53` into a
 * duel-spell global, which `StartDuel` then casts
 * (`samples/benilla/crates/benilla/src/ui_duel.rs:56-63`, byte-read from WoW.exe
 * `0x4b2605`/`0x4d4810`). Mirroring the mechanism means a data change moves with the data.
 */
const SPELL_EFFECT_DUEL = 83;

/** How many `party<N>` tokens 3.3.5a has. A party is the player plus four. */
const MAX_PARTY_MEMBERS = 4;

/** `GROUP_TYPE_FLAG_RAID` in `SMSG_GROUP_LIST`'s first byte. */
const GROUP_TYPE_RAID = 0x01;

/** `MEMBER_FLAG_ASSISTANT` in a roster row's flags byte. */
const MEMBER_FLAG_ASSISTANT = 0x01;

/**
 * `PartyResult` -> the client's OWN GlobalString that reports it.
 *
 * The CODES are TrinityCore 3.3.5's `PartyResult` enum, labelled as a server implementation like every
 * other number in this area. THE STRINGS ARE THE CLIENT'S -- every name below was checked to exist
 * verbatim in the served `GlobalStrings.lua`, and the `_S` suffix is the client's own marker for one
 * that takes the member name through `format`:
 *
 *     ERR_BAD_PLAYER_NAME_S      "Cannot find player '%s'."
 *     ERR_ALREADY_IN_GROUP_S     "%s is already in a group."
 *     ERR_IGNORING_YOU_S         "%s is ignoring you."
 *     ERR_GROUP_FULL             "Your party is full."
 *     ERR_NOT_LEADER             "You are not the party leader."
 *
 * 0 is OK and prints nothing -- a successful invite is reported by the roster arriving, not by a line.
 */
const PARTY_RESULT_STRING: Record<number, string> = {
  1: 'ERR_BAD_PLAYER_NAME_S',
  2: 'ERR_TARGET_NOT_IN_GROUP_S',
  3: 'ERR_TARGET_NOT_IN_INSTANCE_S',
  4: 'ERR_GROUP_FULL',
  5: 'ERR_ALREADY_IN_GROUP_S',
  6: 'ERR_NOT_IN_GROUP',
  7: 'ERR_NOT_LEADER',
  8: 'ERR_PLAYER_WRONG_FACTION',
  9: 'ERR_IGNORING_YOU_S',
  12: 'ERR_LFG_PENDING',
  13: 'ERR_INVITE_RESTRICTED',
  14: 'ERR_GROUP_SWAP_FAILED',
  15: 'ERR_INVITE_UNKNOWN_REALM',
  16: 'ERR_INVITE_NO_PARTY_SERVER',
  17: 'ERR_INVITE_PARTY_BUSY',
  18: 'ERR_PARTY_TARGET_AMBIGUOUS',
};

/**
 * Register the group/duel/difficulty globals against a live world. Returns the teardown.
 *
 * Attached beside the other world bridges and gated on a real session for the same reason they are:
 * every answer here comes off the wire, and `/game?offline=1` has no protocol to have sent a roster.
 */
export function attachGroupBridge(vm: LuaVM, world: World): () => void {
  const group: GroupHandler = world.game.objectHandler.groupHandler;

  /** Our own guid, or null before the player exists. `IsPartyLeader` needs it. */
  const selfGuid = (): string | null => world.player?.guid ?? null;

  /**
   * Push the roster into the unit tokens, then fire the events the party frames listen for.
   *
   * `party1..party4` are the members OTHER than us, in `SMSG_GROUP_LIST` order, which is the order the
   * server itself keeps and the order `PartyMemberFrame<N>` expects (`partymemberframe.lua:83`).
   *
   * A member the world has NOT streamed in still gets a token with its NAME -- the roster is the only
   * source for a party member who is out of visual range, and `PartyMemberFrame_UpdateMember` reads
   * `UnitName` before anything else. Answering nothing there would hide a member who really is in the
   * party.
   */
  const publishRoster = (): void => {
    const members = group.members;
    for (let i = 0; i < MAX_PARTY_MEMBERS; ++i) {
      const token = `party${i + 1}`;
      const member: GroupMember | undefined = members[i];
      if (member === undefined) {
        setUnit(vm, token, null);
        continue;
      }
      const unit = world.entities.get(member.guid) ?? null;
      if (unit !== null) {
        setUnit(vm, token, snapshotOf(unit, world.player));
        continue;
      }
      // Out of range: the name and the online flag are all the roster carries, and they are enough for
      // the frame to exist. Everything else stays at `emptySnapshot`'s zeroes, which is what a unit the
      // client cannot see looks like.
      const snapshot = emptySnapshot();
      snapshot.name = member.name;
      snapshot.isPlayer = true;
      setUnit(vm, token, snapshot);
    }
    fireEvent(vm, 'PARTY_MEMBERS_CHANGED');
    fireEvent(vm, 'PARTY_LEADER_CHANGED');
  };

  // -- The feed -------------------------------------------------------------------------------------

  const onRoster = () => publishRoster();

  /**
   * `PARTY_INVITE_REQUEST` with the inviter's name.
   *
   * THE EVENT IS THE DELIVERABLE, NOT A DIALOGUE: `uiparent.lua:544-546` is the one place that shows
   * `StaticPopupDialogs["PARTY_INVITE"]`, and that dialogue's own `OnAccept`/`OnCancel`/`OnHide` call
   * `AcceptGroup`/`DeclineGroup` (`staticpopup.lua:1304-1327`). Building a dialogue here would be a
   * hand-built frame by another route, and its Accept button would be one no addon could hook. Its
   * place in Escape's order is the client's too -- `StaticPopup_EscapePressed` is the FIRST leg of
   * `ToggleGameMenu` (`uiparent.lua:2872`), ahead of the game menu, the dropdowns and the target, and
   * the dialogue declares `hideOnEscape = 1` to opt into it.
   */
  const onInvite = (inviter: string) => fireEvent(vm, 'PARTY_INVITE_REQUEST', [inviter]);

  /**
   * SELF-REVIEW FIX: `SMSG_GROUP_DECLINE` IS NOT `PARTY_INVITE_CANCEL`, and firing it here was wrong.
   *
   * The two events are opposite ends of the invitation. `PARTY_INVITE_CANCEL` means the INVITER
   * withdrew, and its only consumer hides the popup that is currently up (`uiparent.lua:548-551`) --
   * so on a decline of OUR OWN invitation it fires with no popup showing, and would hide a genuine
   * incoming invitation if one arrived in the same breath.
   *
   * What the reference client does with a decline is print `ERR_DECLINE_GROUP_S` as a system chat
   * line. There is no chat sink in this client, so this is a NAMED GAP rather than a silent no-op or
   * a wrong event: the console line is the honest placeholder, and the name is the payload the chat
   * line will want when there is somewhere to put it.
   */
  /**
   * Print one line as SYSTEM chat, through the client's own door.
   *
   * 3.3.5a has no `ChatFrame_DisplaySystemMessageInPrimary` -- checked, zero hits across the manifest --
   * so the idiom is the one `chatframe.lua:1441` and its neighbours use for their own system lines:
   * `DEFAULT_CHAT_FRAME:AddMessage(text, info.r, info.g, info.b, info.id)` with
   * `ChatTypeInfo["SYSTEM"]`. Nothing is composed here that the client would compose itself: the
   * FORMAT STRING is looked up by name in `_G` so it is the client's own localized text, and `format`
   * is the client's own.
   *
   * Guarded on the frame existing, because this can fire before the manifest has built it -- a name
   * query answering during the boot is exactly that case.
   */
  const systemLine = (globalStringName: string, argument: string | null): void => {
    // A WHITELIST, not an escape: the name is spliced into a Lua string literal below, and a
    // quote or backslash in it would end that literal early. Character names are word characters.
    const arg = (argument ?? '').replace(/[^A-Za-z0-9_ -]/g, '');
    vm.run(
      'if DEFAULT_CHAT_FRAME and _G["' + globalStringName + '"] then'
      + '  local info = ChatTypeInfo and ChatTypeInfo["SYSTEM"]'
      + '  local text = _G["' + globalStringName + '"]'
      + '  if string.find(text, "%%s") then text = format(text, "' + arg + '") end'
      + '  DEFAULT_CHAT_FRAME:AddMessage(text, info and info.r or 1, info and info.g or 1,'
      + '    info and info.b or 0, info and info.id or 1)'
      + 'end',
      'group-system-line.lua',
    );
  };

  /**
   * `SMSG_GROUP_DECLINE` -- now a real line rather than the named gap it was.
   *
   * The gap existed only because there was no chat sink; `ERR_DECLINE_GROUP_S`
   * ("%s declines your group invitation.") is in the client's own `GlobalStrings.lua` and this is what
   * the reference client prints for it.
   */
  const onDeclined = (name: string) => systemLine('ERR_DECLINE_GROUP_S', name);

  /**
   * `SMSG_PARTY_COMMAND_RESULT` -- the reason codes, printed at last.
   *
   * This is the packet whose arrival was MEASURED on a live invite (body 16, consumed 16, zero
   * residual) while its contents went nowhere. Result 0 is success and prints nothing: the roster
   * arriving is the report.
   */
  const onCommandResult = ({ member, result }: { operation: number; member: string; result: number }) => {
    if (result === 0) {
      return;
    }
    const name = PARTY_RESULT_STRING[result];
    if (name === undefined) {
      // An unmapped code. Named on the console rather than swallowed: it means the enum above is
      // missing a value this server sends, which is the thing worth learning.
      console.warn(`group: SMSG_PARTY_COMMAND_RESULT result ${result} has no GlobalString mapped`);
      return;
    }
    systemLine(name, member);
  };

  /**
   * `DUEL_REQUESTED` with the challenger's name -- but only when the challenger is not US.
   *
   * **THE CHALLENGE IS SYMMETRIC.** `SMSG_DUEL_REQUESTED` reaches challenger and challenged alike, so
   * "who asked" is decided by comparing the challenger guid with our own and never by which side got
   * the packet (`benilla/src/ui_duel.rs:13-20`, WoW.exe `0x4d49d0`). Guids EQUAL means we are the one
   * who asked: the reference shows `ERR_DUEL_REQUESTED` and IMMEDIATELY sends `CMSG_DUEL_ACCEPTED`
   * (`call 0x4d4830`) -- a no-op server-side, but it is what goes on the wire, so it goes here too.
   * Firing `DUEL_REQUESTED` on that branch would put an Accept/Decline popup in front of the player
   * for a duel he himself proposed.
   *
   * `StaticPopupDialogs["DUEL_REQUESTED"]` (`staticpopup.lua:2156-2169`) is what the event raises, and
   * its two buttons call `AcceptDuel`/`CancelDuel` below.
   */
  const onDuelRequested = ({ challenger }: { arbiter: string; challenger: string }) => {
    const me = selfGuid();
    if (me !== null && challenger === me) {
      group.acceptDuel();
      return;
    }
    const unit = world.entities.get(challenger) ?? null;
    const name = unit && unit.name !== '<unknown>' ? unit.name : null;
    if (name === null) {
      // The reference reads the name off the challenger's own object and fires NOTHING if it is
      // missing (`ui_duel.rs:38-44`, WoW.exe `0x4d4a72`). A DECLARED DEVIATION, and the same one
      // benilla declares: ask for the name rather than show a blank challenger. In practice the
      // challenger is always streamed, because the duel spell's range is 10 yd.
      if (typeof world.game?.askNameOnce === 'function') {
        world.game.askNameOnce(challenger);
      }
      return;
    }
    group.duelChallenger = name;
    fireEvent(vm, 'DUEL_REQUESTED', [name]);
  };

  const onDuelComplete = () => fireEvent(vm, 'DUEL_FINISHED');
  const onDuelOut = () => fireEvent(vm, 'DUEL_OUTOFBOUNDS');
  const onDuelIn = () => fireEvent(vm, 'DUEL_INBOUNDS');
  const onDifficulty = () => fireEvent(vm, 'PLAYER_DIFFICULTY_CHANGED');
  const onInstanceReset = () => fireEvent(vm, 'UPDATE_INSTANCE_INFO');

  /**
   * KEEP THE FOCUS SNAPSHOT LIVE while its unit changes.
   *
   * `unit-bridge.ts`'s own `onFields` pushes `player` and `target` and says in its header that `focus`
   * is not pushed "because there is no focus in this client" -- true when it was written, false now. It
   * is done here rather than there because this bridge is the one that owns the focus and knows which
   * entity it is; adding a third arm over there would need it to import that knowledge back.
   *
   * Gated on identity, so a field change on any other unit costs one reference comparison. The events
   * fired are the diff, not the whole set: `TargetFrame_OnEvent` re-reads on each, so firing all of
   * them on every packet would run the frame's handler several times for one change.
   */
  const onFocusFields = (unit: Unit): void => {
    if (world.focus === null || unit !== world.focus) {
      return;
    }
    const before = getUnit(vm, 'focus');
    const after = snapshotOf(unit, world.player);
    setUnit(vm, 'focus', after);
    if (before === null) {
      return;
    }
    if (after.health !== before.health) fireEvent(vm, 'UNIT_HEALTH', ['focus']);
    if (after.maxHealth !== before.maxHealth) fireEvent(vm, 'UNIT_MAXHEALTH', ['focus']);
    if (after.power !== before.power) fireEvent(vm, 'UNIT_MANA', ['focus']);
    if (after.level !== before.level) fireEvent(vm, 'UNIT_LEVEL', ['focus']);
    if (after.reaction !== before.reaction) fireEvent(vm, 'UNIT_FACTION', ['focus']);
  };
  world.on('unit:fields', onFocusFields);

  group.on('rosterChanged', onRoster);
  group.on('inviteRequest', onInvite);
  group.on('inviteDeclined', onDeclined);
  group.on('commandResult', onCommandResult);
  group.on('duelRequested', onDuelRequested);
  group.on('duelComplete', onDuelComplete);
  group.on('duelOutOfBounds', onDuelOut);
  group.on('duelInBounds', onDuelIn);
  group.on('difficultyChanged', onDifficulty);
  group.on('instanceReset', onInstanceReset);

  // -- The globals ----------------------------------------------------------------------------------

  const fn = (name: string, body: (args: unknown[]) => unknown[]): void => {
    vm.registerFunction(name, body);
  };

  /**
   * A unit TOKEN or a NAME, resolved to a name.
   *
   * Every action global in `UnitPopup_OnClick` is called with one or the other and the file mixes them
   * deliberately: `InviteUnit(fullname)` passes a NAME (:1214) while `PromoteToLeader(unit, 1)` passes
   * a TOKEN (:1247). A helper that only understood one would silently no-op half the menu.
   */
  const nameFrom = (arg: unknown): string | null => {
    if (typeof arg !== 'string' || arg === '') {
      return null;
    }
    const snapshot = getUnit(vm, arg);
    if (snapshot !== null) {
      return snapshot.name;
    }
    // Not a token, so it is already a name. `Name-Realm` passes through untouched: the server parses
    // it, and this client reads one realm so the suffix never appears in practice.
    return arg;
  };

  /** The roster row for a name, or null. Case-insensitive -- both sides come off the wire. */
  const memberByName = (name: string): GroupMember | null =>
    group.members.find((m) => m.name.toLowerCase() === name.toLowerCase()) ?? null;

  const isRaid = (): boolean => (group.groupType & GROUP_TYPE_RAID) !== 0;

  // --- The roster ---------------------------------------------------------------------------------
  //
  // These OVERRIDE the `notImplemented` declarations `api/units.ts` made for them. That is deliberate
  // and it is why they are here rather than there: `api/units.ts` holds no network and is installed
  // before a session exists, so it could only ever declare them. Re-registering a global replaces it
  // (`vm.ts#registerFunction` ends in `lua_setglobal`), and this bridge attaches after the manifest has
  // loaded -- which is safe because a menu is built when it OPENS, not when the document loads.
  //
  // **`GetNumPartyMembers()` IS 0 IN A RAID AND `GetNumRaidMembers()` IS 0 IN A PARTY.** That is the
  // engine's own split and `unitpopup.lua:458-465` depends on it: it computes `inParty` from
  // `(party > 0) or (raid > 0)` and `inRaid` from the raid count ALONE, so a party that also reported a
  // raid count would take every raid-only branch in the menu.
  fn('GetNumPartyMembers', () => [isRaid() ? 0 : group.members.length]);
  fn('GetNumRaidMembers', () => [isRaid() ? group.members.length + 1 : 0]);

  /**
   * `IsPartyLeader()` -- no argument, and it means "am *I* the leader".
   *
   * FALSE when solo, which is the engine's answer too: `leaderGuid` is null with no group, and a solo
   * player leads nothing. `unitpopup.lua:1178-1181` folds it into `isLeader`, which gates LOOT_METHOD,
   * UNINVITE and RESET_INSTANCES.
   */
  fn('IsPartyLeader', () => {
    const me = selfGuid();
    return [me !== null && group.leaderGuid !== null && group.leaderGuid === me];
  });

  /** `IsRaidOfficer()` -- our own `MEMBER_FLAG_ASSISTANT`. Only meaningful in a raid. */
  fn('IsRaidOfficer', () => {
    const me = selfGuid();
    const row = me === null ? undefined : group.members.find((m) => m.guid === me);
    return [row !== undefined && (row.flags & MEMBER_FLAG_ASSISTANT) !== 0];
  });

  /**
   * `UnitInParty(unit)` and `UnitInRaid(unit)`.
   *
   * `UnitInParty` is a BOOLEAN; `UnitInRaid` is an INDEX OR NIL -- not the same shape, and the
   * difference is load-bearing. `unitpopup.lua:503` tests `UnitInRaid(name) ~= nil`, so returning
   * `false` there would read as "in the raid", because `false ~= nil` is TRUE in Lua. That is the
   * 0-is-truthy trap in its other clothes, and it is why the index is 1-based.
   */
  fn('UnitInParty', (args) => {
    const name = nameFrom(args[0]);
    return [name !== null && memberByName(name) !== null];
  });
  fn('UnitInRaid', (args) => {
    if (!isRaid()) {
      return [null];
    }
    const name = nameFrom(args[0]);
    if (name === null) {
      return [null];
    }
    const index = group.members.findIndex((m) => m.name.toLowerCase() === name.toLowerCase());
    return [index === -1 ? null : index + 1];
  });

  /** `UnitIsPartyLeader(unit)` -- the twin of `IsPartyLeader`, asked about somebody else. */
  fn('UnitIsPartyLeader', (args) => {
    const name = nameFrom(args[0]);
    if (name === null || group.leaderGuid === null) {
      return [false];
    }
    const row = memberByName(name);
    if (row !== null) {
      return [row.guid === group.leaderGuid];
    }
    // Not in the roster, so the only member it can be is us.
    const me = selfGuid();
    const mine = getUnit(vm, 'player');
    return [me !== null && group.leaderGuid === me && mine !== null && mine.name === name];
  });

  /**
   * `GetPartyMember(index)` -- 1-based, and NIL for an empty slot, not false and not 0.
   *
   * `0` IS TRUTHY IN LUA and this project has paid for that three times; the last one made every skill
   * row read "Learn <skill>". A slot that does not exist has to answer nil.
   */
  fn('GetPartyMember', (args) => {
    const index = typeof args[0] === 'number' ? args[0] : 0;
    return [index >= 1 && index <= group.members.length ? 1 : null];
  });

  fn('UnitPlayerOrPetInParty', (args) => {
    const name = nameFrom(args[0]);
    return [name !== null && memberByName(name) !== null];
  });

  /**
   * `UnitCanCooperate(a, b)` -- "can these two group, trade and duel".
   *
   * **THIS IS THE GLOBAL THAT DECIDES WHETHER "INVITE TO GROUP" APPEARS AT ALL**
   * (`unitpopup.lua:483-499`, through `canCoop`), and it also gates TRADE. It was a declared gap
   * answering FALSE, so the entry was hidden on every player in the world.
   *
   * The engine's test is same-faction-and-not-hostile. This derives it from the reaction the client
   * already resolves through `FactionTemplate.dbc` (`world/faction.ts`): FRIENDLY or better, and both
   * units player-controlled. A DECLARED SIMPLIFICATION, stated rather than hidden -- the engine also
   * refuses across a PvP-flag mismatch and for a unit already in a duel, neither of which this client
   * tracks. Both would only ever REMOVE an entry whose action the server would refuse anyway.
   */
  fn('UnitCanCooperate', (args) => {
    const first = typeof args[0] === 'string' ? getUnit(vm, args[0]) : null;
    const second = typeof args[1] === 'string' ? getUnit(vm, args[1]) : null;
    if (first === null || second === null || !first.isPlayer || !second.isPlayer) {
      return [false];
    }
    return [second.reaction >= REACTION_FRIENDLY];
  });

  // --- Invitation ---------------------------------------------------------------------------------

  /** `InviteUnit(name)` -- `unitpopup.lua:1213-1214`. A NAME, always; the server resolves it. */
  fn('InviteUnit', (args) => {
    const name = nameFrom(args[0]);
    if (name !== null) {
      group.invite(name);
    }
    return [];
  });

  /** `UninviteUnit(name)` -- UNINVITE and VOTE_TO_KICK both (`unitpopup.lua:1215-1216`). */
  fn('UninviteUnit', (args) => {
    const name = nameFrom(args[0]);
    if (name !== null) {
      group.uninvite(name);
    }
    return [];
  });

  /** `AcceptGroup()` / `DeclineGroup()` -- `StaticPopupDialogs["PARTY_INVITE"]`'s two buttons. */
  fn('AcceptGroup', () => {
    group.acceptInvite();
    return [];
  });
  fn('DeclineGroup', () => {
    group.declineInvite();
    return [];
  });

  /**
   * `LeaveParty()` -- the SELF menu's LEAVE (`unitpopup.lua:1271-1272`).
   *
   * There is no leave opcode in 3.3.5a; this is `CMSG_GROUP_DISBAND` with an empty body. See
   * `object/group.ts#leave` for why that is not a mistake.
   */
  fn('LeaveParty', () => {
    group.leave();
    return [];
  });

  /**
   * `PromoteToLeader(unit)` -- PROMOTE / PROMOTE_GUIDE / RAID_LEADER.
   *
   * `CMSG_GROUP_SET_LEADER` carries a GUID, not a name, so it can only be sent for somebody the roster
   * knows. A name with no roster row is dropped rather than guessed at.
   */
  fn('PromoteToLeader', (args) => {
    const name = nameFrom(args[0]);
    const row = name === null ? null : memberByName(name);
    if (row !== null) {
      group.setLeader(row.guid);
    }
    return [];
  });

  // --- Duels --------------------------------------------------------------------------------------

  /**
   * `StartDuel(unit)` -- `unitpopup.lua:1211-1212`.
   *
   * A DUEL IS NOT AN OPCODE: it is a CAST of the duel spell at the target (`ui_duel.rs:56-63`, WoW.exe
   * `0x4d4810`), and the server's `SPELL_EFFECT_DUEL` handler drops the duel-flag object and sends
   * `SMSG_DUEL_REQUESTED` to both players. So this looks the spell up in the player's OWN book by its
   * effect id and casts it through the same `castSpell` every action button uses -- which means the
   * cast-failure path, the range check and the GCD are all the ones already in place.
   *
   * Not knowing the spell is a real state rather than an error: it is granted at creation to every race
   * and class, so an empty result means `SMSG_INITIAL_SPELLS` or `Spell.dbc` has not landed yet. Said
   * on the console rather than silently, because a duel that does nothing is exactly the failure this
   * file exists to avoid.
   */
  fn('StartDuel', (args) => {
    // SELF-REVIEW FIX: this ignored its argument and always duelled the CURRENT TARGET. The menu
    // reaches it as `StartDuel(unit, 1)` where `unit` is the dropdown's token, which is `"target"` from
    // the target frame but `"party1".."party4"` from a party member frame -- so duelling a party member
    // challenged whoever happened to be selected instead. The token is resolved to a NAME and the name
    // to a live entity, which is the same two-step `TargetUnit` takes.
    const token = typeof args[0] === 'string' && args[0] !== '' ? args[0] : 'target';
    const wanted = getUnit(vm, token)?.name ?? null;
    let targetGuid: string | null = null;
    if (wanted !== null) {
      for (const candidate of world.entities.values()) {
        if (candidate.name === wanted) {
          targetGuid = candidate.guid;
          break;
        }
      }
    }
    // The token had no snapshot, or the named unit is not streamed. Falling back to the selection is
    // right for `"target"` (the snapshot and the selection are the same unit by construction) and is
    // the honest nothing for a party member out of range -- the duel spell's range is 10 yd, so the
    // server would refuse it anyway.
    if (targetGuid === null && token === 'target') {
      targetGuid = world.target?.guid ?? null;
    }
    if (targetGuid === null) {
      return [];
    }
    const spells = world.game.objectHandler.spellHandler;
    let duelSpell: number | null = null;
    for (const id of spells.knownSpells()) {
      const row = spellData.spell(id);
      if (row && row.effect[0] === SPELL_EFFECT_DUEL) {
        duelSpell = id;
        break;
      }
    }
    if (duelSpell === null) {
      console.warn('StartDuel: no learned spell carries SPELL_EFFECT_DUEL (83) -- Spell.dbc or '
        + 'SMSG_INITIAL_SPELLS has not landed');
      return [];
    }
    castWithRefusal(vm, spells, duelSpell, targetGuid);
    return [];
  });

  /** `AcceptDuel()` / `CancelDuel()` -- `StaticPopupDialogs["DUEL_REQUESTED"]`'s two buttons. */
  fn('AcceptDuel', () => {
    group.acceptDuel();
    return [];
  });
  fn('CancelDuel', () => {
    group.cancelDuel();
    return [];
  });

  // --- Dungeon difficulty and instance reset ------------------------------------------------------
  //
  // These override `api/units.ts`' declarations for the same reason the roster globals do. THE GETTERS
  // MUST STAY NUMBERS: `unitpopup.lua:700,704` compares them `== 1`, and `:1310-1315` derives the new
  // value from the menu entry's own name with `tonumber(strsub(button, 19, 19))`.
  fn('GetDungeonDifficulty', () => [group.dungeonDifficulty]);
  fn('GetRaidDifficulty', () => [group.raidDifficulty]);
  /**
   * `SetDungeonDifficulty(n)` -- and **THERE IS NO OFF-BY-ONE HERE, WHICH WAS MEASURED AFTER I NEARLY
   * "FIXED" ONE THAT DID NOT EXIST.**
   *
   * The symptom on a live login as `Gesf` (level 4): the value never changes and the server never
   * echoes. The obvious hypothesis was that the Lua API is 1-based (1 Normal / 2 Heroic) while the wire
   * is 0-based, so `SetDungeonDifficulty(2)` would trip TrinityCore's
   * `if (mode >= MAX_DUNGEON_DIFFICULTY) return`.
   *
   * THE BYTES REFUTE IT. Raw words captured in both directions:
   *
   *   incoming, at login:  MSG_SET_DUNGEON_DIFFICULTY  body 12  words [1, 1, 0]
   *                        SMSG_INSTANCE_DIFFICULTY    body  8  words [0, 0]
   *   outgoing:            MSG_SET_DUNGEON_DIFFICULTY  body  4  words [2] then [0] then [1]
   *   echo, in all three cases:  NONE. GetDungeonDifficulty() stayed 1 throughout.
   *
   * The server's OWN first word is **1**, so the wire agrees with the Lua API and this send is right.
   * And 0 and 1 got no echo either -- an off-by-one would have made one of them work.
   *
   * What is actually happening is a SILENT REFUSAL, and all three cases fit it:
   * `HandleSetDungeonDifficultyOpcode` returns without sending anything when the mode is out of range
   * (2), when it equals the current difficulty (1), and **when the player is below
   * `LEVELREQUIREMENT_HEROIC`** (0, and 2 as well) -- `Gesf` is level 4. That is the same rule the
   * client's own menu already applies at the other end: `unitpopup.lua:699-706` hides both difficulty
   * submenus while `UnitLevel("player") < 65`. So the feature is coherent on both sides and there is
   * nothing to fix; a low-level character cannot change dungeon difficulty and is not offered the row.
   *
   * ABSENCE OF A REPLY IS NOT FAILURE in this protocol family -- the same shape the quest area found,
   * where accept and abandon carry no acknowledgement at all.
   */
  fn('SetDungeonDifficulty', (args) => {
    group.setDungeonDifficulty(typeof args[0] === 'number' ? args[0] : 1);
    return [];
  });
  fn('SetRaidDifficulty', (args) => {
    group.setRaidDifficulty(typeof args[0] === 'number' ? args[0] : 1);
    return [];
  });

  /**
   * `ResetInstances()` -- `StaticPopupDialogs["CONFIRM_RESET_INSTANCES"]`'s OnAccept
   * (`staticpopup.lua:413-424`), which the RESET_INSTANCES entry RAISES rather than acting directly
   * (`unitpopup.lua:1322-1323`). The confirmation is the client's own and is not built here.
   */
  fn('ResetInstances', () => {
    group.resetInstances();
    return [];
  });

  // --- The group loot settings --------------------------------------------------------------------

  /**
   * `GetLootMethod()` -> `method, masterLooterPartyId, masterLooterRaidId`.
   *
   * THE STRING MUST BE ONE OF FIVE EXACT KEYS: `UnitPopup_ShowMenu` does
   * `UnitLootMethod[GetLootMethod()].text` (`unitpopup.lua:221`), so anything else is a nil-index error
   * that takes out the whole menu before it draws a row. `LOOT_METHOD_NAMES` is that list, in the
   * wire's own order.
   *
   * The second return is compared to a NUMBER (`lootMaster == 0`, `unitpopup.lua:683-686`), so it is a
   * number or nil and never false -- and **0 means US**, which is what that comparison is testing for.
   */
  fn('GetLootMethod', () => {
    const name = LOOT_METHOD_NAMES[group.lootMethod] ?? 'freeforall';
    if (group.looterGuid === null || group.looterGuid === '0x0') {
      return [name, null, null];
    }
    const me = selfGuid();
    if (me !== null && group.looterGuid === me) {
      return [name, 0, null];
    }
    const index = group.members.findIndex((m) => m.guid === group.looterGuid);
    return [name, index === -1 ? null : index + 1, null];
  });

  fn('GetLootThreshold', () => [group.lootThreshold]);

  /**
   * `SetLootMethod(method [, masterName] [, threshold])` -- `unitpopup.lua:1283-1305`, and LOOT_PROMOTE
   * calls it as `SetLootMethod("master", fullname, 1)`.
   *
   * ONE PACKET CARRIES BOTH the method and the threshold (`CMSG_LOOT_METHOD`), so the value NOT being
   * changed is taken from our own mirror rather than zeroed. Sending 0 there would silently reset the
   * party's loot threshold to Poor every time anybody changed the method.
   */
  fn('SetLootMethod', (args) => {
    const method = typeof args[0] === 'string'
      ? (LOOT_METHOD_NAMES as readonly string[]).indexOf(args[0])
      : -1;
    if (method < 0) {
      return [];
    }
    const masterName = typeof args[1] === 'string' ? args[1] : null;
    const master = masterName === null ? null : (memberByName(masterName)?.guid ?? selfGuid());
    group.setLootMethod(method, master, group.lootThreshold);
    return [];
  });

  fn('SetLootThreshold', (args) => {
    const threshold = typeof args[0] === 'number' ? args[0] : group.lootThreshold;
    group.setLootMethod(group.lootMethod, group.looterGuid, threshold);
    return [];
  });

  /**
   * `GetOptOutOfLoot()` / `SetOptOutOfLoot(v)`.
   *
   * The setter's argument is `1` OR `nil` (`unitpopup.lua:1306-1311`), so the test is LUA TRUTHINESS
   * and not `=== true`: `SetOptOutOfLoot(0)` would be true in Lua. Held locally as well as sent,
   * because the server does not echo it and `UnitPopup_ShowMenu` reads it back on the next open to
   * label the submenu title (`unitpopup.lua:238-242`).
   */
  let optOutOfLoot = false;
  fn('GetOptOutOfLoot', () => [optOutOfLoot]);
  fn('SetOptOutOfLoot', (args) => {
    optOutOfLoot = args[0] !== undefined && args[0] !== null && args[0] !== false;
    group.setOptOutOfLoot(optOutOfLoot);
    return [];
  });

  // --- Selection and focus ------------------------------------------------------------------------

  /**
   * `TargetUnit(name [, exactMatch])` -- the TARGET entry (`unitpopup.lua:1199`), and also
   * `SECURE_ACTIONS.target`, which is what a LEFT click on any unit portrait already routes through
   * (`SecureTemplates.lua:402-415`). So this closes the left click as well as the menu row.
   *
   * `world.setTarget` is the ONE door to the wire, so a menu row and a click commit identically -- the
   * same rule `target-bridge.ts` states for TAB.
   */
  fn('TargetUnit', (args) => {
    const arg = args[0];
    if (typeof arg !== 'string' || arg === '') {
      return [];
    }
    // A token first: `SECURE_ACTIONS.target` passes `"target"`/`"player"`/`"party1"`.
    const wanted = getUnit(vm, arg)?.name ?? arg;
    if (world.player && world.player.name === wanted) {
      world.setTarget(world.player);
      return [];
    }
    for (const unit of world.entities.values()) {
      if (unit.name === wanted) {
        world.setTarget(unit);
        return [];
      }
    }
    return [];
  });

  /**
   * `FocusUnit(unit)` / `ClearFocus()` -- SET_FOCUS and CLEAR_FOCUS, the FIRST entry of most menus in
   * the file (12 of the 25 open with one of them, `unitpopup.lua:138-155`).
   *
   * The focus is a pure CLIENT concept -- no packet at all -- so it is a token like any other: writing
   * the snapshot IS the implementation, and `FocusFrame` (`targetframe.xml`) draws itself off
   * `UnitExists("focus")` exactly as `TargetFrame` does off `"target"`.
   */
  /**
   * `FocusUnit(unit)` / `ClearFocus()` -- SET_FOCUS and CLEAR_FOCUS, the FIRST entry of most menus in
   * the file (12 of the 25 open with one of them, `unitpopup.lua:138-155`).
   *
   * THE FOCUS IS TWO THINGS AND BOTH ARE WRITTEN HERE, because this is the only site that knows both.
   *
   *  1. THE SNAPSHOT, for `UnitExists("focus")` and every `Unit*` the frame reads. No packet is
   *     involved -- the focus is a pure client concept -- so writing the snapshot IS the implementation,
   *     and `FocusFrame` (`targetframe.xml:658`) shows itself off `UnitExists("focus")` exactly as
   *     `TargetFrame` does off `"target"`.
   *  2. THE ENTITY, on `World#focus`, for the PORTRAIT. `world/unit-tokens.ts` resolves a token to a
   *     body so the booth can bake a face, and it cannot resolve this one on its own: `focus` is set
   *     from ANOTHER TOKEN's snapshot, and a snapshot deliberately carries no guid
   *     (`framexml/lua/api/units.ts:11`). So the entity is known only here, at the moment of the click.
   *     Without this the `FocusFrame` portrait resolved to nothing and drew nothing.
   *
   * **THE ENTITY IS THE LIVE ONE AND THE SNAPSHOT NOW FOLLOWS IT. That is the client's own behaviour,
   * not a choice of ours**, and it retires the frozen-snapshot limitation an earlier self-review of
   * mine declared: `FocusFrame` inherits `TargetFrameTemplate`, whose `OnLoad` registers `UNIT_HEALTH`,
   * `UNIT_LEVEL`, `UNIT_FACTION`, `UNIT_AURA` and `UNIT_CLASSIFICATION_CHANGED`
   * (`targetframe.lua:63-78`), with three more added on `FocusFrame` itself (`:1045-1047`). A frame
   * that registers those and never receives them is a frame whose bars lie, so `onFocusFields` below
   * re-pushes the snapshot while the focused unit lives.
   */
  fn('FocusUnit', (args) => {
    const token = typeof args[0] === 'string' ? args[0] : null;
    // The SNAPSHOT is copied from the source token rather than re-derived, so `focus` says exactly what
    // the frame the player clicked said at that instant.
    setUnit(vm, 'focus', token === null ? null : getUnit(vm, token));
    // The ENTITY, through the one resolver, which lowercases for us -- `SET_FOCUS` passes whatever the
    // dropdown's `unit` field holds (`"player"`, `"target"`, a party token) and case is not ours to
    // police.
    world.focus = token === null ? null : resolveUnitToken(token, world);
    fireEvent(vm, 'PLAYER_FOCUS_CHANGED');
    return [];
  });
  fn('ClearFocus', () => {
    setUnit(vm, 'focus', null);
    world.focus = null;
    fireEvent(vm, 'PLAYER_FOCUS_CHANGED');
    return [];
  });

  // --- The two predicates every enable/disable pass reads -----------------------------------------

  /**
   * `InCombatLockdown()` -- true while protected frames may not be re-parented or shown.
   *
   * FALSE always, and that is a DECLARED SIMPLIFICATION rather than a gap: this client has no
   * restricted-frame system at all (`api/secure.ts`'s header says so), so there is no lockdown to be
   * in. Real rather than `notImplemented` because it is read as a plain condition on paths a menu open
   * takes, and a warning on every open would be noise for a question with one correct answer here.
   */
  fn('InCombatLockdown', () => [false]);

  /**
   * `HasFullControl()` -- false while feared, charmed, confused or stunned. It gates DUEL's ENABLED
   * state (`unitpopup.lua:1091-1094`).
   *
   * TRUE always, same reasoning: loss of control comes from `UNIT_FIELD_FLAGS`, which this client does
   * not read, and the honest neutral answer is the one that does not grey out a row the player can
   * actually use. Stated here rather than left as a silent gap.
   */
  fn('HasFullControl', () => [true]);

  // --- The declared gaps -------------------------------------------------------------------------
  //
  // Each is a system this client does not have. They are named so the load report says WHICH, per the
  // rule that a gap is declared and never silently answered. THE RETURN VALUES ARE NOT ARBITRARY:
  // where `UnitPopup.lua` feeds a result into a comparison or a table index rather than a truthiness
  // test, the value is what a client with that system switched off answers.
  /**
   * A gap the player REACHED BY CLICKING A MENU ENTRY, made visible on screen.
   *
   * THE OWNER'S REPORT IS WHY THIS EXISTS: "все остальные опции не работают". Every one of those rows
   * dispatches correctly -- measured per row, `UnitPopup_OnClick` runs and calls its global for all of
   * them -- and most of them then reach one of the declared gaps below. For a GETTER that is right and
   * silent. For an ACTION the player deliberately chose, a silent return is indistinguishable from a
   * bug, and `CLAUDE.md`'s rule is that a gap must never read as one.
   *
   * So an action gap ALSO prints a line in `UIErrorsFrame` -- the client's own red refusal frame, its
   * own `AddMessage` method, exactly the door `quest-bridge.ts:637-644` already uses for
   * `ERR_QUEST_MUST_CHOOSE_ITEM`. No new channel is invented and no GlobalString is faked: the text
   * says plainly that this client does not have the feature, because there IS no 3.3.5a string for
   * "your client was not finished".
   *
   * GETTERS DELIBERATELY DO NOT DO THIS. `UnitPopup_HideButtons` calls them on every menu open, so a
   * message there would paint the screen red once per right-click.
   */
  const gapAction = (name: string, feature: string, reason: string): void => {
    const stub = notImplemented(name, reason, []);
    fn(name, () => {
      stub(null as never, 0, []);
      // Escaped as a Lua string literal: `feature` is ours, never user input, but a stray quote here
      // would be a syntax error inside the client rather than a bad message.
      const text = `${feature} is not implemented in this client yet.`.replace(/"/g, '');
      vm.run(
        `if UIErrorsFrame then UIErrorsFrame:AddMessage("${text}", 1.0, 0.1, 0.1, 1.0) end`,
        'group-gap-notice.lua',
      );
      return [];
    });
  };

  /**
   * The ACTION gaps, each with the words the player sees. Every one of these is reachable from a row
   * the owner can click, and every one was silent before.
   */
  const actionGaps: [string, string, string][] = [
    ['SetPVP', 'Toggling the PvP flag', 'PLAYER_FLAGS is not read, so a write would have no reader to confirm it'],
    ['SetRaidTarget', 'Raid target marks', 'no raid target icon is drawn on any frame or nameplate yet, and the server refuses the update outside a group'],
    ['InitiateTrade', 'Trading', 'no trade window or SMSG_TRADE_STATUS decoder exists yet'],
    ['InspectAchievements', 'Comparing achievements', 'no achievement system exists in this client'],
    ['FollowUnit', 'Follow', 'no client-side follow state exists yet'],
    ['ReportPlayerIsPVPAFK', 'Reporting AFK', 'no battleground state is read from the wire'],
    ['SummonFriend', 'Summoning a friend', 'no refer-a-friend state is read from the wire'],
    ['GrantLevel', 'Granting a level', 'no refer-a-friend state is read from the wire'],
    ['PromoteToAssistant', 'Promoting to assistant', 'no raid roster capture exists to pin CMSG_GROUP_ASSISTANT_LEADER against'],
    ['DemoteAssistant', 'Demoting an assistant', 'no raid roster capture exists to pin CMSG_GROUP_ASSISTANT_LEADER against'],
    ['SetPartyAssignment', 'Main tank and main assist', 'no raid main-tank/assist state is read from the wire'],
    ['ClearPartyAssignment', 'Main tank and main assist', 'no raid main-tank/assist state is read from the wire'],
    ['RemoveFriend', 'The friends list', 'no contact list is read from the wire'],
    ['AddOrDelIgnore', 'The ignore list', 'no contact list is read from the wire'],
    ['PetDismiss', 'Pets', 'no pet unit is tracked'],
    ['VehicleExit', 'Vehicles', 'this client has no vehicles'],
    ['AddMute', 'Voice chat', 'this client has no voice transport'],
    ['DelMute', 'Voice chat', 'this client has no voice transport'],
    ['ChannelSilenceVoice', 'Voice chat', 'this client has no voice transport'],
    ['ChannelUnSilenceVoice', 'Voice chat', 'this client has no voice transport'],
    ['ChannelModerator', 'Chat channel moderation', 'this client has no chat channels'],
    ['ChannelUnmoderator', 'Chat channel moderation', 'this client has no chat channels'],
    ['ChannelKick', 'Chat channel moderation', 'this client has no chat channels'],
    ['ChannelBan', 'Chat channel moderation', 'this client has no chat channels'],
    ['SetChannelOwner', 'Chat channel moderation', 'this client has no chat channels'],
    ['BNSetToonBlocked', 'Battle.net', 'there is no Battle.net on this realm'],
  ];
  const actionGapNames = new Set(actionGaps.map(([name]) => name));
  for (const [name, feature, reason] of actionGaps) {
    gapAction(name, feature, reason);
  }

  const gaps: [string, string, unknown[]][] = [
    // VOICE CHAT (16). `voicechat.lua` is in the manifest but there is no voice transport, and
    // `IsVoiceChatEnabled` FALSE is what hides all sixteen of its menu rows in one go
    // (`unitpopup.lua:707-712` and the seven arms after it) -- the correct shape, not a workaround.
    ['IsVoiceChatEnabled', 'this client has no voice transport', [false]],
    ['GetVoiceStatus', 'this client has no voice transport', [false]],
    ['UnitIsSilenced', 'this client has no voice transport', [false]],
    ['IsMuted', 'this client has no voice transport', [false]],
    ['IsSilenced', 'this client has no voice transport', [false]],
    ['AddMute', 'this client has no voice transport', []],
    ['DelMute', 'this client has no voice transport', []],
    ['ChannelSilenceVoice', 'this client has no voice transport', []],
    ['ChannelUnSilenceVoice', 'this client has no voice transport', []],
    ['ChannelModerator', 'this client has no chat channels', []],
    ['ChannelUnmoderator', 'this client has no chat channels', []],
    ['ChannelKick', 'this client has no chat channels', []],
    ['ChannelBan', 'this client has no chat channels', []],
    ['SetChannelOwner', 'this client has no chat channels', []],
    ['IsDisplayChannelOwner', 'this client has no chat channels', [false]],
    ['IsDisplayChannelModerator', 'this client has no chat channels', [false]],
    // BATTLE.NET (4). There is none on a private realm, and `BNFeaturesEnabledAndConnected` false is
    // the one answer that makes the whole BN_FRIEND menu unreachable rather than half-built.
    ['BNFeaturesEnabledAndConnected', 'there is no Battle.net on this realm', [false]],
    ['BNGetFriendInfoByID', 'there is no Battle.net on this realm', []],
    ['BNSetToonBlocked', 'there is no Battle.net on this realm', []],
    ['CanCooperateWithToon', 'there is no Battle.net on this realm', [false]],
    // ARENA TEAMS (2). No `SMSG_ARENA_TEAM_*` is decoded; `GetArenaTeam` returning nothing makes the
    // TEAM menu's three confirmations unreachable rather than wrong.
    ['GetArenaTeam', 'no arena team state is read from the wire', []],
    ['IsArenaTeamCaptain', 'no arena team state is read from the wire', [false]],
    // REFER-A-FRIEND (4). `IsReferAFriendLinked` false hides RAF_SUMMON and RAF_GRANT_LEVEL, which are
    // the last two rows of BOTH the PLAYER and PARTY menus (`unitpopup.lua:140-141`).
    ['IsReferAFriendLinked', 'no refer-a-friend state is read from the wire', [false]],
    ['SummonFriend', 'no refer-a-friend state is read from the wire', []],
    ['CanGrantLevel', 'no refer-a-friend state is read from the wire', [false]],
    ['GrantLevel', 'no refer-a-friend state is read from the wire', []],
    // PETS (4) and VEHICLES (2). No pet unit is tracked and there are no vehicles, so the PET and
    // VEHICLE menus cannot be built from anything.
    ['PetCanBeAbandoned', 'no pet unit is tracked', [false]],
    ['PetCanBeRenamed', 'no pet unit is tracked', [false]],
    ['PetCanBeDismissed', 'no pet unit is tracked', [false]],
    ['PetDismiss', 'no pet unit is tracked', []],
    ['CanExitVehicle', 'this client has no vehicles', [false]],
    ['VehicleExit', 'this client has no vehicles', []],
    // THE FRIENDS AND IGNORE LISTS (3). `SMSG_CONTACT_LIST` (0x067) is not decoded.
    ['RemoveFriend', 'no contact list is read from the wire', []],
    ['AddOrDelIgnore', 'no contact list is read from the wire', []],
    ['CanComplainChat', 'no chat report system exists in this client', [false]],
    // TRADE, INSPECT, FOLLOW, ACHIEVEMENTS. Each is a whole subsystem behind one menu row.
    ['InitiateTrade', 'no trade window or SMSG_TRADE_STATUS decoder exists yet', []],
    ['InspectAchievements', 'no achievement system exists in this client', []],
    ['FollowUnit', 'no client-side follow state exists yet', []],
    // THE PVP FLAG AND THE AFK REPORT (4). `GetPVPDesired` reads `PLAYER_FLAGS`, which is not decoded;
    // `SetPVP` would be `CMSG_TOGGLE_PVP`, but a setter with no reader leaves the submenu's two check
    // marks permanently lying about the state, which is worse than an honest gap.
    ['SetPVP', 'PLAYER_FLAGS is not read, so a write would have no reader to confirm it', []],
    ['GetPVPDesired', 'PLAYER_FLAGS is not read from the wire', [false]],
    ['ReportPlayerIsPVPAFK', 'no battleground state is read from the wire', []],
    ['PlayerIsPVPInactive', 'no battleground state is read from the wire', [false]],
    // RAID OFFICER MANAGEMENT AND THE MAIN TANK/ASSIST ASSIGNMENTS (6). The opcodes exist
    // (`CMSG_GROUP_ASSISTANT_LEADER` 0x28F) but there is no raid to exercise them in and no raid
    // `SMSG_GROUP_LIST` capture to pin the flag semantics against, so they are declared rather than
    // written blind. Every one of them is behind an entry `inRaid == 0` already hides.
    ['PromoteToAssistant', 'no raid roster capture exists to pin CMSG_GROUP_ASSISTANT_LEADER against', []],
    ['DemoteAssistant', 'no raid roster capture exists to pin CMSG_GROUP_ASSISTANT_LEADER against', []],
    ['SetPartyAssignment', 'no raid main-tank/assist state is read from the wire', []],
    ['ClearPartyAssignment', 'no raid main-tank/assist state is read from the wire', []],
    ['GetPartyAssignment', 'no raid main-tank/assist state is read from the wire', [false]],
    ['GetRaidRosterInfo', 'no raid roster is fed', []],
    // THE RAID TARGET MARKS. `SetRaidTargetIcon` is FrameXML's own (`targetframe.lua:703`) and calls
    // this; nothing in this client draws a mark on a nameplate or a unit frame yet, so a working
    // setter would put a mark on the wire that the player could never see.
    ['SetRaidTarget', 'no raid target icon is drawn on any frame or nameplate yet', []],
  ];
  for (const [name, reason, results] of gaps) {
    // The action gaps are already registered above, with a VISIBLE notice. Registering them again here
    // would silently replace that with the quiet version -- `registerFunction` ends in `lua_setglobal`,
    // so last writer wins.
    if (actionGapNames.has(name)) {
      continue;
    }
    const stub = notImplemented(name, reason, results);
    // `notImplemented` builds a FRAME METHOD (ctx, self, args); a global takes only args. The same
    // adaptation `api/units.ts` makes and for the same reason -- what is reused is the NAME
    // REGISTRATION, which is the part the load report reads.
    fn(name, () => stub(null as never, 0, []));
  }

  // The roster may already be non-empty when this attaches -- a reconnect, or a login straight into a
  // group -- so publish once rather than waiting for the next `SMSG_GROUP_LIST`.
  if (group.members.length > 0) {
    publishRoster();
  }

  return () => {
    world.removeListener('unit:fields', onFocusFields);
    // The focus does not outlive the bridge that owns it.
    world.focus = null;
    group.off('rosterChanged', onRoster);
    group.off('inviteRequest', onInvite);
    group.off('inviteDeclined', onDeclined);
    group.off('commandResult', onCommandResult);
    group.off('duelRequested', onDuelRequested);
    group.off('duelComplete', onDuelComplete);
    group.off('duelOutOfBounds', onDuelOut);
    group.off('duelInBounds', onDuelIn);
    group.off('difficultyChanged', onDifficulty);
    group.off('instanceReset', onInstanceReset);
  };
}

export default attachGroupBridge;
