import { readAutoLogin } from '../auto-login';

/**
 * The PARSE, which is the half that can be wrong without anything complaining.
 *
 * The walk itself is three Lua calls into the client's own entry points and shows up immediately when it
 * misfires -- either the game is entered or it is not. The parameter reading is the opposite: a partial or
 * malformed set that quietly returns "no autologin requested" looks exactly like a URL the owner typed
 * wrong, and "all four or nothing" is his own wording.
 */
test('all four parameters are required, and the indices are 1-based integers', () => {
  const full = readAutoLogin('?login=Test&password=hunter2&realmIndex=1&characterIndex=2');
  expect(full).toEqual({
    login: 'Test', password: 'hunter2', realmIndex: 1, characterIndex: 2,
  });

  // A partial set is NOT a request: filling the form and stopping, or guessing realm 1, are different
  // intentions and neither is this file's to choose.
  expect(readAutoLogin('?login=a&password=b&realmIndex=1')).toBeNull();
  expect(readAutoLogin('?login=a&password=b')).toBeNull();
  expect(readAutoLogin('')).toBeNull();

  // 1-based, matching `GetNumRealms` and `CharacterSelect_SelectCharacter`. A 0 is a mistake, not "first".
  expect(readAutoLogin('?login=a&password=b&realmIndex=0&characterIndex=1')).toBeNull();
  expect(readAutoLogin('?login=a&password=b&realmIndex=1&characterIndex=x')).toBeNull();

  // An EMPTY password is a real value -- some private-server test accounts have one -- while an empty
  // account name cannot be typed into the form at all.
  expect(readAutoLogin('?login=a&password=&realmIndex=1&characterIndex=1')).not.toBeNull();
  expect(readAutoLogin('?login=&password=b&realmIndex=1&characterIndex=1')).toBeNull();
});
