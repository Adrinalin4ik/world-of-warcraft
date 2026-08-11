import * as THREE from 'three';

import { createQuadMaterial } from '../material';

/**
 * THE BLACK SQUARE ROUND THE CAST BAR, guarded at its one load-bearing property.
 *
 * An ADD quad in the PREMULTIPLIED pass (the world UI, which renders to a transparent offscreen target and
 * composites it) must add COLOUR without accumulating DESTINATION ALPHA. three's `AdditiveBlending` with
 * `premultipliedAlpha` resolves to an un-separated `blendFunc(ONE, ONE)`, which applies to alpha too -- so
 * `CastingBarFrameSpark` (a 32x32 DXT1 texture with `alphaSize = 0`, opaque everywhere) saturated the
 * target's alpha to 1 while contributing ~0.05 of colour, and the composite then multiplied the world out
 * behind it: an opaque black square, taller than the 13-unit bar and riding along it. Verified live as a
 * before/after pair on :3000 (`t12c-BEFORE-crop.png` / `t12c-AFTER-crop.png`).
 *
 * The regression this guards is a silent one in the other direction too: reverting to `AdditiveBlending`
 * here still draws a plausible bar on the GLUE screens, which are not premultiplied, so nothing in the
 * login flow would show it.
 */
describe('the additive UI blend', () => {
  it('adds colour without writing destination alpha in the premultiplied pass', () => {
    const premultiplied = createQuadMaterial('ADD', true);

    // Colour adds.
    expect(premultiplied.blending).toBe(THREE.CustomBlending);
    expect(premultiplied.blendSrc).toBe(THREE.OneFactor);
    expect(premultiplied.blendDst).toBe(THREE.OneFactor);
    // Alpha does not: dstA = 0 * srcA + 1 * dstA.
    expect(premultiplied.blendSrcAlpha).toBe(THREE.ZeroFactor);
    expect(premultiplied.blendDstAlpha).toBe(THREE.OneFactor);

    // The straight-alpha glue pass keeps the plain preset: its destination is the opaque canvas and its
    // alpha is never read, so there is nothing to protect and no reason to pay for CustomBlending.
    expect(createQuadMaterial('ADD', false).blending).toBe(THREE.AdditiveBlending);
    expect(createQuadMaterial('ALPHA', true).blending).toBe(THREE.NormalBlending);
  });
});
