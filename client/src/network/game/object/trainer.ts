/**
 * THE CLASS TRAINER'S WIRE -- the list of teachable spells, the buy, and the two answers to it.
 *
 * Nothing here draws. `Interface\AddOns\Blizzard_TrainerUI` is the client's own XML and Lua and it is
 * SERVED (measured: `blizzard_trainerui.toc` 128 B, `.xml` 16,729 B, `.lua` 17,225 B, `Localization.lua`
 * 51 B, all 200 from the asset host). `game/ui/trainer-bridge.ts` is the engine-global half.
 *
 * ## HOW THE WINDOW OPENS, read off the client's own file rather than guessed
 *
 * `UIParent_OnLoad` registers `TRAINER_SHOW` and `TRAINER_CLOSED` (`uiparent.lua:187-188`), and
 * `UIParent_OnEvent`'s arm is
 *
 *     if ( event == "TRAINER_SHOW" ) then ClassTrainerFrame_LoadUI();
 *                                        if ( ClassTrainerFrame_Show ) then ClassTrainerFrame_Show(); end
 *
 * (`uiparent.lua:959-966`), and `ClassTrainerFrame_LoadUI` is one line, `UIParentLoadAddOn(
 * "Blizzard_TrainerUI")` (`uiparent.lua:253-255`). So the ONLY thing this client has to do to get the
 * trainer window on screen is raise `TRAINER_SHOW`; the demand loader (`ui/framexml/addons.ts`,
 * `LoadAddOn` in `lua/api/addons.ts`) already brings the addon in. No frame is built here or anywhere.
 *
 * ## THE LAYOUTS ARE 3.3.5a's, READ OFF A SERVER IMPLEMENTATION, AND LABELLED AS SUCH
 *
 * Same class of source and same caveat as `merchant.ts`, `gossip.ts`, `items.ts` and `loot.ts`: nothing
 * in the game's own data states a packet body, so these come from **TrinityCore's `3.3.5` branch**
 * (`game/Handlers/NPCHandler.cpp`, `WorldSession::SendTrainerList` and
 * `WorldSession::HandleTrainerBuySpellOpcode`). **The 1.12 reference is NOT used**: the merchant round
 * on this project found it silently wrong about four numbers, so it is not consulted for a body here at
 * all.
 *
 * **NO REAL PACKET HAS BEEN DECODED YET, AND THE UNIT TEST DOES NOT CHANGE THAT.** The world was
 * unreachable for this round (the test account returned zero characters), so the 38-byte stride has
 * never met a live `SMSG_TRAINER_LIST`. `__tests__/trainer-wire.test.ts` builds its body from the SAME
 * widths this file reads, so it proves self-consistency and the empty-greeting terminator and nothing
 * about 3.3.5a. **The first real trainer settles it in one reading:** a `TRAINER_LIST` row in
 * `window.spellWire.history()` whose `consumed` equals its `bodySize`, or a `TRAINER_LIST!THREW`. A
 * wrong stride cannot hide -- the trailing greeting would come out as garbage or the read would run off
 * the frame -- which is exactly why the greeting is the last field and is checked.
 *
 * **THE ROW IS SELF-CHECKING AND THAT IS WHY IT CAN BE TRUSTED.** The layout below is
 * `4+1+4+4+4+1+4+4+4*3 = 38` bytes, and the server's own packet reserve is
 * `8 + 4 + 4 + spellList.size() * 38 + title.size() + 1` -- an INDEPENDENT statement of 38 in the same
 * file, written by whoever sized the buffer rather than by whoever wrote the fields. Two agreeing
 * derivations of the stride, plus `consumed == bodySize` on every real packet (recorded in
 * `spellWire`), is the standard this project's other wire files meet.
 *
 * Body:
 *
 *     u64 guid (FULL, not packed)
 *     u32 trainerType            0 class, 1 mounts, 2 tradeskills, 3 pets (`TrainerType`)
 *     u32 count
 *     count x {
 *       u32 spellId              the service's spell -- Spell.dbc gives its name, rank and icon
 *       u8  state               0 available (green), 1 unavailable (red), 2 used/known (grey)
 *       u32 moneyCost           copper, ALREADY reputation-discounted server-side
 *       u32 profDialog          nonzero -> the primary-profession confirmation dialog
 *       u32 profButton          nonzero -> a primary profession's FIRST rank
 *       u8  reqLevel
 *       u32 reqSkill            SkillLine.dbc id, or 0
 *       u32 reqSkillValue
 *       u32 reqSpell[3]         prerequisite spells, zero-padded
 *     }
 *     cstring greeting          the trainer's own hello line
 *
 * ## A SUCCESSFUL BUY DOES NOT RE-SEND THE LIST
 *
 * `HandleTrainerBuySpellOpcode` ends with `SMSG_TRAINER_BUY_SUCCEEDED` (`u64 guid, u32 spellId`) and
 * nothing else -- no fresh `SMSG_TRAINER_LIST`. So the state byte of the row just bought would stay
 * "available" for ever unless something asked again. This handler re-sends `CMSG_TRAINER_LIST` on the
 * success, which is the only way the row goes grey with the SERVER's word for it rather than ours; and
 * because the second list arrives for a guid we already hold, it raises `trainerUpdate` and not
 * `trainerShow`, so `ShowUIPanel` is not run twice. `TRAINER_UPDATE` is exactly the event
 * `ClassTrainerFrame_OnLoad` registers for this (`blizzard_trainerui.lua:60`).
 *
 * The learned spell itself arrives separately, on `SMSG_LEARNED_SPELL` / `SMSG_SUPERCEDED_SPELL`, which
 * `spells.ts` decodes -- that is what puts the new ability in the spellbook.
 *
 * ## NOT VERIFIED LIVE: THE BUY
 *
 * Reading a trainer's list is free; buying is the owner's gold. The list arm is exercised on a real
 * trainer and its residual recorded. `CMSG_TRAINER_BUY_SPELL`, `SMSG_TRAINER_BUY_SUCCEEDED` and
 * `SMSG_TRAINER_BUY_FAILED` are IMPLEMENTED AND UNEXERCISED, and `spellWire` will carry the first real
 * one. Said plainly rather than counted as done.
 */
