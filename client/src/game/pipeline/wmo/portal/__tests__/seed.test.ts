/** @jest-environment node */
import { crossesDownRay, PORTAL_NEAR_PARALLEL, SNAP_WINDOW } from '../seed';

describe('constants', () => {
  it('carries the client epsilons verbatim', () => {
    expect(PORTAL_NEAR_PARALLEL).toBe(1.0e-4);
    expect(SNAP_WINDOW).toBe(0.1);
  });
});

describe('crossesDownRay', () => {
  it('crosses a horizontal portal the eye sits above', () => {
    // Plane normal points up; eye is 5 yd in front of it. A downward ray reaches it.
    expect(crossesDownRay(1, 5)).toBe(true);
  });

  it('does not cross a horizontal portal the eye sits below', () => {
    expect(crossesDownRay(1, -5)).toBe(false);
  });

  it('snaps a near-parallel (vertical) portal when the eye is inside the snap window', () => {
    // A vertical doorway is parallel to the downward ray: it counts as crossed only via the snap.
    expect(crossesDownRay(0, 0.05)).toBe(true);
    expect(crossesDownRay(0, -0.05)).toBe(true);
  });

  it('does not snap a near-parallel portal outside the snap window', () => {
    expect(crossesDownRay(0, 0.5)).toBe(false);
  });

  it('treats a normal-Z just under the near-parallel threshold as parallel', () => {
    expect(crossesDownRay(PORTAL_NEAR_PARALLEL / 2, 5)).toBe(false);
    expect(crossesDownRay(PORTAL_NEAR_PARALLEL / 2, 0.05)).toBe(true);
  });

  it('treats a normal-Z at the threshold as NOT parallel, so the side test decides', () => {
    expect(crossesDownRay(PORTAL_NEAR_PARALLEL, 5)).toBe(true);
    expect(crossesDownRay(PORTAL_NEAR_PARALLEL, -5)).toBe(false);
  });

  it('is sign-symmetric in the normal: a downward-facing plane still crosses from above', () => {
    // Only |normalZ| decides parallelism; the signed distance decides the side.
    expect(crossesDownRay(-1, 5)).toBe(true);
    expect(crossesDownRay(-1, -5)).toBe(false);
  });
});
