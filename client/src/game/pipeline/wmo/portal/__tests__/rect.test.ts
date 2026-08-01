/** @jest-environment node */
import {
  FULL_SCREEN_RECT,
  intersectRect,
  isCollapsed,
  ndcFromClip,
  rectFromClipPolygon,
  RECT_EPS,
  W_CLAMP_BAND,
  W_CLAMP_SUB,
} from '../rect';

describe('constants', () => {
  it('carries the client epsilons verbatim', () => {
    expect(RECT_EPS).toBe(0.001);
    expect(W_CLAMP_BAND).toBe(0.001);
    expect(W_CLAMP_SUB).toBe(1.0e-5);
  });
});

describe('intersectRect', () => {
  it('narrows to the overlap', () => {
    const a = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    const b = { minX: 0, minY: -0.5, maxX: 0.5, maxY: 0.5 };
    expect(intersectRect(a, b)).toEqual({ minX: 0, minY: -0.5, maxX: 0.5, maxY: 0.5 });
  });

  it('returns null when the rects do not overlap at all', () => {
    const a = { minX: -1, minY: -1, maxX: -0.5, maxY: 1 };
    const b = { minX: 0.5, minY: -1, maxX: 1, maxY: 1 };
    expect(intersectRect(a, b)).toBeNull();
  });

  it('returns null when the overlap collapses below the epsilon in X', () => {
    const a = { minX: -1, minY: -1, maxX: 0, maxY: 1 };
    const b = { minX: -0.0005, minY: -1, maxX: 1, maxY: 1 };
    expect(intersectRect(a, b)).toBeNull();
  });

  it('returns null when the overlap collapses below the epsilon in Y', () => {
    const a = { minX: -1, minY: -1, maxX: 1, maxY: 0 };
    const b = { minX: -1, minY: -0.0005, maxX: 1, maxY: 1 };
    expect(intersectRect(a, b)).toBeNull();
  });

  it('keeps an overlap exactly at the epsilon', () => {
    const a = { minX: -1, minY: -1, maxX: 0, maxY: 1 };
    const b = { minX: -RECT_EPS, minY: -1, maxX: 1, maxY: 1 };
    expect(intersectRect(a, b)).not.toBeNull();
  });

  it('is the identity against the full-screen rect for an inner rect', () => {
    const inner = { minX: -0.25, minY: -0.25, maxX: 0.25, maxY: 0.25 };
    expect(intersectRect(FULL_SCREEN_RECT, inner)).toEqual(inner);
  });

  it('narrows monotonically through a chain of portals', () => {
    // The property the whole flood depends on: a rect can only ever shrink.
    let rect: any = FULL_SCREEN_RECT;
    for (const step of [
      { minX: -0.8, minY: -0.8, maxX: 0.8, maxY: 0.8 },
      { minX: -0.5, minY: -0.9, maxX: 0.9, maxY: 0.5 },
      { minX: -0.4, minY: -0.4, maxX: 0.4, maxY: 0.4 },
    ]) {
      const next = intersectRect(rect, step);
      expect(next).not.toBeNull();
      expect(next!.maxX - next!.minX).toBeLessThanOrEqual(rect.maxX - rect.minX + 1e-12);
      expect(next!.maxY - next!.minY).toBeLessThanOrEqual(rect.maxY - rect.minY + 1e-12);
      rect = next;
    }
    expect(rect).toEqual({ minX: -0.4, minY: -0.4, maxX: 0.4, maxY: 0.4 });
  });
});

describe('isCollapsed', () => {
  it('is true below the epsilon and false at it', () => {
    expect(isCollapsed({ minX: 0, minY: 0, maxX: 0.0005, maxY: 1 })).toBe(true);
    expect(isCollapsed({ minX: 0, minY: 0, maxX: RECT_EPS, maxY: 1 })).toBe(false);
  });
});

describe('ndcFromClip w clamping', () => {
  it('divides by w normally well outside the band', () => {
    expect(ndcFromClip([2, 4, 0, 4])).toEqual([0.5, 1]);
  });

  it('substitutes a POSITIVE w for a small NEGATIVE w inside the band', () => {
    // |w| < 0.001 -> substitute +1e-5, regardless of the vertex's sign.
    const [x] = ndcFromClip([1, 0, 0, -0.0005]);
    expect(x).toBeCloseTo(1 / W_CLAMP_SUB, 3);
    expect(x).toBeGreaterThan(0);
  });

  it('does NOT clamp a w of exactly -0.001, because the band test is strict', () => {
    const [x] = ndcFromClip([1, 0, 0, -0.001]);
    expect(x).toBeCloseTo(-1000, 6);
  });

  it('does NOT clamp a w of exactly +0.001', () => {
    const [x] = ndcFromClip([1, 0, 0, 0.001]);
    expect(x).toBeCloseTo(1000, 6);
  });
});

describe('rectFromClipPolygon', () => {
  it('takes the screen-space AABB of the projected polygon', () => {
    const rect = rectFromClipPolygon([
      [-1, -1, 0, 2],  // -0.5, -0.5
      [1, -1, 0, 2],   //  0.5, -0.5
      [1, 1, 0, 2],    //  0.5,  0.5
      [-1, 1, 0, 2],   // -0.5,  0.5
    ]);
    expect(rect).toEqual({ minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 });
  });

  it('returns null for fewer than three vertices', () => {
    expect(rectFromClipPolygon([[0, 0, 0, 1], [1, 1, 0, 1]])).toBeNull();
  });

  it('returns null when the projected polygon is degenerate', () => {
    const rect = rectFromClipPolygon([
      [0, 0, 0, 1],
      [0.0001, 0, 0, 1],
      [0.0001, 0.0001, 0, 1],
    ]);
    expect(rect).toBeNull();
  });
});
