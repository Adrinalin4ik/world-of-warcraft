import cancelCastOnMove, { setCastBarTeardown } from '../cast-cancel';

/**
 * The two `InterruptFlags` values are the REFERENCE'S OWN byte-verified ones, read back off the served
 * 3.3.5a `Spell.dbc` at the measured column 31 before being used here: Fireball 133 is `0xf` and Heroic
 * Strike 78 is `0x0` (`samples/benilla/crates/benilla-app/src/ui_cast.rs:447-450`; the column
 * measurement is `pipeline/dbc/spell-data.ts#COL.interruptFlags`).
 *
 * WHICH LAYER THIS COVERS: the gate and the decision, with a stub world. It does not cover the input
 * edge -- whether a keyboard TURN raises `onMoveStart` at all is `controls.tsx`'s, and the owner is the
 * one who can see it.
 */
const rows: Record<number, { interruptFlags: number }> = {
  133: { interruptFlags: 0xf }, // Fireball -- movement breaks it
  78: { interruptFlags: 0x0 }, //  Heroic Strike -- it does not
};

jest.mock('../../pipeline/dbc/spell-data', () => ({
  spellData: { spell: (id: number) => (rows[id] ?? null) },
}));

function stubWorld(inFlight: number | null) {
  const calls = { cancelCast: [] as number[], releasedPose: [] as number[] };
  const spellHandler = {
    currentCast: () => inFlight,
    cancelCast: (spellId: number) => { calls.cancelCast.push(spellId); },
    releaseCastGuard: () => {},
    releaseCastPose: (_guid: string | null, spellId: number) => { calls.releasedPose.push(spellId); },
  };
  const world = {
    session: { offline: false },
    player: { guid: '0x1' },
    game: { objectHandler: { spellHandler } },
  };
  return { world: world as never, calls };
}

describe('cancelCastOnMove', () => {
  afterEach(() => setCastBarTeardown(null));

  it('cancels a movement-sensitive cast and spares one whose InterruptFlags say otherwise', () => {
    const bar: number[] = [];
    setCastBarTeardown((spellId) => bar.push(spellId));

    // Fireball: InterruptFlags 0xf, bit 0 set.
    const fireball = stubWorld(133);
    expect(cancelCastOnMove(fireball.world)).toBe(133);
    expect(fireball.calls.cancelCast).toEqual([133]);
    expect(fireball.calls.releasedPose).toEqual([133]);
    expect(bar).toEqual([133]);

    // Heroic Strike: InterruptFlags 0, so charging in must not drop it. Nothing on the wire at all.
    const strike = stubWorld(78);
    expect(cancelCastOnMove(strike.world)).toBeNull();
    expect(strike.calls.cancelCast).toEqual([]);
    expect(bar).toEqual([133]);

    // Nothing in flight: a move is just a move.
    expect(cancelCastOnMove(stubWorld(null).world)).toBeNull();
  });
});
