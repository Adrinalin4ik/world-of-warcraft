/**
 * A REAL `<ScrollFrame>` moves its child; a FAUX one must not budge.
 *
 * `methods/scroll.ts`' header called this "a real remaining gap -- this file does not move the scroll
 * child", which was harmless while every scrolling list in the client was faux (the handler recomputes a
 * row offset and no child ever moves). `QuestDetailScrollFrame` is a real one, so the gap became the
 * quest page's dead scroll.
 *
 * The faux arm is the guard the coordinator asked for, and it holds for a reason found in the client's
 * own files rather than by special-casing: a faux frame's rows are NOT descendants of its scroll child.
 * `SkillRankFrame1` sits outside `skillframe.xml`'s `<ScrollChild>` block, as do reputation's and the
 * spellbook's, so offsetting that child moves nothing drawable.
 */
import { Widget, WidgetRoot } from '../widget';

const VIEWPORT = { width: 1024, height: 768 };

/** A real scroll frame: rows INSIDE the scroll child, the way `QuestInfo_Display` reparents them. */
function realFrame() {
  const root = new WidgetRoot();
  const frame = new Widget('frame', 'Viewport');
  frame.setSize(300, 60);
  frame.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 0, y: 0 });
  root.root.add(frame);

  const child = new Widget('frame', 'ScrollChild');
  child.setSize(300, 300);
  child.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 0, y: 0 });
  frame.add(child);
  child.clippedBy = frame;

  const rows: Widget[] = [];
  for (let i = 0; i < 10; i += 1) {
    const row = new Widget('texture', `Row${i}`);
    row.sprite = 'Interface\Buttons\UI-Panel-Button-Up';
    row.setSize(280, 20);
    row.setAnchors({ point: 'TOPLEFT', relativeTo: 'ScrollChild', relativePoint: 'TOPLEFT', x: 0, y: -20 * i });
    child.add(row);
    rows.push(row);
  }
  return { root, frame, rows };
}

describe('a real ScrollFrame moves its child', () => {
  it('brings later rows into the viewport and takes earlier ones out', () => {
    const { root, frame, rows } = realFrame();

    const at0 = root.drawList(VIEWPORT);
    const visible0 = rows.filter((r) => at0.some((i) => i.widget === r)).map((r) => r.id);
    // A 60-unit viewport over 20-unit rows: the first three.
    expect(visible0).toEqual(['Row0', 'Row1', 'Row2']);

    // Scroll down by two rows, the way `SetVerticalScroll` does.
    frame.scrollOffset.y = 40;
    const at40 = root.drawList(VIEWPORT);
    const visible40 = rows.filter((r) => at40.some((i) => i.widget === r)).map((r) => r.id);
    expect(visible40).toEqual(['Row2', 'Row3', 'Row4']);

    // And the row now at the top really is drawn at the viewport's top edge, not merely present.
    const top = at40.find((i) => i.widget === rows[2]);
    expect(Math.round(top!.rect.top)).toBe(0);

    // THE COST: scrolling does not lengthen the draw list. Three rows visible either way.
    expect(at40.length).toBe(at0.length);
  });

  it('is inert for a faux frame, whose rows are not under its scroll child', () => {
    const root = new WidgetRoot();
    const frame = new Widget('frame', 'FauxViewport');
    frame.setSize(300, 60);
    frame.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 0, y: 0 });
    root.root.add(frame);

    // The scroll child a faux template declares -- present, and empty of rows.
    const child = new Widget('frame', 'FauxScrollChild');
    child.setSize(300, 900);
    child.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 0, y: 0 });
    frame.add(child);
    child.clippedBy = frame;

    // The row, a SIBLING of the scroll child -- which is where `SkillRankFrame1` actually lives.
    const row = new Widget('texture', 'FauxRow');
    row.sprite = 'Interface\Buttons\UI-Panel-Button-Up';
    row.setSize(280, 20);
    row.setAnchors({ point: 'TOPLEFT', relativeTo: 'FauxViewport', relativePoint: 'TOPLEFT', x: 0, y: 0 });
    frame.add(row);

    const before = root.drawList(VIEWPORT).find((i) => i.widget === row);
    frame.scrollOffset.y = 400;
    const after = root.drawList(VIEWPORT).find((i) => i.widget === row);

    // Unmoved and undropped: a faux list keeps working exactly as it does today.
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(Math.round(after!.rect.top)).toBe(Math.round(before!.rect.top));
    expect(Math.round(after!.rect.height)).toBe(20);
  });
});
