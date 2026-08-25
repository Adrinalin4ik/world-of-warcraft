/**
 * WORLD OBJECTS ON THE WIRE -- their name, and using them.
 *
 * Steps 4 and 6 of the arc `pipeline/dbc/game-object-display-data.ts` opens. Two opcodes, both already
 * in `opcode.js` with no subscriber and no sender before this:
 *
 *     CMSG_GAMEOBJECT_QUERY           0x05E   u32 entry, u64 guid
 *     SMSG_GAMEOBJECT_QUERY_RESPONSE  0x05F   the template -- name, and a long tail
 *     CMSG_GAMEOBJ_USE                0x0B1   u64 guid
 *
 * ## THE RESPONSE'S TAIL IS READ, AND A RESIDUAL IS ITS ONLY ORACLE
 *
 * This parse used to stop after the first name, on the ground that a tail taken from a recalled server
 * implementation is worth nothing without a residual against real traffic. That ground still holds --
 * so the residual is what `handleQueryResponse` does. The whole body is walked and `consumed` is
 * compared against `bodySize`; `lockId` is trusted only when they agree, and a mismatch leaves it null
 * and prints the remainder. Null falls back to the use path, which is exactly the behaviour before the
 * tail was read, so a wrong layout costs nothing new.
 *
 * Reading it became necessary rather than merely nice: the lock is what decides how an object opens.
 *
 * ## AND `CMSG_GAMEOBJ_USE` IS ONLY HALF THE ROUTING -- the lock decides
 *
 * This header used to say the use packet was "the last piece rather than the first of several". It was
 * not, and the owner's bucket is the case that proves it: a correct 8-byte use went out and the server
 * answered **nothing**, over three seconds of watched inbound traffic. The reference has the law --
 * "a locked object (chest / mining vein / herb node / locked door) casts an `OPEN_LOCK` spell at it, an
 * unlocked one sends `CMSG_GAMEOBJ_USE`" (`go_templates.rs:3-5`) -- so `open` below routes on the
 * template's `lockId`, and the tail of the query response is read to get it.
 *
 * `CMSG_GAMEOBJ_USE` carries the guid and nothing else. The server answers with whatever the object
 * does -- for a bush, `SMSG_LOOT_RESPONSE`, which this client already decodes and already draws
 * (`object/loot.ts`, `ui/loot-bridge.ts`); for one with an opening cast, `SMSG_SPELL_START` first,
 * which `ui/action-bridge.ts` already feeds to `CastingBarFrame`. So this send is the last piece rather
 * than the first of several: everything downstream of it was already standing.
 *
 * **A guid, not an entry**, and the distinction matters here more than usual: the query is keyed on the
 * TEMPLATE (one round trip per kind of bush, whatever the count on screen), while the use names the ONE
 * bush in front of you. Mixing them up would loot a different crate.
 */
import EventEmitter from 'events';

import GameOpcode from '../opcode';
import GamePacket from '../packet';
import { GUID_BYTES, guidBytes } from '../../guid-hex';
import type { GameHandler } from '../handler';

/** What `SMSG_GAMEOBJECT_QUERY_RESPONSE`'s prefix says. See the header on why it stops here. */
export interface GameObjectTemplate {
  entry: number;
  /** `GAMEOBJECT_TYPE_*`. 3 is a chest, 25 is a fishing hole; a herb node is a chest too. */
  type: number;
  displayId: number;
  name: string;
  /**
   * `Lock.dbc` id, or 0 for no lock -- **the field that decides how the object is opened**.
   *
   * The reference states the law and this is the whole reason the tail is now read:
   * "a locked object (chest / mining vein / herb node / locked door) casts an `OPEN_LOCK` spell at it,
   * an unlocked one sends `CMSG_GAMEOBJ_USE`" (`benilla-app/src/go_templates.rs:3-5`).
   *
   * **Null when the body did not close**, which is not the same as 0. See `handleQueryResponse`: a
   * residual means the tail was misread, and a misread 0 would route a locked chest down the use path
   * that is already known not to work. Null keeps today's behaviour and says so.
   */
  lockId: number | null;
}

export class GameObjectHandler extends EventEmitter {
  /** entry -> its template prefix. Outlives a world session, like `CombatHandler#creatures`. */
  public templates = new Map<number, GameObjectTemplate>();

