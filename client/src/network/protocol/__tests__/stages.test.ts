import {
  LoginStage,
  LOGON_RESULT_STRINGS,
  logonRefusal,
  worldRefusal,
} from '../stages';

describe('logonRefusal', () => {
  it('names the codes the realmd protocol actually sends', () => {
    // Values from the client's own table (`network/auth/challenge-opcode.js`); key names verified
    // present in the shipped `interface/gluexml/gluestrings.lua`.
    expect(logonRefusal(0x03)).toEqual({ code: 0x03, stringKey: 'AUTH_BANNED' });
    expect(logonRefusal(0x04)).toEqual({ code: 0x04, stringKey: 'AUTH_UNKNOWN_ACCOUNT' });
    expect(logonRefusal(0x05)).toEqual({ code: 0x05, stringKey: 'AUTH_INCORRECT_PASSWORD' });
    expect(logonRefusal(0x06)).toEqual({ code: 0x06, stringKey: 'AUTH_ALREADY_ONLINE' });
    expect(logonRefusal(0x09)).toEqual({ code: 0x09, stringKey: 'AUTH_VERSION_MISMATCH' });
    expect(logonRefusal(0x0c)).toEqual({ code: 0x0c, stringKey: 'AUTH_SUSPENDED' });
  });

  it('falls back to a visible string for a code nobody mapped', () => {
    // A blank dialog is the one unacceptable outcome: the player must see SOMETHING.
    expect(logonRefusal(0x7f)).toEqual({ code: 0x7f, stringKey: 'AUTH_FAILED' });
  });

  it('keeps every mapped key resolvable rather than inventing wording', () => {
    // The table may only name keys; the words come from GlueStrings at runtime.
    Object.values(LOGON_RESULT_STRINGS).forEach((key) => {
      expect(key).toMatch(/^AUTH_[A-Z_]+$/);
    });
  });
});

describe('worldRefusal', () => {
  it('names the world handshake codes the existing client already acts on', () => {
    // `network/game/handler.js` checks exactly 0x0d and 0x15 today, which corroborates the WotLK
    // ResponseCodes ordering where AUTH_OK is 0x0c.
    expect(worldRefusal(0x0d)).toEqual({ code: 0x0d, stringKey: 'AUTH_FAILED' });
    expect(worldRefusal(0x15)).toEqual({ code: 0x15, stringKey: 'AUTH_UNKNOWN_ACCOUNT' });
    expect(worldRefusal(0x16)).toEqual({ code: 0x16, stringKey: 'AUTH_INCORRECT_PASSWORD' });
  });

  it('falls back for an unmapped code', () => {
    expect(worldRefusal(0xee).stringKey).toBe('AUTH_FAILED');
  });
});

describe('LoginStage', () => {
  it('runs from offline to in-world in the order the exchanges happen', () => {
    expect(Object.values(LoginStage)).toEqual([
      'Offline',
      'Connecting',
      'Authenticating',
      'RealmList',
      'JoiningRealm',
      'CharacterList',
      'EnteringWorld',
      'InWorld',
    ]);
  });
});