import EventEmitter from 'events';

import { GameHandler } from '../handler';
import GamePacket from '../packet';
import GameOpcode from '../opcode';
import { guidBytes, guidHex, GUID_BYTES } from '../../guid-hex';
import { spellWire, SpellWireRow } from '../../../game/classes/spell-wire';

/** The `spellWire` kinds this file writes. Narrowed so a typo cannot become a new kind silently. */
type WireKind = SpellWireRow['kind'];

/** `TrainerType` -- the packet's second word. Only `TRADESKILLS` is read by the interface. */
export const TRAINER_TYPE = {
  CLASS: 0,
  MOUNTS: 1,
  TRADESKILLS: 2,
  PETS: 3,
} as const;

/**
 * `TrainerSpellState` -- the row's state byte, and what the three service types in
 * `blizzard_trainerui.lua` are keyed on.
 *
 * The server folds its own `TRAINER_SPELL_GREEN_DISABLED` (10) down to `GREEN` before writing it, so
 * only 0, 1 and 2 can arrive.
 */
export const TRAINER_SPELL_STATE = {
  AVAILABLE: 0,
  UNAVAILABLE: 1,
  USED: 2,
} as const;

/** How many prerequisite spell words every row carries, zero-padded. */
const REQ_SPELLS = 3;