  /** Entries with a query in flight, so a grid of identical bushes asks once. */
  private asked = new Set<number>();

  constructor(private game: GameHandler) {
    super();
    this.game.on(
      `packet:receive:SMSG_GAMEOBJECT_QUERY_RESPONSE`,
      (gp: GamePacket) => this.handleQueryResponse(gp),
    );
  }

  /**
   * Ask for an object template's name, once per entry.
   *
   * The re-apply arm is `CombatHandler#queryCreature`'s and is here for the same reason it is there:
   * `templates` and `asked` outlive a world session, so after a reconnect every object is a fresh
   * entity with no name while its template is still cached. A bare `asked.has` guard would skip the
   * query AND never announce the name, leaving every bush unnamed for the rest of the second session.
   */
  query(entry: number, guid: string): void {
    if (!entry) {
      return;
    }
    const known = this.templates.get(entry);
    if (known) {
      this.emit('gameObjectTemplate', known);
      return;
    }
    if (this.asked.has(entry)) {
      return;
    }
    this.asked.add(entry);
    const gp = new GamePacket(
      GameOpcode.CMSG_GAMEOBJECT_QUERY, GamePacket.HEADER_SIZE_OUTGOING + 4 + GUID_BYTES,
    );
    gp.writeUnsignedInt(entry >>> 0);
    gp.write(Array.from(guidBytes(guid)));
    this.game.send(gp);
  }

/**
   * `SPELL_OPENING` -- spell **6478**, "Opening", the `SPELL_EFFECT_OPEN_LOCK` every character knows.
   *
   * NOT chosen by me. The reference names it and says why it is the one that lands on a ground
   * container: "every character knows both 6478 'Opening' and 22810 'Opening - No Text' -- both
   * `SPELL_EFFECT_OPEN_LOCK` on `LockType 13` (Open Kneeling), both trivially sufficient against the
   * `Skill == 0` slots **the ground containers carry**" (`target/lock.rs:145-149`). It also records
   * which of the two wins and why: the client walks its known-spell array in ascending id and returns on
   * the first sufficient match, so 6478 is the one whose name reaches the cast bar -- and iterating in
   * any other order put Blizzard's placeholder name there instead, which it logs as a real bug (B247).
   *
   * **WHAT IS NOT BUILT, said plainly.** The reference's full resolver walks the eight `Lock.dbc` slots,
   * dispatches SKILL/KEY/NONE, scans the player's known spells for a matching `OPEN_LOCK` effect and
   * compares its value against the slot's requirement (`target/lock.rs:122-175`). That needs `Lock.dbc`,
   * `LockType.dbc`, `SkillLine.dbc` and the spell catalogue's effect data, and it is what makes
   * herbalism, mining, lockpicking and keyed doors work. None of it is here. This client sends 6478 for
   * ANY locked object, which is correct for the quest containers the owner is opening and wrong for a
   * herb node -- and a wrong opener is refused by the server, not silently mis-applied. Declared, and
   * the file to grow is this one.
   */
  private static readonly SPELL_OPENING = 6478;

  /** The template's name, or **null** when it has not arrived. Never a placeholder. */
  nameOf(entry: number): string | null {
    return this.templates.get(entry)?.name ?? null;
  }

  /**
   * `CMSG_GAMEOBJ_USE` -- open the bush, the chest, the door.
   *
   * No reply of its own; see the header. The `finally`-shaped concern does not arise because there is
   * no in-flight set to release -- using the same object twice is a thing the player may legitimately
   * do, so this is deliberately not deduped.
   */
/**
   * Open an object the way its LOCK says to -- the routing the reference calls `0x5f33e0`.
   *
   * `lockId` non-zero means cast; zero means use; **null means the tail did not decode**, and that falls
   * back to `use` rather than casting -- the same behaviour this client had before the tail was read, so
   * a residual costs no more than it did. Returns what it sent so the caller can say so.
   */
  open(guid: string, entry: number): 'cast' | 'use' {
    const lockId = this.templates.get(entry)?.lockId ?? null;
    if (lockId !== null && lockId !== 0) {
      this.game.objectHandler?.spellHandler?.castAtObject(GameObjectHandler.SPELL_OPENING, guid);
        return 'cast';
    }
    this.use(guid);
    return 'use';
  }

