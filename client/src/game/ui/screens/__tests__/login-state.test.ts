import { LoginStage } from '../../../../network/protocol/stages';
import { loginDialog, wantsTrialScene } from '../login-state';

describe('loginDialog', () => {
  it('says nothing while the player is still typing', () => {
    expect(loginDialog(LoginStage.Offline, null)).toEqual({ kind: 'none' });
  });

  it('shows the connecting dialog while the exchange is in flight', () => {
    expect(loginDialog(LoginStage.Connecting, null)).toEqual({ kind: 'connecting' });
    expect(loginDialog(LoginStage.Authenticating, null)).toEqual({ kind: 'connecting' });
  });

  it('shows the server\'s own words when it refused', () => {
    // The key is the client's; the wording comes from GlueStrings at draw time.
    expect(loginDialog(LoginStage.Offline, { code: 0x04, stringKey: 'AUTH_UNKNOWN_ACCOUNT' })).toEqual({
      kind: 'error',
      stringKey: 'AUTH_UNKNOWN_ACCOUNT',
    });
  });

  it('drops the error once a new attempt starts', () => {
    // Otherwise the previous failure sits on screen over the connecting dialog.
    expect(loginDialog(LoginStage.Connecting, { code: 0x04, stringKey: 'AUTH_UNKNOWN_ACCOUNT' })).toEqual({
      kind: 'connecting',
    });
  });

  it('says nothing once the realm list has arrived', () => {
    expect(loginDialog(LoginStage.RealmList, null)).toEqual({ kind: 'none' });
  });
});

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

  it("accepts the client's own vocabulary too", () => {
    expect(wantsTrialScene('?trial=1')).toBe(true);
    expect(wantsTrialScene('?trial=true')).toBe(true);
    expect(wantsTrialScene('?trial=0')).toBe(false);
  });

  it('ignores a value that is not a number', () => {
    expect(wantsTrialScene('?expansion=wrath')).toBe(false);
  });
});
