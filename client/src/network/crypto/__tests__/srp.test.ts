import SRP from '../srp';

/**
 * `validate()` had no coverage at all before this file: the only production caller
 * (`network/auth/handler.js`) always supplied a byte-buffer slice, so the plain/typed-array path
 * a protocol-layer caller needs was never exercised by anything -- which is exactly how it stayed
 * broken (`M2.toArray()` with no fallback) until the logon transport tried to use it.
 *
 * These tests pin the ACCEPTED SHAPES rather than re-deriving SRP arithmetic: `feed()` runs once
 * with fixed inputs, and the expected M2 is read straight off the class's own computed digest.
 */
function fedSrp(): SRP {
  // A one-byte N keeps the modular exponentiation cheap; the shapes under test don't depend on it.
  const N = [0x89];
  const g = [7];
  const salt = new Array(32).fill(0xb1);
  const B = new Array(32).fill(0x51);

  const srp = new SRP(N, g);
  srp.feed(salt, B, 'TESTER', 'SECRET');
  return srp;
}

describe('SRP.validate', () => {
  it('accepts a plain array carrying the correct M2', () => {
    const srp = fedSrp();
    const expectedM2: number[] = (srp as any)._M2.digest;

    expect(srp.validate(Array.from(expectedM2))).toBe(true);
  });

  it('accepts an object exposing toArray() carrying the same M2', () => {
    const srp = fedSrp();
    const expectedM2: number[] = (srp as any)._M2.digest;

    expect(srp.validate({ toArray: () => Array.from(expectedM2) })).toBe(true);
  });
});
