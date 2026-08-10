/**
 * @jest-environment node
 */
import {
  CLICK_DRAG_THRESHOLD, createCameraControl, createPendingClicks, runLookSession,
} from '../rig';

const none = { left: false, right: false };
const still = { dx: 0, dy: 0 };
const drag = { dx: 50, dy: 0 };

/** A fresh rig plus its own click state, as a caller would hold them. */
function session() {
  return { rig: createCameraControl(), pending: createPendingClicks() };
}

describe('the two look modes', () => {
  it('turns the character on a right-drag', () => {
    const { rig, pending } = session();
    const out = runLookSession(rig, { left: false, right: true }, drag, none, pending);

    expect(rig.look).toBe('right');
    expect(out.turnsCharacter).toBe(true);
    expect(out.yawDelta).not.toBe(0);
  });

  it('engages the right look instantly on press, because turning must feel immediate', () => {
    const { rig, pending } = session();
    runLookSession(rig, { left: false, right: true }, still, none, pending);

    expect(rig.look).toBe('right');
  });

  it('orbits the camera on a left-drag without turning the character', () => {
    const { rig, pending } = session();

    // Left engages only once the cursor drags past the threshold, so a left CLICK stays available
    // for target selection.
    runLookSession(rig, { left: true, right: false }, still, none, pending);
    expect(rig.look).toBeNull();

    const out = runLookSession(
      rig, { left: true, right: false }, drag, { left: true, right: false }, pending,
    );
    expect(rig.look).toBe('left');
    expect(out.turnsCharacter).toBe(false);
    expect(out.yawDelta).not.toBe(0);
  });

  it('runs forward on both buttons and steers like a right-drag', () => {
    const { rig, pending } = session();
    const out = runLookSession(rig, { left: true, right: true }, drag, none, pending);

    expect(out.bothButtonsRun).toBe(true);
    expect(out.turnsCharacter).toBe(true);
  });
});

describe('click versus drag', () => {
  it('reads a short left press and release as a click', () => {
    const { rig, pending } = session();
    runLookSession(
      rig, { left: true, right: false }, { dx: CLICK_DRAG_THRESHOLD / 4, dy: 0 }, none, pending,
    );
    const out = runLookSession(rig, none, still, { left: true, right: false }, pending);

    expect(out.leftClick).toBe(true);
    expect(rig.look).toBeNull();
  });

  it('does not read a dragged left press as a click', () => {
    const { rig, pending } = session();
    runLookSession(rig, { left: true, right: false }, drag, none, pending);
    const out = runLookSession(rig, none, still, { left: true, right: false }, pending);

    expect(out.leftClick).toBe(false);
  });

  it('reads a right press and release that never turned as a context click', () => {
    const { rig, pending } = session();
    runLookSession(rig, { left: false, right: true }, still, none, pending);
    const out = runLookSession(rig, none, still, { left: false, right: true }, pending);

    expect(out.rightClick).toBe(true);
  });

  it('does not read a right turn as a context click', () => {
    const { rig, pending } = session();
    runLookSession(rig, { left: false, right: true }, drag, none, pending);
    const out = runLookSession(rig, none, still, { left: false, right: true }, pending);

    expect(out.rightClick).toBe(false);
  });

  it('cancels the pending left click when the right button joins in', () => {
    // Releasing out of a both-button run must never fire a spurious selection.
    const { rig, pending } = session();
    runLookSession(rig, { left: true, right: false }, still, none, pending);
    runLookSession(rig, { left: true, right: true }, still, { left: true, right: false }, pending);
    const out = runLookSession(rig, none, still, { left: true, right: true }, pending);

    expect(out.leftClick).toBe(false);
  });
});

describe('session hand-off', () => {
  it('hands the session to the remaining button when one of two releases', () => {
    // Vanilla keeps turning or orbiting seamlessly, cursor staying hidden throughout.
    const { rig, pending } = session();
    runLookSession(rig, { left: true, right: true }, drag, none, pending);
    expect(rig.look).not.toBeNull();

    runLookSession(rig, { left: true, right: false }, drag, { left: true, right: true }, pending);
    expect(rig.look).toBe('left');
  });

  it('ends the session when every button releases', () => {
    const { rig, pending } = session();
    runLookSession(rig, { left: false, right: true }, drag, none, pending);
    runLookSession(rig, none, still, { left: false, right: true }, pending);

    expect(rig.look).toBeNull();
  });

  it('does not rotate the camera while no session is active', () => {
    const { rig, pending } = session();
    const out = runLookSession(rig, none, drag, none, pending);

    expect(out.yawDelta).toBe(0);
    expect(rig.yaw).toBe(0);
  });
});

describe('the persistent orbit offset', () => {
  it('keeps a left-drag orbit offset after release', () => {
    // The vanilla auto-follow that swung the camera back behind the character while moving is
    // deliberately NOT ported: the camera stays where you put it.
    const { rig, pending } = session();
    runLookSession(rig, { left: true, right: false }, drag, none, pending);
    runLookSession(rig, { left: true, right: false }, drag, { left: true, right: false }, pending);
    const parked = rig.yaw;

    runLookSession(rig, none, still, { left: true, right: false }, pending);
    runLookSession(rig, none, still, none, pending);

    expect(rig.yaw).toBeCloseTo(parked, 9);
  });
});

describe('click state ownership', () => {
  it('is per caller, so two sessions cannot interfere', () => {
    const a = session();
    const b = session();

    runLookSession(a.rig, { left: true, right: false }, still, none, a.pending);
    const outB = runLookSession(b.rig, none, still, { left: true, right: false }, b.pending);

    expect(outB.leftClick).toBe(false);
  });
});
