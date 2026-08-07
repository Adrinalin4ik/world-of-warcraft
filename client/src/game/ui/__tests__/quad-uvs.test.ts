/**
 * A widget's texture sub-rect, in its own geometry.
 *
 * This is the one part of the tex-coord fix that is real logic rather than render state, so it is the
 * one part with a test. The defect it pins: sub-rects used to go onto the shared `THREE.Texture`'s
 * `offset`/`repeat`, and `GlueArt` hands the same texture object to every widget naming the same file
 * -- so the two rotate arrows on character select, which share
 * `Interface\Glues\CharacterCreate\UI-RotationRight-Big-Up` and differ only in that the LEFT one flips
 * it with `<TexCoords left="1.0" right="0" top="0" bottom="1.0"/>` (characterselect.xml:229-234), both
 * drew with whichever sub-rect was applied last. Both arrows pointed right.
 */
import * as THREE from 'three';

import { writeQuadUVs } from '../renderer';

/** The four `uv` pairs, in `PlaneGeometry`'s vertex order. */
function uvs(geometry: THREE.BufferGeometry): number[][] {
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const out: number[][] = [];
  for (let i = 0; i < uv.count; i += 1) {
    out.push([uv.getX(i), uv.getY(i)]);
  }
  return out;
}

describe('writeQuadUVs', () => {
  it('gives the flipped arrow its own mirrored uvs without touching the unflipped one', () => {
    // Two quads, as the pool holds them: one per widget id.
    const right = new THREE.PlaneGeometry(1, 1);
    const left = new THREE.PlaneGeometry(1, 1);

    // `CharacterSelectRotateRight` authors no <TexCoords>: the whole sheet, unmirrored.
    writeQuadUVs(right, null);
    // `CharacterSelectRotateLeft` authors left=1, right=0 -- u REVERSED, v as-is.
    writeQuadUVs(left, { u0: 1, v0: 0, u1: 0, v1: 1 });

    // Vertex order is left-bottom, right-bottom, left-top, right-top, with v = 0 the sheet's top row
    // (see `renderer.ts`). So the unflipped quad's left edge samples u = 0 and the flipped quad's
    // samples u = 1: the same art, mirrored.
    expect(uvs(right)).toEqual([
      [0, 1],
      [1, 1],
      [0, 0],
      [1, 0],
    ]);
    expect(uvs(left)).toEqual([
      [1, 1],
      [0, 1],
      [1, 0],
      [0, 0],
    ]);
  });
});
