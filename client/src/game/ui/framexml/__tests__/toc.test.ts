import { parseToc, tocDirective } from '../toc';

describe('parseToc', () => {
  it('keeps directives and files in the order the manifest lists them', () => {
    // The real gluexml.toc, abridged. Note the `##Debug` line: a directive with no colon is a
    // COMMENT, not a file, or the loader would try to fetch "##DebugHook.lua".
    const toc = parseToc(
      [
        '## Interface: 30300',
        '##DebugHook.lua',
        'GlueStrings.lua',
        'GlueFonts.xml',
        '',
        '## add new files after here',
        'AccountLogin.xml',
      ].join('\n'),
    );

    expect(toc.directives).toEqual([['Interface', '30300']]);
    expect(toc.files).toEqual(['GlueStrings.lua', 'GlueFonts.xml', 'AccountLogin.xml']);
    expect(tocDirective(toc, 'interface')).toBe('30300');
  });

  it('returns null for a directive the manifest does not carry', () => {
    expect(tocDirective(parseToc('Only.lua'), 'Title')).toBeNull();
  });
});