  use(guid: string): void {
    const gp = new GamePacket(
      GameOpcode.CMSG_GAMEOBJ_USE, GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES,
    );
    gp.write(Array.from(guidBytes(guid)));
    this.game.send(gp);
  }

  /**
   * `SMSG_GAMEOBJECT_QUERY_RESPONSE` -- and the tail is read now, with a RESIDUAL as its oracle.
   *
   * This used to stop after the first name, on the stated ground that the tail was a server
   * implementation recalled rather than read, and that only a residual against real traffic settles such
   * a layout. That reasoning still holds -- so the residual is what this does. The whole body is walked
   * and `consumed` is compared against `bodySize`: **`lockId` is only trusted when the two agree**, and
   * a mismatch leaves it null and says so in the console. A misread lock would be worse than none,
   * because 0 means "unlocked" and routes a locked chest down the path already known to be ignored.
   *
   * The layout walked here, and why each step is safe: three words, then **seven C-strings** (four name
   * slots of which the server fills one, an icon name, a cast-bar caption, and one more), then
   * `data[24]`, a float size, and six quest-item ids. Strings self-terminate so walking them cannot
   * desync; the words after them can, which is exactly what the residual catches.
   *
   * `lockId` is `data[0]` for every type this client will meet. That is not a guess about one type: the
   * server's own `GetLockId()` reads slot 0 for door, button, questgiver, chest, trap, goober, area
   * damage, camera, flagstand and flagdrop -- every type but the fishing hole, which uses slot 4 and
   * which this client has no fishing for. Named rather than silently assumed.
   */
  private handleQueryResponse(gp: GamePacket): void {
    try {
      const entry = gp.readUnsignedInt() >>> 0;
      // RELEASE THE DEDUPE HERE, before anything that can throw below. `CLAUDE.md`: "An in-flight/dedupe
      // set must release on the FAILURE path too" -- a thrown decode that left the entry in `asked`
      // would make that object permanently unnameable from one bad packet.
      this.asked.delete(entry);
      const type = gp.readUnsignedInt() >>> 0;
      const displayId = gp.readUnsignedInt() >>> 0;
      // FOUR name slots and the first is the one the client uses -- the same shape
      // `SMSG_CREATURE_QUERY_RESPONSE` has, where the server writes four and fills one.
      const name = gp.readCStr();
      let lockId: number | null = null;
      try {
        for (let i = 1; i < 4; i += 1) {
          gp.readCStr();
        }
        gp.readCStr(); // iconName
        gp.readCStr(); // castBarCaption
        gp.readCStr(); // unk1
        const data: number[] = [];
        for (let i = 0; i < 24; i += 1) {
          data.push(gp.readUnsignedInt() >>> 0);
        }
        gp.readFloat(); // size
        for (let i = 0; i < 6; i += 1) {
          gp.readUnsignedInt(); // questItems
        }
        const consumed = gp.index - gp.headerSize;
        if (consumed === gp.bodySize) {
          lockId = data[0] ?? 0;
        } else {
          console.warn(
            `gameObject: template ${entry} tail residual ${gp.bodySize - consumed} B`
            + ` (consumed ${consumed} of ${gp.bodySize}). lockId is NOT trusted -- see game-object.ts.`,
          );
        }
      } catch (tailError) {
        // Over-read: the tail is longer than the body, so the layout is wrong. The NAME above is still
        // good -- it was read before any of this -- so the tooltip keeps working and only the lock is
        // unknown. That split is the reason the tail is walked in its own `try`.
        console.warn(`gameObject: template ${entry} tail over-read; lockId unknown`, tailError);
      }
      const template: GameObjectTemplate = { entry, type, displayId, name, lockId };
      if (name === '') {
        console.warn(
          `gameObject: template ${entry} answered with an empty name (body ${gp.bodySize}).`
          + ' The prefix parse may be misaligned -- see game-object.ts.',
        );
      }
      this.templates.set(entry, template);
      this.emit('gameObjectTemplate', template);
    } catch (error) {
      // The over-read catch every arm in this directory has, and for the same reason `quest.ts#subscribe`
      // documents: `byte-buffer` THROWS past the frame, and an uncaught throw escapes the receive loop
      // and takes every packet still buffered in that data event.
      console.warn('gameObject: SMSG_GAMEOBJECT_QUERY_RESPONSE did not decode', error);
    }
  }

}

export default GameObjectHandler;
