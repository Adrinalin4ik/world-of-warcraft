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
 * **NOT THE CLIENT'S BEHAVIOUR, and not used by the portal flood. Kept for the record and its tests.**
 *
 * This carried a paragraph beginning "THIS IS NOT OPTIONAL". That was wrong and the reference says so
 * in as many words: the projection clips against "the four **side** planes of the view pyramid (there
 * is NO near-plane clip)" (`benilla-world/src/wmo_portal/mod.rs:789-798`). A near clip is what makes a
 * doorway the eye is close to degenerate and its room blink out, because the angle decides how many
 * vertices fall behind the plane.
 *
 * What the flood uses is `clipPolygonToSidePlanes` below. The two are not interchangeable: the side
 * clip discards a behind-the-eye vertex too, but replaces the edge through it with an interpolated
 * boundary point at/near `w = 0`, which `ndcFromClip`'s clamp then blows out -- that is the straddled
 * doorway staying open. A near clip removes the edge instead of moving it.
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

/**
 * **UNUSED, AND KEPT ONLY AS A RECORD OF WHY IT IS WRONG FOR PORTALS.**
 *
 * I added this to `projectToRect` and it collapsed the portals it was meant to widen: seven
 * `rect-collapse` outcomes in thirteen attempts, including the doorway into the very group whose
 * floor the owner was standing on. `w + x >= 0` is false for almost any vertex BEHIND the eye, since
 * `w` is negative there -- so it discards exactly the vertices `ndcFromClip`'s clamp exists to
 * handle, and those must survive for a straddled doorway to stay open.
 *
 * ---
 *
 * **SUTHERLAND-HODGMAN AGAINST THE FOUR SIDE PLANES -- and NOT against the near plane.**
 *
 * The reference's pairing, and both halves matter: "clip against the four **side** planes of the
 * view pyramid (there is NO near-plane clip)"
 * (`samples/benilla/crates/benilla-world/src/wmo_portal/mod.rs:789-798`).
 *
 * I removed the near clip on its own and shipped it, and the owner's next frame showed the cost: a
 * STRAIGHT HORIZONTAL screen-space edge with the world missing below it, the player's own legs drawn
 * past it. Geometry does not cut like that; a rect does. A vertex left behind the eye carries a large
 * negative `w`, its mirrored NDC lands far from the polygon, and because the rect is a min/max over
 * the vertices, that stray point can RAISE `minY` and slice a band off the bottom of the view. I even
 * wrote in that commit that the failure to watch for was a portal opening too WIDE. It was the
 * opposite.
 *
 * The side planes in clip space are `w + x >= 0`, `w - x >= 0`, `w + y >= 0`, `w - y >= 0`. Clipping
 * against them brings every surviving vertex inside the view pyramid laterally, so no mirrored point
 * can escape into the min/max -- while vertices behind the eye still survive, which is what the `w`
 * clamp in `ndcFromClip` is for and what keeps a straddled doorway wide open.
 */
export function clipPolygonToSidePlanes(
  vertices: ReadonlyArray<ArrayLike<number>>,
): number[][] {
  // `[axis, sign]`: the distance is `w + sign * v[axis]`.
  const planes: Array<[number, number]> = [[0, 1], [0, -1], [1, 1], [1, -1]];

  let poly: number[][] = vertices.map((v) => [v[0], v[1], v[2], v[3]]);

  for (let p = 0; p < planes.length; ++p) {
    const [axis, sign] = planes[p];
    const count = poly.length;
    if (count < 3) {
      return [];
    }

    const out: number[][] = [];
    for (let i = 0; i < count; ++i) {
      const current = poly[i];
      const next = poly[(i + 1) % count];
      const dCurrent = current[3] + sign * current[axis];
      const dNext = next[3] + sign * next[axis];
      const currentInside = dCurrent >= 0;
      const nextInside = dNext >= 0;

      if (currentInside) {
        out.push(current);
      }
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
    poly = out;
  }

  return poly.length >= 3 ? poly : [];
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
