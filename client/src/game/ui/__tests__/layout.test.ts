import {
  AUTHORED_HEIGHT,
  MAX_SCALE,
  resolveAnchors,
  screenScale,
  viewportUnits,
} from '../layout';

describe('screenScale', () => {
  it('is 1 at the authored height', () => {
    expect(screenScale(AUTHORED_HEIGHT)).toBe(1);
  });

  it('scales DOWN below the authored height -- there is no lower clamp', () => {
    // A floor of 1.0 would draw the 768-tall layout into a 677-tall window and drop the bottom-most
    // controls off the screen silently (benilla reproduced exactly this at WOW_WIN=1276x677).
    expect(screenScale(677)).toBeCloseTo(677 / 768);
    expect(screenScale(677)).toBeLessThan(1);
  });

  it('clamps above MAX_SCALE', () => {
    expect(screenScale(2160)).toBe(MAX_SCALE);
  });
});

describe('viewportUnits', () => {
  it('reports the window in logical units', () => {
    const units = viewportUnits({ width: 1920, height: 1080 });

    expect(units.scale).toBeCloseTo(1080 / 768);
    expect(units.height).toBeCloseTo(768);
    // Wider than the authored 4:3 -- a widescreen window reveals more width, it does not letterbox.
    expect(units.width).toBeCloseTo(1920 / (1080 / 768));
  });
});

describe('resolveAnchors', () => {
  const viewport = { width: 1024, height: 768 };

  it('centres a node on CENTER with no offset', () => {
    const rects = resolveAnchors(
      [{ id: 'panel', width: 200, height: 100, anchors: [{ point: 'CENTER', x: 0, y: 0 }] }],
      viewport,
    );

    expect(rects.get('panel')).toEqual({ left: 412, top: 334, width: 200, height: 100 });
  });

  it('offsets from TOPLEFT with +y meaning UP, as FrameXML does', () => {
    const rects = resolveAnchors(
      [{ id: 'logo', width: 100, height: 50, anchors: [{ point: 'TOPLEFT', x: 20, y: -30 }] }],
      viewport,
    );

    expect(rects.get('logo')).toEqual({ left: 20, top: 30, width: 100, height: 50 });
  });

  it('anchors BOTTOMRIGHT against the window corner', () => {
    const rects = resolveAnchors(
      [{ id: 'quit', width: 120, height: 40, anchors: [{ point: 'BOTTOMRIGHT', x: -10, y: 10 }] }],
      viewport,
    );

    expect(rects.get('quit')).toEqual({ left: 894, top: 718, width: 120, height: 40 });
  });

  it('sizes a node from two opposing anchors -- this is what setAllPoints needs', () => {
    const rects = resolveAnchors(
      [
        {
          id: 'backdrop',
          width: 0,
          height: 0,
          anchors: [
            { point: 'TOPLEFT', x: 0, y: 0 },
            { point: 'BOTTOMRIGHT', x: 0, y: 0 },
          ],
        },
      ],
      viewport,
    );

    expect(rects.get('backdrop')).toEqual({ left: 0, top: 0, width: 1024, height: 768 });
  });

  it('anchors relative to another node', () => {
    const rects = resolveAnchors(
      [
        { id: 'box', width: 200, height: 32, anchors: [{ point: 'TOPLEFT', x: 100, y: -100 }] },
        {
          id: 'label',
          width: 60,
          height: 12,
          anchors: [{ point: 'BOTTOMLEFT', relativeTo: 'box', relativePoint: 'TOPLEFT', x: 0, y: 4 }],
        },
      ],
      viewport,
    );

    // The label sits 4 units above the box's top edge, left edges flush.
    expect(rects.get('label')).toEqual({ left: 100, top: 84, width: 60, height: 12 });
  });

  it('resolves in dependency order regardless of input order', () => {
    const rects = resolveAnchors(
      [
        {
          id: 'child',
          width: 10,
          height: 10,
          anchors: [{ point: 'TOPLEFT', relativeTo: 'parent', relativePoint: 'TOPLEFT', x: 5, y: 0 }],
        },
        { id: 'parent', width: 100, height: 100, anchors: [{ point: 'TOPLEFT', x: 50, y: 0 }] },
      ],
      viewport,
    );

    expect(rects.get('child')!.left).toBe(55);
  });

  // characterselect.xml:437 -- `CharSelectRealmName`, the client's own three-anchor idiom: TOP at
  // y=-10, then LEFT at x=8, then RIGHT at x=-8, meaning "span the panel's width, ten units below
  // its top". LEFT and RIGHT each also pin the node's vertical CENTRE, and letting either of those
  // overwrite the explicit top put the realm name (and the Change Realm button anchored beneath it)
  // halfway down a 642-unit panel. An EDGE constraint beats a CENTRE one whatever the author order.
  it('an explicit edge beats a later centre constraint on the same axis', () => {
    const rects = resolveAnchors(
      [
        {
          id: 'panel',
          width: 260,
          height: 642,
          anchors: [{ point: 'TOPRIGHT', x: -5, y: -15 }],
        },
        {
          id: 'realmName',
          width: 1,
          height: 13,
          anchors: [
            { point: 'TOP', relativeTo: 'panel', relativePoint: 'TOP', x: 0, y: -10 },
            { point: 'LEFT', relativeTo: 'panel', relativePoint: 'LEFT', x: 8, y: 0 },
            { point: 'RIGHT', relativeTo: 'panel', relativePoint: 'RIGHT', x: -8, y: 0 },
          ],
        },
      ],
      viewport,
    );

    const panel = rects.get('panel')!;
    // Ten units below the panel's top edge, NOT the 314.5 a centre-derived top would give.
    expect(rects.get('realmName')).toEqual({
      left: panel.left + 8,
      top: panel.top + 10,
      width: panel.width - 16,
      height: 13,
    });
  });

  it('contains an anchor cycle instead of losing the rest of the screen', () => {
    // It used to throw, and `WidgetRoot#drawList` calls this from `GlueApp#tick`: one bad pair took
    // every other widget on the screen with it, every frame. `good` is the assertion that matters.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rects = resolveAnchors(
      [
        { id: 'a', width: 1, height: 1, anchors: [{ point: 'TOPLEFT', relativeTo: 'b', x: 0, y: 0 }] },
        { id: 'b', width: 1, height: 1, anchors: [{ point: 'TOPLEFT', relativeTo: 'a', x: 0, y: 0 }] },
        { id: 'good', width: 4, height: 4, anchors: [{ point: 'TOPLEFT', x: 7, y: -9 }] },
      ],
      viewport,
    );

    expect(rects.get('good')).toEqual({ left: 7, top: 9, width: 4, height: 4 });
    expect(rects.has('a')).toBe(true);
    expect(rects.has('b')).toBe(true);
    // Reported loudly and by name -- a silent fallback would hide the defect that made this necessary.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cycle.*a -> b/));
    warn.mockRestore();
  });
});
