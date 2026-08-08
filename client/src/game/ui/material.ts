/**
 * The two glue blend modes.
 *
 * Unlit, depth-test off, drawn in the order the draw list dictates. ADD exists because a lot of
 * glue art is authored to glow (the reference needed a dedicated additive UI material for the same
 * reason: benilla `glue/add_material.rs`).
 */
import * as THREE from 'three';

import { Blend, TexCoords } from './widget';

export function createQuadMaterial(blend: Blend): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: blend === 'ADD' ? THREE.AdditiveBlending : THREE.NormalBlending,
    // Premultiplied would double-darken the client's straight-alpha art.
    premultipliedAlpha: false,
    // DOUBLE-SIDED, and not by laziness. The UI's orthographic camera is Y-DOWN (`top = 0`,
    // `bottom = height`), which makes the projection's Y scale negative — a mirror. A mirror
    // reverses triangle winding, and three.js only compensates for winding flips coming from an
    // object's own world matrix determinant, never from the camera's projection. So under
    // `FrontSide` every UI quad presents its back face and is culled: draw calls are issued,
    // triangles are counted, and not one pixel lands. Depth testing is already off here, so there is
    // nothing to gain from single-sided culling anyway.
    side: THREE.DoubleSide,
  });
}

/**
 * Point a material's map at a sub-rectangle of its sheet.
 *
 * No V flip. Two conventions cancel: `TextureLoader` creates every texture with `flipY = false`
 * (three.js cannot flip a compressed upload), so image row 0 is `v = 0`; and the UI's orthographic
 * camera is Y-DOWN, which puts the quad's `v = 0` edge at the TOP of the screen. Introduce a flip
 * here and every sprite draws upside down.
 */
export function applyTexCoords(
  material: THREE.MeshBasicMaterial,
  texCoords: TexCoords | null,
): void {
  const map = material.map;
  if (!map) {
    return;
  }

  if (!texCoords) {
    map.offset.set(0, 0);
    map.repeat.set(1, 1);
    return;
  }

  map.offset.set(texCoords.u0, texCoords.v0);
  map.repeat.set(texCoords.u1 - texCoords.u0, texCoords.v1 - texCoords.v0);
}
