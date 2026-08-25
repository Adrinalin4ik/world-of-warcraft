import { resolveSprite } from '../sprite';
import { Widget } from '../widget';
import type { FontSpec } from '../widget';
import type { DrawItem } from '../widget';

/**
 * A SCALED FRAME SCALES ITS TEXT -- asserted on the SPEC, not on pixels.
 *
 * `SetScale` grows a font string's rect, and that alone did nothing to the glyphs: a font string draws at
 * its rasterized size and is centred in its rect, never stretched to it. Raising the raster density would
 * also have done nothing, because `text.ts` reports the glyph box as `widest / pixelScale` -- a denser
 * raster of the same font divides by exactly as much as it gains. **The font size is what has to grow**,
 * and this checks that it does.
 *
 * The assertion is the spec handed to the font sheet rather than a measured width, and deliberately: a
 * width needs a real 2D context, jsdom has none (`text.ts#optionalMeasureContext` exists for that), and a
 * test that quietly measured 0 would pass whatever this code did.
 */
function itemFor(widget: Widget): DrawItem {
  return { widget, rect: { left: 0, top: 0, width: 300, height: 20 }, alpha: 1 };
}

function sourcesRecording(seen: FontSpec[]) {
  return {
    art: { texture: () => undefined, def: () => undefined },
    fonts: {
      get: (_text: string, spec: FontSpec) => {
        seen.push(spec);
        return null;
      },
    },
    solid: () => undefined,
  } as never;
}

test('a font string on a scaled frame rasterizes at a proportionally larger font', () => {
  const parent = new Widget('frame', 'parent');
  const label = new Widget('fontstring', 'label');
  parent.add(label);
  label.text = 'Elwynn Forest';
  label.font = {
    family: 'FRIZQT', size: 20, color: '#ffffff', outline: false, align: 'LEFT', spacing: 4,
  };

  const unscaled: FontSpec[] = [];
  resolveSprite(itemFor(label), 1, sourcesRecording(unscaled));
  expect(unscaled).toHaveLength(1);
  expect(unscaled[0].size).toBe(20);
  expect(unscaled[0].spacing).toBe(4);

  // The map's windowed mode is 0.573, and `SetScale` cascades -- so the label inherits it from the frame
  // above it without being scaled itself, which is the case that was broken.
  parent.setScale(0.5);
  const scaled: FontSpec[] = [];
  resolveSprite(itemFor(label), 1, sourcesRecording(scaled));
  expect(scaled).toHaveLength(1);
  expect(scaled[0].size).toBe(10);
  expect(scaled[0].spacing).toBe(2);
});
