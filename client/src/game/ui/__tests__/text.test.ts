/**
 * Word wrapping.
 *
 * jsdom here has no 2D canvas (the `canvas` package is installed, but `jest-environment-jsdom` bundles
 * its own jsdom, which does not find it), so measurement is stubbed with a fixed half-em advance per
 * character, scaled off the `font` string exactly as a real context would be. That makes this a test of
 * the wrapping RULES -- where a break may fall, and that wrapping stays opt-in -- rather than of any
 * typeface's metrics, which belong to the shipped TTFs and would change with them.
 */
import { wrapLines } from '../text';
import { FontSpec } from '../widget';

/** `GlueFontNormalLarge` as `GlueDialogText` inherits it: 450 wide, spacing 2 (gluedialog.xml). */
const DIALOG_TEXT: FontSpec = {
  family: 'FRIZQT',
  size: 18,
  color: '#ffc700',
  outline: true,
  align: 'CENTER',
  wrapWidth: 450,
  spacing: 2,
};

beforeAll(() => {
  // `text.ts` caches one context module-wide on first use, so this must be in place before any call.
  (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = function () {
    let font = '10px sans-serif';
    return {
      get font() {
        return font;
      },
      set font(value: string) {
        font = value;
      },
      measureText(text: string) {
        const px = Number(/^(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
        return { width: text.length * px * 0.5 };
      },
    };
  };
});

describe('wrapLines', () => {
  it('breaks a long string at spaces, and only when a width asks it to', () => {
    // The string the project owner's screenshot showed running off both edges of the screen, drawn as
    // one line: `RESPONSE_FAILED_TO_CONNECT` from the shipped gluestrings.lua.
    const text =
      'Failed to connect.  Please be sure that your computer is currently connected to the ' +
      'internet, and that no security features on your system might be blocking traffic.';

    const lines = wrapLines(text, DIALOG_TEXT, 1);

    expect(lines.length).toBeGreaterThan(1);
    // Every break falls at a space -- no word is split -- so rejoining gives back the same words.
    expect(lines.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
    lines.forEach((line) => expect(line.trim()).not.toHaveLength(0));
    // Each line fits the 450-unit budget at the stub's half-em advance.
    lines.forEach((line) => expect(line.length * 18 * 0.5).toBeLessThanOrEqual(450));

    // OPT-IN: without a `wrapWidth` the same string stays one line, so no existing single-line caption
    // on any glue screen changes how it measures.
    expect(wrapLines(text, { ...DIALOG_TEXT, wrapWidth: undefined }, 1)).toEqual([text]);
  });
});
