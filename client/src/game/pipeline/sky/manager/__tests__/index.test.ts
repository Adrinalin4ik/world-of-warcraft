import * as THREE from 'three';
import SkyManager from '..';

/**
 * `SkyManager` owns several sky objects that deliberately do NOT live in one group -- the glare
 * renders after the world, and the two backdrops replace each other -- so the rules about which of
 * them is visible when are spread across `setEnabled` and the per-frame update. These are the two
 * that a reader cannot infer from either site alone.
 */
const manager = () => {
  const scene = new THREE.Scene();
  const sky = new SkyManager(scene);
  // Reaching privates on purpose: these objects are internal by design, and the alternative is
  // widening the public surface for a test's benefit.
  return { sky, internals: sky as unknown as Record<string, { visible: boolean; isActive?: boolean }> };
};

/** `isActive` is a getter on both skybox classes, so it has to be shadowed rather than assigned. */
const setActive = (skybox: { isActive?: boolean }, active: boolean) => {
  Object.defineProperty(skybox, 'isActive', { value: active, configurable: true });
};

describe('SkyManager.setEnabled', () => {
  it('hides the glare too, not only the celestial group', () => {
    // The glare sits OUTSIDE `celestialGroup` so a skybox cannot suppress it (it renders after the
    // world). But "a skybox is active" and "the user turned the sky off" are different questions,
    // and hiding the group answered only the first: because `update()` early-returns while
    // disabled, the two flare quads kept their last resolved tint, scale and position and hung in
    // the sky, frozen, after the sky was switched off.
    const { sky, internals } = manager();

    sky.setEnabled(false);

    expect(internals.sunGlare.visible).toBe(false);
    expect(internals.moonGlare.visible).toBe(false);
    expect(internals.celestialGroup.visible).toBe(false);
  });

  it('brings the glare back with the rest of the sky', () => {
    const { sky, internals } = manager();

    sky.setEnabled(false);
    sky.setEnabled(true);

    expect(internals.sunGlare.visible).toBe(true);
    expect(internals.moonGlare.visible).toBe(true);
  });
});

describe('SkyManager backdrop precedence', () => {
  it('lets the WMO skybox win over the zone skybox', () => {
    // Both are opaque at the same renderOrder, so with both active and no tie-break whichever the
    // renderer happened to sort second would win -- differently from frame to frame. The building's
    // painted sky wins because that is what a WMO skybox IS: the sky it swaps in for the zone's own
    // while you are inside it.
    const { sky, internals } = manager();

    setActive(internals.wmoSkybox, true);
    setActive(internals.zoneSkybox, true);
    internals.zoneSkybox.visible = true;

    const camera = new THREE.PerspectiveCamera();
    sky.update(camera, 0, 1 / 60);

    expect(internals.zoneSkybox.visible).toBe(false);
  });

  it('leaves the zone skybox alone when no WMO skybox is active', () => {
    const { sky, internals } = manager();

    setActive(internals.wmoSkybox, false);
    setActive(internals.zoneSkybox, true);
    internals.zoneSkybox.visible = true;

    const camera = new THREE.PerspectiveCamera();
    sky.update(camera, 0, 1 / 60);

    expect(internals.zoneSkybox.visible).toBe(true);
  });
});

describe('SkyManager skybox suppression', () => {
  const camera = () => new THREE.PerspectiveCamera();

  it('lets a WMO skybox suppress the whole celestial pass', () => {
    // A MOSB cube is sealed and gap-free -- a real total replacement, which is what the reference's
    // King's Square capture shows (three draws, nothing else).
    const { sky, internals } = manager();

    setActive(internals.wmoSkybox, true);
    sky.update(camera(), 0, 1 / 60);

    expect(internals.celestialGroup.visible).toBe(false);
  });

  it('does NOT let a zone skybox suppress anything', () => {
    // The regression this guards, and it produced every symptom reported: a fully white sky in Eye
    // of the Storm, white behind Nagrand's wisps, and a lone star-field triangle floating in white
    // below the terrain. A LightSkybox model is a loose set of non-contiguous cloud/ray/stream quads
    // with real gaps (checked on NagrandSkyBox.m2's 87 batches) -- layers meant to draw OVER a sky,
    // not to replace one. Suppressing the backdrop for them leaves the gaps as bare canvas.
    const { sky, internals } = manager();

    setActive(internals.zoneSkybox, true);
    setActive(internals.wmoSkybox, false);
    sky.update(camera(), 0, 1 / 60);

    expect(internals.celestialGroup.visible).toBe(true);
  });
});
