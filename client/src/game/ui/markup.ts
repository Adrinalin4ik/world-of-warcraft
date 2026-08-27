/**
 * FrameXML TEXT ESCAPES -- the `|`-prefixed markup the client's own strings carry.
 *
 * Every string the runtime rasterizes went to the canvas verbatim before this file, so
 * `BACKPACK_TOOLTIP .. " |cffffd200(B)|r"` printed its own colour codes and
 * `NUM_FREE_SLOTS = "%d Empty |4Slot:Slots; (Total)"` (`globalstrings.lua:5215`) printed
 * `|4Slot:Slots;` instead of choosing a form. Both are the owner's screenshot.
 *
 * ## The set, CENSUSED from the served FrameXML rather than recalled
 *
 * Counted over the 134 `.lua` files `framexml.toc` lists, as served by the asset host:
 *
 * | escape | hits | meaning                                                      |
 * |--------|------|--------------------------------------------------------------|
 * | `|h`   | 222  | hyperlink body/close (two per link)                           |
 * | `|r`   | 194  | close the innermost colour run                                |
 * | `|c`   | 182  | open a colour run, `|cAARRGGBB`                               |
 * | `|n`   | 145  | line break                                                    |
 * | `|H`   | 111  | hyperlink open, `|H<type>:<args>|h[text]|h`                   |
 * | `|4`   |  78  | plural selection, `|4singular:plural;`                        |
 * | `|T`   |  31  | inline texture open, `|T<path>:<h>[:...]|t`                   |
 * | `|t`   |  25  | inline texture close                                          |
 *
 * The `.xml` files carry one `|c`/`|r` pair between them and nothing else. **`||` -- the escape for a
 * literal pipe -- occurs ZERO times in FrameXML**, but it is still handled here because a chat line or
 * a server-sent string can contain one and the alternative is misreading it as an escape.
 *
 * **`|1`, `|2` and `|3-<case>(...)` -- the declension escapes -- occur ZERO times**, because they are
 * ruRU/koKR grammar and this is the enUS build. They are named as gaps below rather than assumed
 * absent, since the realm this client talks to is Russian-hosted and may send them.
 *
 * ## What is rendered and what is NAMED
 *
 * Rendered here: `|c`/`|r`, `|n`, `|4`, `||`, and a hyperlink's BRACKETED BODY (`|H...|h[Name]|h` ->
 * `[Name]`, taking whatever colour encloses it -- which is exactly how an item link draws, since
 * `container-bridge.ts#itemLink` wraps the link in the quality colour).
 *
 * **NOT rendered, and deliberately NOT stripped: `|T...|t`.** An inline texture is an image spliced
 * into a line of text, and this rasterizer draws glyphs onto a 2D context with no notion of an image
 * run. Deleting it would produce a line that looks right and is missing a symbol -- the exact failure
 * `notImplemented` exists to prevent -- so the token is LEFT VISIBLE and the gap is named into the
 * load report. The same for the declension escapes.
 *
 * ## Why the offsets matter
 *
 * `text.ts` measures, wraps and justifies on the VISIBLE text. A colour code is zero-width, so it must
 * not reach `measureText` at all -- otherwise `|cffffd200` would count nine characters toward a wrap
 * budget and shift every measured width, which would regress the tooltip sizing and the grid snap that
 * are owner-confirmed. So `parseMarkup` returns the plain text plus colour spans INDEXED INTO THAT
 * PLAIN TEXT, and the raster re-associates them line by line.
 */
import { warnOnce, notImplemented } from './framexml/lua/methods/region';

/** A colour run over `plain`, half-open `[start, end)`. */
export interface ColorSpan {
  start: number;
  end: number;
  /** A CSS colour the 2D context accepts. Alpha from the escape's `AA` byte is carried through. */
  color: string;
}

/**
 * A HYPERLINK over `plain`, half-open `[start, end)`.
 *
 * `link` is the payload between `|H` and the first `|h` -- `item:3299:0:0:...` or `player:Gdsh` --
 * which is exactly what the client's `<OnHyperlinkClick>` calls `link`, and what `SetItemRef`
 * (`itemref.lua`) parses to decide between a tooltip and a whisper. `text` is the bracketed body it
 * is passed alongside, `[Ragged Leather Belt]` included brackets.
 *
 * INDEXED INTO `plain`, for the reason the header gives for colour spans: the escapes are
 * zero-width, so nothing about them may reach `measureText`. A click is mapped back by measuring
 * prefixes of `plain` -- see `hit.ts#hyperlinkAt`.
 */
