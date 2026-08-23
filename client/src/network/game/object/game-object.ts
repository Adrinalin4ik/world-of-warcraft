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
 * ## THE RESPONSE IS READ AS A PREFIX, ON PURPOSE
 *
 * 3.3.5a's response carries the entry, a type, a display id, **four** name strings, an icon name, a
 * cast-bar caption, one more string, then a long block of template data words, a float size and a
 * quest-item array. This parse stops after the first name and reads none of the tail.
 *
 * That is a decision, not laziness, and `CLAUDE.md` is the reason. Nothing the client ships states this
 * body, so any tail here would come from a server implementation recalled rather than read -- and the
 * only thing that settles such a layout is a residual against real traffic, which cannot be taken from
 * here. A prefix of fixed-width words followed by C-strings is safe to walk because each string
 * self-terminates; the words AFTER them are where a wrong count silently lands a field in the wrong
 * place. So this reads exactly what it needs, records how much of the body it consumed, and **states
 * that the remainder is deliberate** rather than reporting a clean residual it has not earned.
 *
 * What that costs: nothing the owner asked for. The name is what a tooltip needs. `castBarCaption`
 * would be the one nice-to-have -- it is what the real client shows above the opening cast instead of
 * the spell name -- and it sits after three more strings, so it is reachable the day someone captures
 * a body and can prove the string order. Named, not silently skipped.
 *
 * ## USING ONE IS EIGHT BYTES AND HAS NO REPLY OF ITS OWN
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
}

export class GameObjectHandler extends EventEmitter {
  /** entry -> its template prefix. Outlives a world session, like `CombatHandler#creatures`. */
  public templates = new Map<number, GameObjectTemplate>();

  /** While `performance.now()` is below this, every inbound opcode is logged. See the constructor. */
  private watchUntil = 0;

  /** Entries with a query in flight, so a grid of identical bushes asks once. */
  private asked = new Set<number>();

  constructor(private game: GameHandler) {
    super();
    this.game.on(
      `packet:receive:SMSG_GAMEOBJECT_QUERY_RESPONSE`,
      (gp: GamePacket) => this.handleQueryResponse(gp),
    );
    /**
     * EVERY INBOUND OPCODE FOR THREE SECONDS AFTER A USE -- and this exists because I misread a silence.
     *
     * The owner reported nothing coming back from `CMSG_GAMEOBJ_USE`, and I treated that as established.
     * It was not: `socket.js`' console line logs OUTGOING packets only (`⇨`), so "nothing came back"
     * rested entirely on the absence of my two loot lines -- which fire only for `SMSG_LOOT_RESPONSE`. A
     * server that answered with the Opening spell's `SMSG_SPELL_START`, or with a custom animation, or
     * with a refusal on some other opcode, would have produced exactly the same silence in his console
     * while being a completely different defect.
     *
     * The probe data he sent makes this the right next question rather than a fishing trip: guid
     * `0xf110...` (a real GAMEOBJECT high guid), entry 161557, **type 3** (a chest), name
     * "Milly's Harvest", **2.63 yd**, state READY, `dynamic` carrying the activate bit. Every condition
     * `GetGameObjectIfCanInteractWith` checks is satisfied -- and the name itself proves the server
     * accepted a packet carrying THIS guid, since that is where the name came from. So the guid bytes,
     * the distance and the object are all exonerated, and what remains is what the server actually said.
     *
     * Cost when not armed: one number comparison per inbound packet. Armed for three seconds after a
     * use, which is long enough to cover an Opening cast (about one second) and the loot behind it.
     */
    this.game.on('packet:receive', (gp: GamePacket) => {
      if (performance.now() > this.watchUntil) {
        return;
      }
      try {
        // eslint-disable-next-line no-console
        console.log(`gameobject: after USE <- ${gp.opcodeName ?? `opcode 0x${gp.opcode.toString(16)}`}`
          + ` (body ${gp.bodySize})`);
      } catch {
        // A diagnostic may never cost a packet.
      }
    });
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
  use(guid: string): void {
    const gp = new GamePacket(
      GameOpcode.CMSG_GAMEOBJ_USE, GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES,
    );
    gp.write(Array.from(guidBytes(guid)));
    this.game.send(gp);
    // Arm the inbound watch -- see the constructor on why a silence could not be trusted.
    this.watchUntil = performance.now() + 3000;
  }

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
      const template: GameObjectTemplate = { entry, type, displayId, name };
      if (name === '') {
        console.warn(
          `gameObject: template ${entry} answered with an empty name (body ${gp.bodySize}).`
          + ' The prefix parse may be misaligned -- see game-object.ts on why the tail is not read.',
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
