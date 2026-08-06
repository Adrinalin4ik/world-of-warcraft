import { parseToc, tocDirective } from '../toc';

describe('parseToc', () => {
  it('keeps directives and files in the order the manifest lists them', () => {
    // A synthetic manifest, NOT a copy of the real gluexml.toc -- it exercises both the
    // colon-directive and comment forms, but the real 3.3.5 gluexml.toc has no `##` line with a
    // colon at all (its four `##` lines are all colon-less comments, and it lists 31 files, not the
    // 3 below). That is exactly why the comment-versus-directive distinction below is worth testing:
    // the `##Debug` line has no colon, so it must be skipped as a COMMENT, not fetched as a file
    // named "##DebugHook.lua".
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