export interface LinkSpan {
  start: number;
  end: number;
  /** The `|H` payload, without the `|H` or the `|h`. */
  link: string;
  /** The bracketed body as drawn, which is the handler's second argument. */
  text: string;
}

export interface Markup {
  /** The text as it is measured, wrapped and drawn. */
  plain: string;
  /** Colour runs over `plain`, in order, non-overlapping (see `parseMarkup`). */
  spans: ColorSpan[];
  /**
   * Hyperlink runs over `plain`, in document order.
   *
   * Collected because a link that cannot be located cannot be CLICKED: the bracketed body was
   * already drawn (that is what made an item link visible at all), but where it sits in the line was
   * thrown away, so no click could ever be attributed to it.
   */
  links: LinkSpan[];
}

/**
 * The two escapes this rasterizer cannot draw, declared through the same factory the Lua method
 * tables use so the load report names them alongside every other gap.
 *
 * CONSTRUCTED LAZILY, and that is not a style choice -- it is a real import cycle.
 * `region.ts` imports `text.ts` (for `measureText`), `text.ts` imports this file, and this file needs
 * `region.ts`'s factory. Calling `notImplemented` at module scope ran while `region.ts` was still
 * evaluating, so its `notImplementedNames` Set did not exist yet and every suite that reaches the
 * loader died with `Cannot access 'notImplementedNames' before initialization`. Deferring the call to
 * the first string that actually carries one of these escapes breaks the cycle at load time while
 * still registering the name -- by then every module is evaluated.
 */
let inlineTextureGap: (() => unknown) | null = null;
let declensionGap: (() => unknown) | null = null;

function nameInlineTextureGap(): void {
  if (inlineTextureGap === null) {
    inlineTextureGap = notImplemented(
      '|T inline texture escape',
      'an inline texture is an image run inside a line of text; ui/text.ts rasterizes glyphs onto a '
      + '2D context and has no image-run concept, so the token is left visible rather than deleted',
    ) as unknown as () => unknown;
  }
  inlineTextureGap();
}

function nameDeclensionGap(): void {
  if (declensionGap === null) {
    declensionGap = notImplemented(
      '|1/|2/|3 declension escape',
      'ruRU/koKR grammatical case selection; zero occurrences in the enUS FrameXML this client '
      + 'serves, and no case table exists to select from',
    ) as unknown as () => unknown;
  }
  declensionGap();
}

/** `AARRGGBB` -> a CSS colour. The alpha byte is honoured; it is `ff` in nearly every client string. */
function cssColor(hex: string): string | null {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) {
    return null;
  }
  const a = parseInt(hex.slice(0, 2), 16);
  const r = parseInt(hex.slice(2, 4), 16);
  const g = parseInt(hex.slice(4, 6), 16);
  const b = parseInt(hex.slice(6, 8), 16);
  return a === 0xff ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

/**
 * The number `|4` selects on: the LAST run of digits in the visible text BEFORE the escape.
 *
 * That is the client's rule and it is why the escape can sit anywhere in the sentence --
 * `NUM_FREE_SLOTS` formats `%d` first and the escape reads it back. Singular only on exactly 1; a
 * count of 0 takes the plural, which is what "0 Empty Slots" reads as in the real client.
 *
 * No preceding number at all -> plural, stated rather than silently singular: every censused use site
 * is preceded by a formatted count, so a missing one means the caller has not substituted yet and the
 * plural is the form that reads correctly for the general case.
 */
function pluralIsSingular(plainSoFar: string): boolean {
  const matches = plainSoFar.match(/\d+/g);
  if (matches === null || matches.length === 0) {
    return false;
  }
  return Number(matches[matches.length - 1]) === 1;
}

/**
 * Split a FrameXML string into the text that is drawn and the colour runs over it.
 *
 * Colour nesting follows the client: `|c` pushes and `|r` pops. A `|r` with nothing to pop returns to
 * the font's own colour, which is what the base `spec.color` already is, so it simply closes the open
 * span. Spans are emitted non-overlapping and in order -- the raster walks them linearly.
 */
