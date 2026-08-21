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
 * in the game's own data states a packet body. **These were READ, not recalled** -- TrinityCore's
 * `3.3.5` branch, and specifically:
 *
 *  - `game/Server/Packets/NPCPackets.h:108-117` -- `struct TrainerListSpell`, the field list and their
 *    declared widths;
 *  - `game/Server/Packets/NPCPackets.cpp:96-117` -- `TrainerList::Write()`, the field ORDER, which is
 *    what actually goes on the wire;
 *  - `game/Server/Packets/NPCPackets.cpp:130-134` -- `TrainerBuySpell::Read()`, i.e. the READ order and
 *    not a declaration order (`STATE.md`'s own rule after `CMSG_SPLIT_ITEM`);
 *  - `game/Server/Packets/NPCPackets.cpp:136-151` -- the two buy replies;
 *  - `game/Entities/Creature/Trainer.h:31-51` -- `Trainer::Type`, `Trainer::SpellState` and
 *    `Trainer::FailReason`, so all three enums below are quoted rather than reconstructed;
 *  - `game/Entities/Creature/Trainer.cpp:80-118` -- `TeachSpell`, which is where the reputation
 *    discount is applied and where the success reply is sent from.
 *
 * **The 1.12 reference is NOT used**: the merchant round on this project found it silently wrong about
 * four numbers, so it is not consulted for a body here at all.
 *
 * **THE STRIDE IS CORROBORATED BY THE OWNER'S OWN TEST, BUT THE RESIDUAL IS STILL UNMEASURED, and
 * those are different claims.**
 *
 * He opened a real trainer and reported the list populated with real ability names and "все описания на
 * месте". That is genuine evidence about the 38-byte stride and it is stronger than the unit test: a
 * wrong stride misaligns every `spellId` after the first, so the names and descriptions would be wrong
 * or absent from row 2 down, and they were not. It is NOT a residual, and it does not replace one --
 * two compensating errors could still cancel.
 *
 * `__tests__/trainer-wire.test.ts` builds its body from the SAME widths this file reads, so it proves
 * self-consistency and the empty-greeting terminator and **cannot catch a wrong width**; that is a
 * project rule now, because a wrong width is this codebase's most repeated defect and every instance was
 * silent. The instrument does that job instead -- see `record`, whose `residualPerRow` says whether a
 * nonzero remainder is a per-row error or a header/trailer one. **One reading of a live
 * `SMSG_TRAINER_LIST` closes it:** `consumed == bodySize` in `window.spellWire.history()`, and a
 * legible greeting as the second signal, since the greeting is the last field.
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
 * ## THE BUY: THE SEND IS OWNER-CONFIRMED, THE TWO REPLIES ARE NOT
 *
 * This round refused to exercise the purchase -- reading a list is free, buying is the owner's gold --
 * and the owner then did it himself: **"у меня получилось выучить способность"**. So
 * `CMSG_TRAINER_BUY_SPELL` at **12 bytes** was accepted by a real server, which is precisely the width
 * `STATE.md`'s rule says to suspect first, and it holds.
 *
 * **`SMSG_TRAINER_BUY_SUCCEEDED` and `SMSG_TRAINER_BUY_FAILED` are still self-consistent only, and the
 * successful learn does NOT distinguish them.** If the success reply had failed to decode the window
 * would have refreshed anyway: `spellsChanged` fires off `SMSG_LEARNED_SPELL` and re-fires
 * `TRAINER_UPDATE` independently of this opcode (`ui/trainer-bridge.ts`), so "it looked right
 * afterwards" cannot separate the two paths. The free check is the ABSENCE of a console line: `subscribe`
 * logs `trainer: SMSG_TRAINER_BUY_SUCCEEDED did not decode` on a throwing arm, so the next purchase
 * confirms it at no cost. Said plainly rather than counted as done.
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
   * i.e. the profession slots left.
   *
   * **THE SERVER'S OWN DECLARATION CORROBORATES THE PAIRING, and it is quoted rather than inferred
   * now.** `NPCPackets.h:113` is `std::array<int32, 2> PointCost = { }; // compared with
   * PLAYER_CHARACTER_POINTS in Lua` -- so these two words ARE the two character-point pools in order,
   * which is exactly what `UnitCharacterPoints` returns. What remains an inference is only WHICH of the
   * two the Lua calls `cpCost1` and which `cpCost2`, and the Lua settles that too: the word compared
   * against the profession pool has to be the second, because that is the one its `cp2` test uses.
   *
   * For a CLASS trainer both words are 0 (`Trainer::Spell` only sets them for a primary profession's
   * first rank), which is the whole of this round's deliverable -- so this pairing cannot be wrong in
   * a way that matters until professions are attempted.
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

  /**
   * WHAT `SMSG_TRAINER_LIST`'s HEADER SAID, stashed the instant it is read and BEFORE the row loop.
   *
   * Its only purpose is the residual diagnostic in `record`, and the "before the row loop" placement is
   * the whole point: if the row stride is wrong the loop either over-reads and THROWS or under-reads
   * and leaves a remainder, and in the throwing case the count is the one thing still needed to tell
   * those two apart. Reading it out of `this.services.length` afterwards would give the wrong number in
   * exactly the case that matters.
   */
  private lastHeader: { count: number; greetingBytes: number } | null = null;

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

  /**
   * One `spellWire` row -- and for `SMSG_TRAINER_LIST` it does not merely report the residual, it says
   * WHICH KIND OF LAYOUT ERROR a nonzero one is.
   *
   * **THIS IS THE DISCRIMINATOR THE COORDINATOR ASKED FOR, and it is arithmetic rather than judgement.**
   * A widened field and an inserted field need different fixes, and the residual tells them apart in one
   * reading, because the body is `16 + count * stride + greeting + 1` and only the row term scales:
   *
   *  - **`residualPerRow` is a whole number** -> the error is INSIDE THE ROW and it is that many bytes
   *    per row. A field widened (`u8` -> `u32` is +3) or one was inserted (+4 for a word). Fix: the row.
   *  - **`residualPerRow` is null** (the residual does not divide by the count) -> the row stride is
   *    right and something in the HEADER or the TRAILER moved. Fix: the 16-byte header or the greeting.
   *  - **the kind ends `!THREW`** -> we over-read, so our stride is too LARGE, which the two cases above
   *    cannot express. `count` is still recorded because it was stashed before the loop.
   *
   * A second, independent signal is free: `greeting` is the LAST field, so a wrong stride garbles it.
   * A residual of 0 with a legible greeting is the layout being right; a residual of 0 with a garbled
   * greeting would mean two errors cancelling, which is worth knowing is possible.
   *
   * This exists because the round's own unit test cannot catch a wrong width -- it builds its body from
   * the same widths the decoder reads, so it proves self-consistency and nothing else. Eleven silent
   * width defects on this project say the instrument has to do that job instead.
   */
  private record(kind: WireKind, bodySize: number, consumed: number): void {
    const residual = bodySize - consumed;
    const count = this.lastHeader?.count ?? 0;
    // Only meaningful for the list, and only when there were rows to divide by.
    const perRow = residual !== 0 && count > 0 && residual % count === 0 ? residual / count : null;
    spellWire.record({
      at: Date.now(),
      kind,
      spellId: 0,
      caster: this.source,
      detail: {
        services: this.services.length,
        trainerType: this.trainerType,
        // Kept SHORT but kept: a garbled greeting is the second signal that the stride is wrong.
        greeting: this.greeting.slice(0, 40),
        wireCount: count,
        residual,
        // `null` is a real answer here and not "unknown" -- see the doc comment. It means the residual
        // is not a per-row error.
        residualPerRow: perRow,
        greetingBytes: this.lastHeader?.greetingBytes ?? 0,
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
    // BEFORE the row loop, so the residual diagnostic in `record` has the count even if the loop
    // throws. See `lastHeader`.
    this.lastHeader = { count, greetingBytes: 0 };
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
    // The terminator counts: the trailer is `greeting + 1`, which is what makes `16 + count * 38 +
    // greetingBytes` add up to the body when the layout is right.
    this.lastHeader = { count, greetingBytes: greeting.length + 1 };

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
   * **OWNER-CONFIRMED on real traffic** -- he learned a spell -- so the 12 bytes are right and this is
   * no longer the unexercised arm the header used to call it. The two REPLIES are still only
   * self-consistent; see the header on why a successful learn cannot distinguish them.
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
