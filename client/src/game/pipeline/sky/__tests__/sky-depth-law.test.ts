/**
 * The sky depth law, enforced across every sky element at once.
 *
 * three.js draws every TRANSPARENT material after every OPAQUE one. `renderOrder` sorts only within
 * a pass -- it cannot lift a transparent object ahead of opaque geometry. So a transparent sky
 * element with `depthTest: false` draws after the world and ignores depth entirely, which is how
 * clouds ended up painting over mountains and buildings.
 *
 * The fix is the reference's own rule (`sky_order.rs`, "The depth law"): every sky fragment forces
 * the far depth and depth-tests against it, so it survives only where the depth buffer still holds
 * its cleared value -- exactly where no world geometry drew. The reference checks this the same way,
 * by asserting on the shader sources, and for the same reason: a shell radius silently becomes
 * load-bearing again the moment someone edits one of these materials.
 *
 * The opaque gradient dome is deliberately exempt: `transparent: false` puts it in the opaque pass
 * where its `renderOrder = -1000` really does draw it first, and the world paints over it.
 */
import * as THREE from 'three';
import CloudDome from '../clouds';
import CelestialBillboard from '../celestial/billboard';
import { buildStarMaterial } from '../celestial/stars';

/** Every transparent sky element, built the way its owner builds it. */
const transparentSkyElements = (): Array<{ name: string; material: THREE.ShaderMaterial }> => {
  const dome = new CloudDome();
  const billboard = new CelestialBillboard(new THREE.Texture(), { renderOrder: -1002 });
  // The white moon and moon02 (celestial-sky plan, Task 4) -- both configurations of the same shared
  // `CelestialBillboard`, so the law is exercised at their own renderOrder slots too.
  const whiteMoon = new CelestialBillboard(new THREE.Texture(), { renderOrder: -1001 });
  const moon02 = new CelestialBillboard(new THREE.Texture(), { renderOrder: -1000.5 });
  // Stars (Task 3, renderOrder -1003): not a CelestialBillboard (a multi-patch dome with no single
  // body direction of its own), so it builds its own depth-law material -- covered here rather than
  // re-deriving the rule for it.
  const stars = buildStarMaterial(new THREE.Texture());

  return [
    { name: 'CloudDome', material: dome.material as THREE.ShaderMaterial },
    { name: 'CelestialBillboard', material: billboard.material as THREE.ShaderMaterial },
    { name: 'WhiteMoon', material: whiteMoon.material as THREE.ShaderMaterial },
    { name: 'Moon02', material: moon02.material as THREE.ShaderMaterial },
    { name: 'Stars', material: stars },
  ];
};

describe('the sky depth law', () => {
  it('forces the far depth in every transparent sky fragment shader', () => {
    for (const { name, material } of transparentSkyElements()) {
      expect(material.fragmentShader).toContain('gl_FragDepth = 1.0;');
      // A message the next reader can act on, rather than a bare boolean.
      if (!material.fragmentShader.includes('gl_FragDepth = 1.0;')) {
        throw new Error(`${name}: no longer forces the far depth -- it will draw through terrain`);
      }
    }
  });

  it('depth-tests every transparent sky element, and writes depth in none of them', () => {
    for (const { name, material } of transparentSkyElements()) {
      expect(material.transparent).toBe(true);
      // The test is what lets terrain occlude a sky element drawn after the opaque pass.
      expect([name, material.depthTest]).toEqual([name, true]);
      // Writing would let sky elements occlude each other; the renderOrder ladder decides that.
      expect([name, material.depthWrite]).toEqual([name, false]);
    }
  });

  it('never lets a sky element write the framebuffer alpha channel', () => {
    // The white-fringe class (`d348889`): the canvas is composited over the page and three.js
    // requests a premultiplied alpha context, so any sub-1 framebuffer alpha adds (1 - a) of white.
    for (const { name, material } of transparentSkyElements()) {
      expect([name, material.blendSrcAlpha]).toEqual([name, THREE.ZeroFactor]);
      expect([name, material.blendDstAlpha]).toEqual([name, THREE.OneFactor]);
    }
  });
});