/** One row of `SMSG_TRAINER_LIST`. 38 bytes -- see the header on why that number is corroborated. */
export interface TrainerService {
  /**
   * The service's own 1-based index, in WIRE order and BEFORE any filter.
   *
   * `CMSG_TRAINER_BUY_SPELL` does not carry an index -- it carries the spell id -- so this exists only
   * so the bridge can key a selection on something stable while the display list is filtered.
   */
  index: number;
  /** The spell this service teaches. `Spell.dbc` gives name, rank, icon and description. */
  spellId: number;
  /** 0 available, 1 unavailable, 2 already known. The SERVER's verdict, not recomputed here. */
  state: number;
  /** Copper. Already discounted for reputation server-side. */
  moneyCost: number;
  /**
   * The two profession words, kept under the names the interface reads them by.
   *
   * `GetTrainerServiceCost` answers `moneyCost, cpCost1, cpCost2` and
   * `blizzard_trainerui.lua:352-365` uses them as: `cpCost2 > 0` -> show the confirmation dialog, and
   * `cp2 < cpCost2` -> disable Train, where `cp2` is `UnitCharacterPoints("player")`'s second return,
   * i.e. the profession slots left. So the word compared against the PROFESSION pool has to be
   * `cpCost2`, and that is the one the server writes second (`primary_prof_first_rank ? 1 : 0`, whose
   * own comment is "must be equal prev. field to have learn button in enabled state").
   *
   * The first word ("primary prof. learn confirmation dialog") is therefore `cpCost1`. It is never
   * independently decisive: the server writes it as `first_rank && can_learn`, so a nonzero first word
   * implies a nonzero second, and the Lua tests `cpCost2` first. **This mapping is INFERRED from the
   * two files together and is labelled as inference** -- for a CLASS trainer both words are always 0,
   * which is the whole of this round's deliverable, so a wrong guess here costs nothing until
   * professions are attempted.
   */
  cpCost1: number;
  cpCost2: number;
  /** Minimum character level. A `u8` on the wire. */
  reqLevel: number;
  /** `SkillLine.dbc` id, or 0 for "no skill requirement". */
  reqSkill: number;
  /** The rank of `reqSkill` needed. */
  reqSkillValue: number;
  /** Prerequisite spells, zeroes DROPPED -- so `length` is the interface's ability-requirement count. */
  reqSpells: number[];
}

export class TrainerHandler extends EventEmitter {
  private game: GameHandler;

  /** The trainer whose window is open, or null. */
  public source: string | null = null;

  /** `TrainerType`. `IsTradeskillTrainer()` is this === 2. */
  public trainerType: number = TRAINER_TYPE.CLASS;

  /** The trainer's greeting, the packet's trailing string. */
  public greeting: string = '';

  /** Every service, in wire order and unfiltered. */
  public services: TrainerService[] = [];

  /** The last refusal, for the instrument and a console line. Cleared when a list arrives. */
  public lastError: { code: number; spellId: number; guid: string } | null = null;

  constructor(gameHandler: GameHandler) {
    super();
    // `this.game` FIRST -- `subscribe` reads it. Same order as `MerchantHandler`'s constructor.
    this.game = gameHandler;
    this.subscribe('SMSG_TRAINER_LIST', 'TRAINER_LIST', this.handleList);
    this.subscribe('SMSG_TRAINER_BUY_SUCCEEDED', 'TRAINER_BUY_SUCCEEDED', this.handleBuySucceeded);
    this.subscribe('SMSG_TRAINER_BUY_FAILED', 'TRAINER_BUY_FAILED', this.handleBuyFailed);
    // An open window belongs to the session that opened it -- `MerchantHandler`'s own reasoning. A
    // stale trainer guid would aim the next character's `CMSG_TRAINER_BUY_SPELL` at an NPC in a world
    // he is not in.
    this.game.on('packet:receive:SMSG_LOGIN_VERIFY_WORLD', () => this.close());
  }

  /**
   * One arm with the over-read catch and the residual, exactly as `merchant.ts#subscribe` does it and
   * for the same two reasons: `byte-buffer` THROWS past the frame and an uncaught throw takes every
   * packet still buffered in that data event; and a layout read off a server implementation is
   * validated rather than trusted, so `consumed` against `bodySize` is recorded every time.
   */
  private subscribe(name: string, kind: WireKind, arm: (gp: GamePacket) => void): void {
    this.game.on(`packet:receive:${name}`, (gp: GamePacket) => {
      // Every listener on one opcode shares the packet object and therefore the read cursor, so rewind
      // unconditionally -- `spells.ts#handleInitialSpells` states the same reason.
      gp.index = gp.headerSize;
      const bodySize = gp.length - gp.headerSize;
      try {
        arm.call(this, gp);
        this.record(kind, bodySize, gp.index - gp.headerSize);
      } catch (e) {
        this.record(`${kind}!THREW`, bodySize, gp.index - gp.headerSize);
        console.warn(
          `trainer: ${name} did not decode -- ${(e as Error).message}. These layouts come from a`
          + ' SERVER implementation (see the header of network/game/object/trainer.ts) and are'
          + ' validated rather than trusted. Read window.spellWire.history().',
        );
      }
    });
  }

