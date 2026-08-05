/**
 * The URL switch for the login stage. Not the client's own condition -- it forks on
 * `IsStreamingTrial()` -- but the way a human asks to see a particular screen while there is no
 * account to read a flag from.
 */
import { wantsTrialScene } from '../screens/probe';

describe('wantsTrialScene', () => {
  it('defaults to the Wrath causeway, which is what a normal 3.3.5 account sees', () => {
    expect(wantsTrialScene('')).toBe(false);
    expect(wantsTrialScene('?account=x')).toBe(false);
  });

  it('gives the pre-Wrath arch for expansion 0 and 1', () => {
    expect(wantsTrialScene('?expansion=0')).toBe(true);
    expect(wantsTrialScene('?expansion=1')).toBe(true);
  });

  it('gives the Wrath causeway for expansion 2 and above', () => {
    expect(wantsTrialScene('?expansion=2')).toBe(false);
    expect(wantsTrialScene('?expansion=3')).toBe(false);
  });

  it('accepts the client’s own vocabulary too', () => {
    expect(wantsTrialScene('?trial=1')).toBe(true);
    expect(wantsTrialScene('?trial=true')).toBe(true);
    expect(wantsTrialScene('?trial=0')).toBe(false);
  });

  it('ignores a value that is not a number', () => {
    expect(wantsTrialScene('?expansion=wrath')).toBe(false);
  });
});
