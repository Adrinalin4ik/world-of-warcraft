/**
 * The two escapes in the owner's backpack tooltip, and the invariant that protects the text layer.
 *
 * Happy path only: the colour run must be ZERO WIDTH (or every measured width in the UI shifts, which
 * is the accepted-work regression this whole design is arranged around), and the plural must select
 * off the preceding number the way `NUM_FREE_SLOTS` relies on.
 */
import { parseMarkup } from '../markup';

describe('FrameXML text escapes', () => {
  it('renders the owner\'s backpack tooltip strings', () => {
    // `BACKPACK_TOOLTIP` plus the binding hint, as `containerframe.lua` builds it.
    const title = parseMarkup('Backpack |cffffd200(B)|r');
    expect(title.plain).toBe('Backpack (B)');
    expect(title.spans).toEqual([
      { start: 9, end: 12, color: 'rgb(255, 210, 0)' },
    ]);

    // `NUM_FREE_SLOTS = "%d Empty |4Slot:Slots; (Total)"` -- globalstrings.lua:5215.
    expect(parseMarkup('6 Empty |4Slot:Slots; (Total)').plain).toBe('6 Empty Slots (Total)');
    expect(parseMarkup('1 Empty |4Slot:Slots; (Total)').plain).toBe('1 Empty Slot (Total)');
  });

  it('renders an item link as its bracketed name in the quality colour', () => {
    // The exact shape `container-bridge.ts#itemLink` builds, which is what a bag tooltip and a loot
    // row both carry -- a colour run WRAPPING a hyperlink.
    const link = parseMarkup('|cff9d9d9d|Hitem:7074:0:0:0:0:0:0:0:0:0:0|h[Chipped Claw]|h|r');
    expect(link.plain).toBe('[Chipped Claw]');
    expect(link.spans).toEqual([
      { start: 0, end: 14, color: 'rgb(157, 157, 157)' },
    ]);
  });

  it('leaves an inline texture visible rather than deleting it', () => {
    // NOT stripped: a silently deleted escape yields a line that looks right and is missing a symbol.
    const marked = parseMarkup('cost |TInterface\\Icons\\Foo:16|t here');
    expect(marked.plain).toBe('cost |TInterface\\Icons\\Foo:16|t here');
  });
});

/**
 * A LINK RUN IS LOCATED, not merely rendered.
 *
 * The body was always drawn -- that is what made an item link visible in chat. What was missing was
 * WHERE it landed, so no click could be attributed to it (`hit.ts#hyperlinkAt`). The offsets are into
 * the PLAIN text, because the escapes are zero-width and must never reach `measureText`.
 */
test('a hyperlink run is indexed into the plain text', () => {
  const { plain, links } = parseMarkup('says: |cff9d9d9d|Hitem:3299:0:0|h[Belt]|h|r ok');
  expect(plain).toBe('says: [Belt] ok');
  expect(links).toHaveLength(1);
  expect(links[0].link).toBe('item:3299:0:0');
  expect(links[0].text).toBe('[Belt]');
  expect(plain.slice(links[0].start, links[0].end)).toBe(links[0].text);
});
