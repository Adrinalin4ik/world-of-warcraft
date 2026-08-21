/**
 * The mouseover/target model brighten: the STACKING rule, which is the only part of it that can be
 * wrong without being visible.
 *
 * A screenshot answers "is it lit". It cannot answer "does it stay lit when the pointer leaves a unit
 * that is still the target", and that is the reference's own law -- a per-object reason bitmask where
 * bit 0 is target and bit 1 is mouseover, the two stack, "and the glow drops only when the last reason
 * clears" (`samples/benilla/.../target/highlight.rs:4-8`). One test, on that.
 */
import { HoverHighlight, HIGHLIGHT_LIFT, applyHighlight } from '../hover-highlight';

/** A model shaped like the two fields `applyHighlight` reads, with one batch per submesh. */
function model(ownsBatches = true) {
  const uniforms = { highlight: { value: 0 } };
  return {
    ownsBatches,
    path: 'TEST\\MODEL.M2',
    uniforms,
    submeshes: [{ children: [{ material: { uniforms, uniformsNeedUpdate: false } }] }],
  };
}

describe('the mouseover / target model brighten', () => {
  it('stacks hover and target, and drops only when the last reason clears', () => {
    const highlight = new HoverHighlight();
    const wolf = { model: model() };
    const boar = { model: model() };

    // Hovered: lit, at the client's own +64/255.
    highlight.setHovered(wolf);
    expect(wolf.model.uniforms.highlight.value).toBeCloseTo(64 / 255, 6);
    expect(HIGHLIGHT_LIFT).toBeCloseTo(0.2509804, 6);

    // Also targeted: ONE lift, not two -- the reason bitmask collapses to set membership.
    highlight.setTargeted(wolf);
    expect(wolf.model.uniforms.highlight.value).toBeCloseTo(64 / 255, 6);

    // The pointer moves to another unit. The wolf is still the target, so it STAYS lit; the boar
    // lights as well, because hover and target are two roots and not one.
    highlight.setHovered(boar);
    expect(wolf.model.uniforms.highlight.value).toBeCloseTo(64 / 255, 6);
    expect(boar.model.uniforms.highlight.value).toBeCloseTo(64 / 255, 6);

    // Target cleared: the wolf has no reason left and goes dark. The boar is still hovered.
    highlight.setTargeted(null);
    expect(wolf.model.uniforms.highlight.value).toBe(0);
    expect(boar.model.uniforms.highlight.value).toBeCloseTo(64 / 255, 6);

    // Pointer off the world: nothing is lit.
    highlight.setHovered(null);
    expect(boar.model.uniforms.highlight.value).toBe(0);

    // A model whose materials are SHARED with every other placement of its path is refused rather
    // than lit -- see the file's scope note.
    expect(applyHighlight(model(false), HIGHLIGHT_LIFT)).toBe(false);
  });
});
