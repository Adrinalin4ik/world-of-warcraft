/**
 * Screen-rect algebra for the WMO portal flood.
 *
 * The reference client does NOT carry a plane frustum through the portal graph -- it carries a 2-D
 * screen rectangle, intersects it with each portal's projected AABB, and kills the branch when the
 * rect collapses to zero area (samples/benilla `crates/benilla/src/wmo_portal/mod.rs`, VERIFIED
 * against WoW.exe 5875). That collapse is exactly why the Stormwind cathedral culls from the Trade
 * District but draws from the gates.
 *
 * Every constant here is the client's own, read from the binary. Do not round them.
 */

/** Minimum NDC extent for a narrowed rect to count as non-empty. Client `0x801360`. */
export const RECT_EPS = 0.001;

/** The `|w|` band below which a clip-space `w` is substituted before the perspective divide. */
export const W_CLAMP_BAND = 0.001;

/**
 * The substituted `w` -- POSITIVE regardless of the vertex's sign (client immediate `0x3727c5ac`).
 * A vertex with `w <= -W_CLAMP_BAND` is NOT clamped: it divides by its real negative `w`.
 */
export const W_CLAMP_SUB = 1.0e-5;

/** Eye-on-portal-plane band, WMO yards. Client `0x6b46f0` / `0x8029d0`. */
export const ON_PLANE_EPS = 0.01;

export interface ScreenRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The unrestricted window: the ordinary full-screen frustum. */
export const FULL_SCREEN_RECT: ScreenRect = Object.freeze({
  minX: -1, minY: -1, maxX: 1, maxY: 1,
}) as ScreenRect;

export function isCollapsed(rect: ScreenRect): boolean {
  return rect.maxX - rect.minX < RECT_EPS || rect.maxY - rect.minY < RECT_EPS;
}

/** The narrowed window, or null if the branch dies here. */
export function intersectRect(a: ScreenRect, b: ScreenRect): ScreenRect | null {
  const narrowed: ScreenRect = {
    minX: a.minX > b.minX ? a.minX : b.minX,
    minY: a.minY > b.minY ? a.minY : b.minY,
    maxX: a.maxX < b.maxX ? a.maxX : b.maxX,
    maxY: a.maxY < b.maxY ? a.maxY : b.maxY,
  };
  return isCollapsed(narrowed) ? null : narrowed;
}

/**
 * Clip a clip-space polygon against the near plane, returning the part in front of the eye.
 *
 * THIS IS NOT OPTIONAL, and leaving it out is what broke the first attempt at the rect flood.
 * A portal you are standing in the plane of has vertices on both sides of the eye. Projecting a
 * vertex with negative `w` divides by that negative value and flips it through the origin, so the
 * screen-space AABB of a mixed-sign polygon comes out SMALL and bounded where the true projection
 * is unbounded. The flood then collapses the branch and drops rooms that really are visible through
 * the doorway. The `w` clamp does not help: it only covers `w` near zero, not a polygon spanning it.
 *
 * Clipping first also makes the projection well-conditioned. In a WebGL perspective matrix
 * `w_clip = -z_view`, so every surviving vertex has `w >= near`, and no sign flip is possible.
 *
 * Sutherland-Hodgman against the OpenGL near plane `z = -w`, i.e. inside where `z + w > 0`.
 */
export function clipPolygonToNearPlane(
  vertices: ReadonlyArray<ArrayLike<number>>,
): number[][] {
  const count = vertices.length;
  if (count < 3) {
    return [];
  }

  const out: number[][] = [];
  const distance = (v: ArrayLike<number>) => v[2] + v[3];

  for (let i = 0; i < count; ++i) {
    const current = vertices[i];
    const next = vertices[(i + 1) % count];
    const dCurrent = distance(current);
    const dNext = distance(next);
    const currentInside = dCurrent > 0;
    const nextInside = dNext > 0;

    if (currentInside) {
      out.push([current[0], current[1], current[2], current[3]]);
    }

    // Crossing the plane in either direction contributes the intersection point.
    if (currentInside !== nextInside) {
      const t = dCurrent / (dCurrent - dNext);
      out.push([
        current[0] + (next[0] - current[0]) * t,
        current[1] + (next[1] - current[1]) * t,
        current[2] + (next[2] - current[2]) * t,
        current[3] + (next[3] - current[3]) * t,
      ]);
    }
  }

  return out.length >= 3 ? out : [];
}

/** Perspective divide with the client's `w` clamp. `clip` is `[x, y, z, w]`. */
export function ndcFromClip(clip: ArrayLike<number>): [number, number] {
  let w = clip[3];
  // Strict `<` on both sides: a `w` of exactly +/-W_CLAMP_BAND is left alone, and the substitute is
  // positive even for a small negative `w`.
  if (w > -W_CLAMP_BAND && w < W_CLAMP_BAND) {
    w = W_CLAMP_SUB;
  }
  return [clip[0] / w, clip[1] / w];
}

/** Screen-space AABB of a clip-space polygon, or null if degenerate. */
export function rectFromClipPolygon(
  vertices: ReadonlyArray<ArrayLike<number>>,
): ScreenRect | null {
  if (vertices.length < 3) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < vertices.length; ++i) {
    const [x, y] = ndcFromClip(vertices[i]);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const rect = { minX, minY, maxX, maxY };
  return isCollapsed(rect) ? null : rect;
}