  /** One `spellWire` row. The trainer opcodes share that instrument rather than growing a second. */
  private record(kind: WireKind, bodySize: number, consumed: number): void {
    spellWire.record({
      at: Date.now(),
      kind,
      spellId: 0,
      caster: this.source,
      detail: {
        services: this.services.length,
        trainerType: this.trainerType,
        greeting: this.greeting.slice(0, 40),
      },
      bodySize,
      consumed,
    });
  }

  // -- Incoming -----------------------------------------------------------------------------------

  /**
   * `SMSG_TRAINER_LIST` (**0x1B1**) -- the whole list, and what opens the window.
   *
   * See the header for the body. Two things are deliberate:
   *
   *  - **The greeting is `readCStr`, not `readCString`.** byte-buffer's own reader does not consume an
   *    EMPTY string's terminator (`net/packet.js#readCStr` carries the measurement), and a server with
   *    no greeting row for this NPC sends exactly that -- which would leave the residual at 1 and read
   *    as a broken layout. `gossip.ts` and `combat.ts` were both bitten by this.
   *  - **A list for the guid we already hold raises `trainerUpdate`.** See the header on the buy.
   */
  private handleList(gp: GamePacket): void {
    const guid = this.readFullGuid(gp);
    const trainerType = gp.readUnsignedInt() >>> 0;
    const count = gp.readUnsignedInt() >>> 0;
    const services: TrainerService[] = [];
    for (let i = 0; i < count; ++i) {
      const spellId = gp.readUnsignedInt() >>> 0;
      const state = gp.readUnsignedByte();
      const moneyCost = gp.readUnsignedInt() >>> 0;
      const cpCost1 = gp.readUnsignedInt() >>> 0;
      const cpCost2 = gp.readUnsignedInt() >>> 0;
      const reqLevel = gp.readUnsignedByte();
      const reqSkill = gp.readUnsignedInt() >>> 0;
      const reqSkillValue = gp.readUnsignedInt() >>> 0;
      const reqSpells: number[] = [];
      for (let r = 0; r < REQ_SPELLS; ++r) {
        const req = gp.readUnsignedInt() >>> 0;
        // Zeroes dropped HERE rather than at the bridge: `GetTrainerServiceNumAbilityReq` is this
        // length, and the padding is the server's, not a requirement.
        if (req !== 0) {
          reqSpells.push(req);
        }
      }
      services.push({
        index: i + 1,
        spellId,
        state,
        moneyCost,
        cpCost1,
        cpCost2,
        reqLevel,
        reqSkill,
        reqSkillValue,
        reqSpells,
      });
    }
    const greeting = gp.readCStr();

    const reopened = this.source !== null && this.source === guid;
    this.source = guid;
    this.trainerType = trainerType;
    this.greeting = greeting;
    this.services = services;
    this.lastError = null;
    this.emit(reopened ? 'trainerUpdate' : 'trainerShow');
  }

  /**
   * `SMSG_TRAINER_BUY_SUCCEEDED` (**0x1B3**): `u64 guid · u32 spellId`, 12 bytes.
   *
   * The server sends no fresh list, so this asks for one -- see the header. The spell itself lands on
   * `SMSG_LEARNED_SPELL`, which `spells.ts` decodes.
   */
  private handleBuySucceeded(gp: GamePacket): void {
    const guid = this.readFullGuid(gp);
    const spellId = gp.readUnsignedInt() >>> 0;
    if (this.source !== guid) {
      // An answer from a trainer we are no longer looking at. `merchant.ts#handleBuyItem` guards the
      // same way and for the same reason.
      return;
    }
    this.emit('trainerBought', { spellId, guid });
    // Ask the SERVER what the row's state is now rather than assuming "used" here. One packet, sent
    // once per purchase.
    this.list(guid);
  }

  /**
   * `SMSG_TRAINER_BUY_FAILED` (**0x1B4**): `u64 guid · u32 spellId · u32 reason`, 16 bytes.
   *
   * The reason codes' MEANINGS are the server's own comment (0 unavailable, 1 not enough money, 2 not
   * enough skill) and are not independently corroborated, so the bridge reports the number as well as
   * a string. Nothing in the interface handles this event at all -- `ClassTrainerFrame_OnLoad`
   * registers only `TRAINER_UPDATE` and `TRAINER_DESCRIPTION_UPDATE` -- so the message is the engine's
   * to deliver.
   */
  private handleBuyFailed(gp: GamePacket): void {
    const guid = this.readFullGuid(gp);
    const spellId = gp.readUnsignedInt() >>> 0;
    const code = gp.readUnsignedInt() >>> 0;
    this.lastError = { code, spellId, guid };
    this.emit('trainerBuyFailed', { code, spellId, guid });
  }

