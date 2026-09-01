import PendingCast from '../pending-cast';

/**
 * WHICH LAYER THIS COVERS: the guard's own arithmetic and the two-arm fork it feeds, and nothing else.
 * It is authoritative for "does a second press see a cast in flight, and is it the same spell" -- which
 * is the substance of the fix. It says nothing about the wire: that `SpellHandler#castSpell` returns
 * before writing a packet, and that `SMSG_SPELL_GO` reaches `clearIf`, are the three lines around this
 * and are verified by reading them, not here.
 *
 * Times are `Date.now()` milliseconds and passed in, so no clock is involved.
 */
describe('PendingCast', () => {
  it('refuses a second press and names which arm, then opens on the resolution', () => {
    const guard = new PendingCast();
    const t0 = 1_000_000;

    // Nothing in flight: the press goes out.
    expect(guard.current(t0)).toBeNull();
    expect(guard.inFlight(t0)).toBe(false);

    // Fireball sent.
    guard.arm(133, t0);

    // 40 ms later -- inside the send -> SMSG_SPELL_START round trip, which is exactly where the mashing
    // lands and exactly what a guard keyed on the cast-bar snapshot would miss.
    expect(guard.current(t0 + 40)).toBe(133);
    // The SAME spell: the caller's silent arm.
    expect(guard.current(t0 + 40) === 133).toBe(true);
    // A DIFFERENT spell: the caller's red-line arm. Both are refusals; only the message differs.
    expect(guard.current(t0 + 40) === 585).toBe(false);

    // A triggered proc resolving mid-cast names a different spell and must NOT open the gate.
    guard.clearIf(585);
    expect(guard.current(t0 + 50)).toBe(133);

    // The cast's own SMSG_SPELL_GO does.
    guard.clearIf(133);
    expect(guard.current(t0 + 60)).toBeNull();
    expect(guard.inFlight(t0 + 60)).toBe(false);
  });

  it('tightens to the server cast time at START and follows a pushback', () => {
    const guard = new PendingCast();
    const t0 = 1_000_000;

    guard.arm(133, t0);
    // START says 1500 ms (Healing Wave's measured server value). Deadline = now + 1500 + 2000 slack.
    guard.refine(1500, t0);
    expect(guard.inFlight(t0 + 3400)).toBe(true);
    expect(guard.inFlight(t0 + 3600)).toBe(false);

    // A pushback stretches the cast, so the guard has to follow it or it would lapse mid-cast.
    guard.delay(800, t0 + 1000);
    expect(guard.inFlight(t0 + 4200)).toBe(true);
    expect(guard.inFlight(t0 + 4400)).toBe(false);
  });
});
