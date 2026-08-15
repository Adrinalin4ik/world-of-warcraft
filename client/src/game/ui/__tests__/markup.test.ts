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

  it('leaves an inline texture visible rather than deleting it', () => {
    // NOT stripped: a silently deleted escape yields a line that looks right and is missing a symbol.
    const marked = parseMarkup('cost |TInterface\\Icons\\Foo:16|t here');
    expect(marked.plain).toBe('cost |TInterface\\Icons\\Foo:16|t here');
  });
});
