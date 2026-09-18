// NOT `@jest-environment node`: `anim/world-clock`'s import chain installs a `window` diagnostic at
// module load (`uiGeometryCensus`), so the node environment fails to even load this file. jsdom is the
// project default and is what every other world test uses.
import { advanceEffectLifecycle, armEffectDecay, ANIM_HOLD, ANIM_DECAY } from '../effect-pose';
import { worldClock } from '../../pipeline/m2/anim/world-clock';

/**
 * WHICH LAYER THIS COVERS: the `Stand` -> `Hold` -> `Decay` handover, which is the half that leaves a
 * buff frozen in its birth pose if it is guessed. It says nothing about pixels or about the material
 * channels -- those are one unconditional call, and whether the shield dims is the owner's check.
 *
 * The spans are the aura lane's measured ones for Mana Shield: Stand 700 / Hold 633 / Decay 1100 ms.
 */
function stubModel(spans: Record<number, number>) {
  const armed: Array<{ id: number; at: number }> = [];
  const model: any = {
    modelAnim: {
      resolve: (id: number, _fallback: boolean) => (
        spans[id] === undefined ? null : { id, index: id, lengthMs: spans[id] }),
    },
    instanceAnim: {
      current: null as any,
      armedAtMs: 0,
      arm(seq: any, atMs: number) {
        this.current = seq;
        this.armedAtMs = atMs;
        armed.push({ id: seq.id, at: atMs });
      },
    },
  };
  return { model, armed };
}

describe('effect lifecycle handover', () => {
  it('holds the birth clip for its authored span, then arms Hold and settles', () => {
    // Mana Shield's measured triple.
    const { model, armed } = stubModel({ 0: 700, [ANIM_HOLD]: 633, [ANIM_DECAY]: 1100 });
    const t0 = worldClock.ms;
    // The birth, as `armBirth` arms it.
    model.instanceAnim.arm({ id: 0, index: 0, lengthMs: 700 }, t0);
    expect(armed).toEqual([{ id: 0, at: t0 }]);

    // MID-BIRTH: still `birth`, and nothing re-armed. The latch is the authored SPAN, not a loop flag
    // -- the reference fires one notification per span and is loop-flag-independent.
    model.instanceAnim.armedAtMs = worldClock.ms - 400;
    expect(advanceEffectLifecycle(model, 'birth')).toBe('birth');
    expect(armed).toHaveLength(1);

    // PAST THE SPAN: hands over to Hold 158 and settles, so it is not re-asked every frame.
    model.instanceAnim.armedAtMs = worldClock.ms - 800;
    expect(advanceEffectLifecycle(model, 'birth')).toBe('settled');
    expect(armed).toHaveLength(2);
    expect(armed[1].id).toBe(ANIM_HOLD);

    // Settled is terminal for this function -- a second call must not re-arm.
    expect(advanceEffectLifecycle(model, 'settled')).toBe('settled');
    expect(armed).toHaveLength(2);
  });

  it('parks on the birth clip when the model authors no Hold, and arms Decay only when present', () => {
    // THE REFERENCE'S "do nothing whatsoever": most effect models author no Hold, so the correct
    // outcome is to leave the birth clip playing rather than destroy or re-loop.
    const noHold = stubModel({ 0: 400 });
    noHold.model.instanceAnim.arm({ id: 0, index: 0, lengthMs: 400 }, worldClock.ms);
    noHold.model.instanceAnim.armedAtMs = worldClock.ms - 500;
    expect(advanceEffectLifecycle(noHold.model, 'birth')).toBe('settled');
    // Armed once, by the birth -- the handover added nothing.
    expect(noHold.armed).toHaveLength(1);

    // Decay: armed AND its span reported, which is the pair the reap needs. It used to read the span
    // and never play the clip.
    const withDecay = stubModel({ 0: 400, [ANIM_DECAY]: 1100 });
    expect(armEffectDecay(withDecay.model)).toBe(1100);
    expect(withDecay.armed).toHaveLength(1);
    expect(withDecay.armed[0].id).toBe(ANIM_DECAY);

    // No Decay authored is the reference's immediate-destroy gate: null, and nothing armed.
    const noDecay = stubModel({ 0: 400 });
    expect(armEffectDecay(noDecay.model)).toBeNull();
    expect(noDecay.armed).toHaveLength(0);
  });
});
