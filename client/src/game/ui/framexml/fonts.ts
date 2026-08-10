/**
 * FONT OBJECTS: `<Font name="GlueFontNormal" inherits="SystemFont_Outline_Med2" virtual="true">` and
 * the 56 others `gluefontstyles.xml` declares.
 *
 * A font object is a face, a height, a colour, an outline and optionally a justification -- NOT a
 * region. That is why it lives in its own registry (`FrameXmlRuntime.fonts`, a second
 * `TemplateRegistry`) rather than beside element templates: a font inherits a font and never a frame,
 * and `xml.ts#classify` files a `<Font>` by TAG before it ever looks at `virtual`, because all 57 of
 * the client's own carry `virtual="true"` -- that is simply how one is declared.
 *
 * This module is the ONE place a name turns into font values, and it exists as a module rather than as
 * a method on the loader because there are now two callers with nothing else in common: the loader,
 * resolving `<FontString inherits="...">` and `<NormalFont style="...">` at document-load time, and
 * the object model, answering a Lua `SetFontObject`/`SetNormalFontObject` at any time after
 * (`realmlist.lua:115-128` colours every realm row's name this way). Two copies of the merge rules
 * below would drift, and the drift would be silent.
 */
import { TemplateRegistry } from './templates';
import { XmlElement, absValue, attr, childrenNamed, colorOf } from './xml';

/** The font values a `<Font>` chain, or a `<FontString>` layered over one, comes out with. */
export interface FontResolution {
  file?: string;
  height?: number;
  /** The XML `outline=` vocabulary (`NONE`/`NORMAL`/`THICK`), NOT the Lua `SetFont` flags string. */
  outline?: string;
  color?: [number, number, number, number];
  justifyH?: string;
}

/** A live name -> font-values lookup, as the object model sees it (`MethodContext.fontObject`). */
export type FontObjectLookup = (name: string) => FontResolution | null;

/**
 * A registered `<Font>`, flattened through its whole `inherits=` chain. Null when no font object of
 * that name is registered -- which is a real answer, not a failure: on a `<FontString>` the same
 * attribute may name an element template instead, and the caller decides what that means.
 *
 * THE MERGE RULE, and it is the one that has cost this repo the most: `templates.ts#merge` appends the
 * INHERITED element's children first and the inheriting element's last, so for `<FontHeight>`,
 * `<Color>` and `<Shadow>` -- each of which may appear at several levels of one chain -- the LAST
 * occurrence is the override. Reading the first match silently gives you the root's value; that is
 * why every read below indexes `length - 1`.
 *
 * `<Shadow>` is read by nobody: `FontSpec` has an outline ring and no shadow channel, so a shadowed
 * font's shadow is dropped rather than approximated. Named here because the merge rule applies to it
 * identically and the next person to add the channel should not have to rediscover that.
 */
export function readFontObject(
  fonts: TemplateRegistry,
  name: string,
  warn: (message: string) => void,
): FontResolution | null {
  if (!fonts.has(name)) {
    return null;
  }
  // A synthetic `<Font inherits="name"/>` is the shortest way to ask `TemplateRegistry` for the
  // flattened chain: `expand` resolves the reference and merges inherited-first, so the values here
  // are already the whole chain with the leaf winning.
  const reference: XmlElement = {
    tag: 'Font',
    attrs: new Map([['inherits', name]]),
    children: [],
    body: '',
  };
  const warnings: string[] = [];
  const merged = fonts.expand(reference, warnings);
  warnings.forEach(warn);

  const resolution: FontResolution = {};
  const file = attr(merged, 'font');
  if (file !== undefined) {
    resolution.file = file;
  }
  const heights = childrenNamed(merged, 'FontHeight');
  if (heights.length > 0) {
    const height = absValue(heights[heights.length - 1]);
    if (height !== undefined) {
      resolution.height = height;
    }
  }
  const outline = attr(merged, 'outline');
  if (outline !== undefined) {
    resolution.outline = outline;
  }
  const colors = childrenNamed(merged, 'Color');
  if (colors.length > 0) {
    resolution.color = colorOf(colors[colors.length - 1]);
  }
  const justifyH = attr(merged, 'justifyH');
  if (justifyH !== undefined) {
    resolution.justifyH = justifyH;
  }
  return resolution;
}

/**
 * Whether an XML `outline=` value means "draw the ring".
 *
 * TWO VOCABULARIES, and conflating them was a real defect rather than a tidiness point. The XML
 * attribute takes `NONE`/`NORMAL`/`THICK` (`gluefonts.xml:32,43,53` -- every outlined system font is
 * `outline="NORMAL"`), while the Lua `SetFont(file, height, flags)` third argument takes
 * `OUTLINE`/`THICKOUTLINE`/`MONOCHROME`. `FONTSTRING.SetFont` tests `flags.includes('OUTLINE')`, which
 * is right for its own API and answers FALSE for the string `"NORMAL"` -- so handing it the XML value
 * raw dropped the outline ring from every font object in the manifest, `GlueFontNormal` included. The
 * translation belongs at the boundary, and it belongs here so both callers share it.
 */
export function isOutlined(outline: string | undefined): boolean {
  const value = (outline ?? '').trim().toUpperCase();
  return value !== '' && value !== 'NONE';
}

/** The same value as the Lua `SetFont` flags string, for the loader's one call through that door. */
export function outlineFlags(outline: string | undefined): string | undefined {
  if (outline === undefined) {
    return undefined;
  }
  if (!isOutlined(outline)) {
    return '';
  }
  return outline.trim().toUpperCase() === 'THICK' ? 'THICKOUTLINE' : 'OUTLINE';
}
