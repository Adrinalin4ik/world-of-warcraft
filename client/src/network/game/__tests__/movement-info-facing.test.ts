import { wireFacing } from '../movement-info';

// One test, happy path, on the one thing here with a natural unit seam.
//
// The rest of this round's fix is a SEND LAW -- which opcode goes out on which frame -- and its
// oracle is a real capture against a real server (see `task-9-report.md`); a jest double of
// `GameHandler` would only assert that the code does what the code says. Normalising the facing is
// different: it is a pure function whose bound (`|o| > 4*pi` is rejected server-side) is the whole
// reason it exists, and the pre-fix wire capture showed negative orientations going out.
describe('wireFacing', () => {
  it('normalises an unbounded facing accumulator into [0, 2*pi)', () => {
    const tau = Math.PI * 2;

    // The values actually captured on the wire before the fix, all outside the range.
    expect(wireFacing(-0.009)).toBeCloseTo(tau - 0.009, 6);
    expect(wireFacing(-3.906)).toBeCloseTo(tau - 3.906, 6);

    // Past the 4*pi bound the server rejects, which is where a mouse-look accumulator ends up.
    const far = wireFacing(-13.5);
    expect(far).toBeGreaterThanOrEqual(0);
    expect(far).toBeLessThan(tau);
    expect(Math.cos(far)).toBeCloseTo(Math.cos(-13.5), 6);
    expect(Math.sin(far)).toBeCloseTo(Math.sin(-13.5), 6);

    // Already in range: unchanged, so a normal facing is not perturbed.
    expect(wireFacing(0)).toBe(0);
    expect(wireFacing(3.1)).toBe(3.1);
  });
});