  // -- Outgoing -----------------------------------------------------------------------------------

  /**
   * `CMSG_TRAINER_LIST` (**0x1B0**): one FULL 8-byte guid.
   *
   * NOT the normal way in -- the world's right click sends `CMSG_GOSSIP_HELLO` and the server answers
   * with the list (or with a gossip menu whose "I seek training" option leads to it), exactly as the
   * merchant path works. This exists for the refresh after a purchase and for an addon asking again.
   */
  list(guid: string): void {
    const gp = new GamePacket(
      GameOpcode.CMSG_TRAINER_LIST, GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES,
    );
    gp.write(Array.from(guidBytes(guid)));
    this.game.send(gp);
  }

  /**
   * `CMSG_TRAINER_BUY_SPELL` (**0x1B2**): `u64 guid · u32 spellId`, 12 bytes.
   *
   * **BY SPELL ID, not by list index** -- `HandleTrainerBuySpellOpcode`'s READ order is
   * `recvData >> guid >> spellId` (read off the `Read`, not off a declaration), and it then looks the
   * spell up in the trainer's own list, which is why a filtered display list costs nothing here.
   *
   * **IF THIS PRODUCES SILENCE, SUSPECT THE WIDTH BEFORE ANYTHING ELSE.** Six defects in the item area
   * were a field widened between 1.12 and 3.3.5a, and every one of them looked like an inert gesture
   * rather than a refusal: a short body makes the server read past the end of the frame and DISCARD the
   * packet, so no reply of any kind comes back (`CLAUDE.md`'s trap list). This send is 12 bytes, and
   * later expansions added a `trainerId` word that 3.3.5a does not have -- so 12 is the number to
   * re-derive first if a purchase does nothing.
   *
   * That is diagnosable rather than silent BECAUSE of the `TRAINER_BUY_SENT` row below: a
   * `TRAINER_BUY_SENT` in `window.spellWire.history()` with no `TRAINER_BUY_SUCCEEDED` and no
   * `TRAINER_BUY_FAILED` after it is the signature of a discarded frame, not of a refused purchase.
   *
   * IMPLEMENTED AND UNEXERCISED: see the header on why the buy was not tested.
   */
  buy(spellId: number): void {
    const guid = this.source;
    if (guid === null) {
      return;
    }
    const gp = new GamePacket(
      GameOpcode.CMSG_TRAINER_BUY_SPELL, GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES + 4,
    );
    gp.write(Array.from(guidBytes(guid)));
    gp.writeUnsignedInt(spellId >>> 0);
    this.game.send(gp);
    spellWire.record({
      at: Date.now(),
      kind: 'TRAINER_BUY_SENT',
      spellId,
      caster: guid,
      detail: { services: this.services.length },
      bodySize: GUID_BYTES + 4,
      consumed: GUID_BYTES + 4,
    });
  }

  /**
   * Drop the window.
   *
   * Nothing goes out: 3.3.5a has no `CMSG_TRAINER_CLOSE` (grepped `opcode.js` -- the trainer family is
   * five opcodes, 0x1B0..0x1B4, and none of them is a close). `CloseTrainer` in the bridge therefore
   * calls this and sends nothing, exactly as `CloseMerchant` does.
   */
  close(): void {
    if (this.source === null) {
      return;
    }
    this.source = null;
    this.services = [];
    this.greeting = '';
    this.lastError = null;
    this.emit('trainerClosed');
  }

  /** Eight little-endian bytes -> the normalised guid string. `guid-hex.ts` says why not a Number. */
  private readFullGuid(gp: GamePacket): string {
    const bytes = new Uint8Array(GUID_BYTES);
    for (let i = 0; i < GUID_BYTES; ++i) {
      bytes[i] = gp.readUnsignedByte();
    }
    return guidHex(bytes);
  }
}

export default TrainerHandler;
