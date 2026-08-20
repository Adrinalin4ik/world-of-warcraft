/**
 * `SMSG_INITIALIZE_FACTIONS` (0x122), and the signedness that would turn every hostile faction friendly.
 *
 * The layout's only source is a server implementation (TrinityCore's `ReputationMgr::
 * SendInitialReputations`), which is exactly why it is pinned here: `uint32 count`, then
 * `count x { uint8 flags; uint32 standing }`. Two tests, on the two things that fail SILENTLY --
 * a standing read unsigned, and the pair stride.
 */
import GamePacket from '../../packet';
import GameOpcode from '../../opcode';
import { FACTION_FLAG_AT_WAR, FACTION_FLAG_VISIBLE, ReputationHandler } from '../reputation';

/** A minimal stand-in for `GameHandler`: the two methods the handler actually uses. */
function fakeGame() {
  const listeners = new Map<string, Array<(gp: unknown) => void>>();
  return {
    events: [] as string[],
    on(event: string, fn: (gp: unknown) => void) {
      const list = listeners.get(event);
      if (list === undefined) {
        listeners.set(event, [fn]);
      } else {
        list.push(fn);
      }
    },
    emit(event: string) {
      this.events.push(event);
    },
    fire(event: string, gp: unknown) {
      for (const fn of listeners.get(event) ?? []) {
        fn(gp);
      }
    },
  };
}

/**
 * An incoming packet whose buffer is EXACTLY the body -- which is the whole point.
 *
 * `ByteBuffer#length` is a getter over the allocation, so an over-allocated buffer reads as body the
 * handler is allowed to consume, and its zero fill makes a short packet look like a long one full of
 * neutral factions. Sizing it exactly is what lets the clamp test mean anything. (First version of this
 * test allocated 1024 bytes and tried to assign `length`; it threw, which is how this was caught.)
 */
function incoming(bytes: number, write: (gp: InstanceType<typeof GamePacket>) => void) {
  const gp = new GamePacket(GameOpcode.SMSG_INITIALIZE_FACTIONS, bytes, false);
  gp.index = 0;
  write(gp);
  gp.index = 0;
  return gp;
}

describe('SMSG_INITIALIZE_FACTIONS', () => {
  it('reads the standing SIGNED, so a hated faction stays negative', () => {
    const game = fakeGame();
    const handler = new ReputationHandler(game);

    // 4 (count) + 2 x 5 (flags + standing)
    const gp = incoming(14, (p) => {
      p.writeUnsignedInt(2);
      p.writeUnsignedByte(FACTION_FLAG_VISIBLE);
      p.writeInt(-42000); // Hated
      p.writeUnsignedByte(FACTION_FLAG_VISIBLE | FACTION_FLAG_AT_WAR);
      p.writeInt(21000); // Revered
    });
    game.fire('packet:receive:SMSG_INITIALIZE_FACTIONS', gp);

    const all = handler.all();
    expect(all.size).toBe(2);
    // Unsigned, this would be 4294925296 -- and every hostile faction would render as Exalted.
    expect(all.get(0)!.standing).toBe(-42000);
    expect(all.get(0)!.flags).toBe(FACTION_FLAG_VISIBLE);
    // The stride is what puts the second pair here at all: 1 flag byte + 4 standing bytes.
    expect(all.get(1)!.standing).toBe(21000);
    expect(all.get(1)!.flags & FACTION_FLAG_AT_WAR).toBe(FACTION_FLAG_AT_WAR);
  });

  it('clamps to what the body can hold instead of over-reading a short packet', () => {
    const game = fakeGame();
    const handler = new ReputationHandler(game);

    // Claims 128 pairs and carries one. `byte-buffer` THROWS on a short read, and an uncaught throw
    // here would escape the receive loop and take every packet still buffered with it.
    const gp = incoming(9, (p) => {
      p.writeUnsignedInt(128);
      p.writeUnsignedByte(FACTION_FLAG_VISIBLE);
      p.writeInt(3000);
    });
    game.fire('packet:receive:SMSG_INITIALIZE_FACTIONS', gp);

    expect(handler.all().size).toBe(1);
    expect(handler.all().get(0)!.standing).toBe(3000);
  });
});
