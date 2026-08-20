import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';
import { prefetchStartupAddOns } from '../addons';

// jsdom ships neither `TextEncoder` nor `TextDecoder`, and `addons.ts` decodes a `.toc` with one. Left
// missing, the decode throws inside its own catch and every addon reads as "not served" -- a failure
// indistinguishable from a 404, which is how it presented the first time this test ran.
(global as unknown as { TextDecoder: unknown }).TextDecoder = NodeTextDecoder;
(global as unknown as { TextEncoder: unknown }).TextEncoder = NodeTextEncoder;

/**
 * The asset host, as a path -> text table, entirely INSIDE the factory.
 *
 * That placement is not style. `babel-plugin-jest-hoist` lifts a `jest.mock` call above the file's
 * statements AND lifts the declarations its factory closes over, so a table declared out here that was
 * itself built from another `const` got hoisted above that `const` and read it in its temporal dead
 * zone. Keeping everything the factory needs inside the factory is the fix.
 *
 * Keyed by the BACKSLASH paths `addons.ts` builds. The two tocs mirror the real ones in the part under
 * test: `Blizzard_TokenUI.toc` really does carry no `## LoadOnDemand` line and really does list exactly
 * these three files, and every other Blizzard addon's toc really does carry `## LoadOnDemand: 1`. Both
 * measured against the asset host.
 */
jest.mock('../../../net/loader', () => {
  const NL = '\n';
  const FILES: Record<string, string> = {
    ['Interface\\AddOns\\Blizzard_TokenUI\\Blizzard_TokenUI.toc']:
      '## Interface: 30300' + NL + '## Title: Blizzard_TokenUI' + NL + '## Secure: 1' + NL
      + 'Blizzard_TokenUI.lua' + NL + 'Blizzard_TokenUI.xml' + NL + 'Localization.lua' + NL,
    ['Interface\\AddOns\\Blizzard_TokenUI\\Blizzard_TokenUI.lua']: 'function TokenFrame_OnLoad() end',
    ['Interface\\AddOns\\Blizzard_TokenUI\\Blizzard_TokenUI.xml']: '<Ui><Frame name="TokenFrame"/></Ui>',
    ['Interface\\AddOns\\Blizzard_TokenUI\\Localization.lua']: '-- This file is executed at the end of addon load',
    ['Interface\\AddOns\\Blizzard_TalentUI\\Blizzard_TalentUI.toc']: '## Interface: 30300' + NL + '## LoadOnDemand: 1' + NL + 'Blizzard_TalentUI.lua' + NL,
  };
  return {
    __esModule: true,
    default: class {
      load(path: string): Promise<Uint8Array> {
        const text = FILES[path];
        return text === undefined
          ? Promise.reject(new Error('404 ' + path))
          : Promise.resolve(new TextEncoder().encode(text));
      }
    },
  };
});

describe('prefetchStartupAddOns', () => {
  it('keeps the addon with no ## LoadOnDemand and its files, and drops the one that has it', async () => {
    const addOns = await prefetchStartupAddOns(['Blizzard_TalentUI', 'Blizzard_TokenUI']);

    expect(addOns.map((addOn) => addOn.name)).toEqual(['Blizzard_TokenUI']);
    // In MANIFEST order -- `Localization.lua` last is the addon's own contract ("This file is executed
    // at the end of addon load" is that file's only line).
    expect(addOns[0].manifest.order).toEqual([
      'Blizzard_TokenUI.lua',
      'Blizzard_TokenUI.xml',
      'Localization.lua',
    ]);
    expect(addOns[0].manifest.texts.get('blizzard_tokenui.xml')).toContain('TokenFrame');
  });
});