/**
 * The RAW range of a complete hyperlink that ENDS at `index`, colour wrapper included -- or null.
 *
 * **A HYPERLINK IS ONE CHARACTER TO AN EDITOR, and this is what makes it one.** The owner: deleting a
 * linked item "вместо того чтобы удалить целиком залинкованный блок, он удаляет посимвольно, показывая
 * id предмета". Both halves of that are the same fact: the box stores the RAW escaped string and
 * per-character deletion eats the closing `|h` first, which leaves a malformed escape that
 * `parseMarkup` can no longer hide -- so the id surfaces. The engine deletes the whole run in one
 * press and never shows the inside of a link.
 *
 * WALKED BACKWARDS FROM THE END because that is the only end an editor is at: an optional `|r`, the
 * closing `|h`, the body, the opening `|h`, the `|H` payload, and an optional `|cAARRGGBB`. Each piece
 * is required except the two marked optional, and a missing one answers null rather than guessing a
 * boundary -- half a link deleted is worse than a character deleted.
 *
 * `index` is EXCLUSIVE, the same convention a caret has: `caret` characters precede it.
 */
export function linkRunEndingAt(text: string, index: number): { start: number; end: number } | null {
  let at = Math.max(0, Math.min(index, text.length));
  const end = at;
  // An optional trailing `|r`, which every link this client builds carries.
  if (text.slice(at - 2, at) === '|r') {
    at -= 2;
  }
  // The closing `|h`. Without it this is not the end of a link.
  if (text.slice(at - 2, at) !== '|h') {
    return null;
  }
  at -= 2;
  // The body, back to the `|h` that opens it.
  const bodyStart = text.lastIndexOf('|h', at - 1);
  if (bodyStart === -1) {
    return null;
  }
  // The `|H` payload.
  const open = text.lastIndexOf('|H', bodyStart - 1);
  if (open === -1) {
    return null;
  }
  let start = open;
  // An optional `|cAARRGGBB` immediately before it -- ten characters, and only if it is really there.
  if (start >= 10 && text.slice(start - 10, start - 8) === '|c') {
    start -= 10;
  }
  return { start, end };
}

/**
 * How many characters of `plain` correspond to the first `rawIndex` characters of `text`.
 *
 * **THE CARET LIVES IN THE RAW STRING AND IS DRAWN OVER THE PLAIN ONE, and nothing bridged the two.**
 * The owner: "курсор улетает после вставки". An inserted item link is ~60 raw characters and about 8
 * visible ones, so the caret was measured over the escapes and landed far to the right of the text it
 * belongs to.
 *
 * THROUGH `parseMarkup` ITSELF, over a prefix, rather than a second walk of the escape rules. Two
 * copies of that walk would drift, and this one is exactly consistent with the parse that produced
 * the glyphs -- including at a truncated escape, where the prefix parses as literal text and the
 * caret sits after the characters that are actually drawn.
 *
 * Called once per caret placement (a blink, twice a second, for one focused box), not per frame.
 */
export function plainIndexOf(text: string, rawIndex: number): number {
  if (text.indexOf('|') === -1) {
    return Math.max(0, Math.min(rawIndex, text.length));
  }
  return parseMarkup(text.slice(0, Math.max(0, Math.min(rawIndex, text.length)))).plain.length;
}

