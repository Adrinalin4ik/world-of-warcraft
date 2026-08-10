import { GlueStrings, parseGlueStrings } from '../strings';

/** A verbatim excerpt of the shipped 3.3.5 `interface/gluexml/gluestrings.lua`. */
const EXCERPT = `
ACCOUNT_CREATE_FAILED = "Account creation failed";
ACCOUNT_NAME = "Battle.net Account Name";
ADDON_UPDATE_AVAILABLE = "New version is available\\n";
AUTH_INCORRECT_PASSWORD = "Incorrect Password";
AUTH_UNKNOWN_ACCOUNT = "Unknown account";
BATTLEFIELD_ALERT = "You are eligible to enter %s You will be removed from the queue in %s";
-- a comment line that is not an assignment
CharacterSelectString = "not upper case but still a key";
`;

describe('parseGlueStrings', () => {
  it('reads plain assignments', () => {
    const table = parseGlueStrings(EXCERPT);

    expect(table.get('AUTH_UNKNOWN_ACCOUNT')).toBe('Unknown account');
    expect(table.get('ACCOUNT_NAME')).toBe('Battle.net Account Name');
  });

  it('unescapes newlines', () => {
    const table = parseGlueStrings(EXCERPT);

    expect(table.get('ADDON_UPDATE_AVAILABLE')).toBe('New version is available\n');
  });

  it('keeps %s placeholders intact', () => {
    const table = parseGlueStrings(EXCERPT);

    expect(table.get('BATTLEFIELD_ALERT')).toContain('%s');
  });

  it('skips comments and takes mixed-case keys', () => {
    const table = parseGlueStrings(EXCERPT);

    expect(table.has('--')).toBe(false);
    expect(table.get('CharacterSelectString')).toBe('not upper case but still a key');
  });
});

describe('GlueStrings', () => {
  it('substitutes positional placeholders in order', () => {
    const strings = new GlueStrings(parseGlueStrings(EXCERPT));

    expect(strings.format('BATTLEFIELD_ALERT', 'Warsong Gulch', '2 minutes')).toBe(
      'You are eligible to enter Warsong Gulch You will be removed from the queue in 2 minutes',
    );
  });

  it('returns the key itself for a missing string, so a gap is visible not blank', () => {
    const strings = new GlueStrings(parseGlueStrings(EXCERPT));

    expect(strings.get('NO_SUCH_KEY')).toBe('NO_SUCH_KEY');
  });
});
