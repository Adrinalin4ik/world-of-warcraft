import { LoginStage } from '../../../../network/protocol/stages';
import { loginDialog } from '../login-state';

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