export function parseMarkup(text: string): Markup {
  // Fast path, and it is the overwhelmingly common one: no escapes at all means the caller gets the
  // identical string back and every downstream measurement is bit-for-bit what it was before this
  // file existed.
  if (text.indexOf('|') === -1) {
    return { plain: text, spans: [], links: [] };
  }

  let plain = '';
  const spans: ColorSpan[] = [];
  const links: LinkSpan[] = [];
  /** Open `|c` runs, innermost last. Each entry is the colour and where it started in `plain`. */
  const stack: Array<{ color: string; start: number }> = [];

  const closeTop = (): void => {
    const top = stack.pop();
    if (top === undefined || top.start === plain.length) {
      return;
    }
    spans.push({ start: top.start, end: plain.length, color: top.color });
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '|') {
      plain += ch;
      i += 1;
      continue;
    }

    const code = text[i + 1];

    // `||` -- a literal pipe. Zero occurrences in FrameXML; see the header.
    if (code === '|') {
      plain += '|';
      i += 2;
      continue;
    }

    // `|cAARRGGBB` -- open a colour run.
    if (code === 'c') {
      const hex = text.substr(i + 2, 8);
      const color = cssColor(hex);
      if (color !== null) {
        // A nested `|c` ends the enclosing run's span at this point; the enclosing colour resumes
        // when the inner one is popped, which `closeTop` re-opens below.
        const enclosing = stack[stack.length - 1];
        if (enclosing !== undefined && enclosing.start !== plain.length) {
          spans.push({ start: enclosing.start, end: plain.length, color: enclosing.color });
        }
        stack.push({ color, start: plain.length });
        i += 10;
        continue;
      }
      // A malformed `|c` is not an escape. Fall through and print it.
    }

    // `|r` -- close the innermost colour run.
    if (code === 'r') {
      closeTop();
      const enclosing = stack[stack.length - 1];
      if (enclosing !== undefined) {
        // The enclosing run resumes from here.
        enclosing.start = plain.length;
      }
      i += 2;
      continue;
    }

    // `|n` -- a line break. `wrapLines` already splits on `\n`, so this becomes one.
    if (code === 'n') {
      plain += '\n';
      i += 2;
      continue;
    }

    // `|4singular:plural;`
    if (code === '4') {
      const end = text.indexOf(';', i + 2);
      if (end !== -1) {
        const body = text.slice(i + 2, end);
        const colon = body.indexOf(':');
        if (colon !== -1) {
          plain += pluralIsSingular(plain) ? body.slice(0, colon) : body.slice(colon + 1);
          i = end + 1;
          continue;
        }
      }
      // Unterminated: print it rather than swallowing the rest of the string.
    }

    // `|H<type>:<args>|h[text]|h` -- render the bracketed body under whatever colour encloses it.
    if (code === 'H') {
      const bodyStart = text.indexOf('|h', i + 2);
      if (bodyStart !== -1) {
        const bodyEnd = text.indexOf('|h', bodyStart + 2);
        if (bodyEnd !== -1) {
          const body = text.slice(bodyStart + 2, bodyEnd);
          // WHERE the body landed, so a click can be attributed to it. The payload is everything
          // between `|H` and the first `|h`, which is what the handler receives as `link`.
          links.push({
            start: plain.length,
            end: plain.length + body.length,
            link: text.slice(i + 2, bodyStart),
            text: body,
          });
          plain += body;
          i = bodyEnd + 2;
          continue;
        }
      }
    }

    // `|T...|t` -- NOT rendered and NOT stripped. See the header.
    if (code === 'T') {
      const end = text.indexOf('|t', i + 2);
      nameInlineTextureGap();
      if (end !== -1) {
        plain += text.slice(i, end + 2);
        i = end + 2;
        continue;
      }
    }

    // `|1`, `|2`, `|3-<case>(...)` -- declension. Named, left visible.
    if (code === '1' || code === '2' || code === '3') {
      nameDeclensionGap();
      plain += ch;
      i += 1;
      continue;
    }

    // Anything else beginning with `|` is not an escape this client's own files use. Print it, and
    // say so once -- a silently dropped character is how a string renders plausibly and wrongly.
    if (code !== undefined) {
      warnOnce(`markup: unrecognised escape '|${code}' left visible`);
    }
    plain += ch;
    i += 1;
  }

  // Any run still open at the end of the string closes there. FrameXML omits the final `|r` often
  // enough that treating it as an error would drop the colour on real strings.
  while (stack.length > 0) {
    closeTop();
  }

  spans.sort((a, b) => a.start - b.start);
  return { plain, spans, links };
}

/**
 * The colour runs covering `[start, end)` of the plain text, as consecutive pieces that tile the
 * whole range -- uncoloured gaps included, reported with `color: null` so the caller uses the font's
 * own colour. Returns a single null-coloured piece when nothing is coloured, which is the case the
 * raster takes its unchanged single-`fillText` path for.
 */
export function runsFor(
  spans: ColorSpan[],
  start: number,
  end: number,
): Array<{ start: number; end: number; color: string | null }> {
  const pieces: Array<{ start: number; end: number; color: string | null }> = [];
  let at = start;
  for (const span of spans) {
    if (span.end <= start || span.start >= end) {
      continue;
    }
    const from = Math.max(span.start, start);
    const to = Math.min(span.end, end);
    if (from > at) {
      pieces.push({ start: at, end: from, color: null });
    }
    pieces.push({ start: from, end: to, color: span.color });
    at = to;
  }
  if (at < end) {
    pieces.push({ start: at, end, color: null });
  }
  return pieces.length === 0 ? [{ start, end, color: null }] : pieces;
}
