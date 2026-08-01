import * as THREE from 'three';
import { DecodeStream } from 'restructure';
import M2 from '../../../../wow-data-parser/m2';
import Skin from '../../../../wow-data-parser/m2/skin';
import Loader from '../../../net/loader';
import TextureLoader from '../../texture-loader';

/**
 * Shared M2 decode for the two "authored sky as a model" cases this client has (celestial-sky plan,
 * Task 6): the zone skybox (`LightSkybox.dbc`, Step 1) and the WMO skybox (`MOSB`, Step 2). Both are
 * "load a tiny static M2 and draw it as authored, camera-anchored, identity rotation" -- the same
 * treatment `celestial/stars.ts` already gives `Stars.m2` and, per benilla's `wmo_sky.rs` module doc,
 * the treatment the reference itself gives its WMO skybox (`CM2Model`'s matrix stays identity with a
 * ZEROED recentre vector -- the model's own local origin sits exactly at the eye).
 *
 * This does NOT go through `M2ManagerLite` -- see `stars.ts`'s own module doc for why: that manager's
 * loader is dead scaffolding that returns a hardcoded placeholder cube regardless of the path. This
 * file decodes the M2 + `.skin` directly with the same binary parsers `stars.ts` and
 * `pipeline/m2/loader.js` use.
 */

export type SkyboxBatch = {
  geometry: THREE.BufferGeometry;
  /** The batch's own texture path, resolved from the M2's texture-lookup table. Never empty --
   * batches whose texture does not resolve to a filename are dropped in `loadSkyboxBatches` rather
   * than kept with a blank path, since nothing could ever load for them anyway. */
  texturePath: string;
};

/**
 * Decode `path` (an M2) + its lowest-quality `.skin` into one [`SkyboxBatch`] per skin batch whose
 * submesh has any triangles and whose texture resolves to a real filename. Geometry uses the same
 * reduced engine swizzle `stars.ts` derives (negate X and Y, keep Z) -- these models are static, so
 * there is no bone/animation state to carry through it.
 *
 * Returns an empty array (never throws past the caller) when the model decodes to zero usable
 * batches; throws if the M2/skin themselves fail to load or decode, so the caller can log which path
 * failed rather than silently drawing nothing (the plan's Risk 6: "verify each loads before building
 * its consumer, and report any that do not resolve rather than silently falling back").
 */
export async function loadSkyboxBatches(path: string): Promise<SkyboxBatch[]> {
  const loader = new Loader();

  const raw = await loader.load(path);
  const data = M2.decode(new DecodeStream(Buffer.from(new Uint8Array(raw))));

  const quality = Math.max(0, data.viewCount - 1);
  const skinPath = path.replace(/\.m2/i, `0${quality}.skin`);
  const rawSkin = await loader.load(skinPath);
  const skinData = Skin.decode(new DecodeStream(Buffer.from(new Uint8Array(rawSkin))));

  const batches: SkyboxBatch[] = [];

  for (const batch of skinData.batches) {
    const submesh = skinData.submeshes[batch.submeshIndex];
    if (!submesh || submesh.triangleCount === 0) {
      continue;
    }

    const textureIndex = data.textureLookups[batch.textureLookup];
    const texture = data.textures[textureIndex];
    const texturePath: string = (texture && texture.filename) || '';
    if (!texturePath) {
      continue;
    }

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const remap = new Map<number, number>();

    for (let i = submesh.startTriangle; i < submesh.startTriangle + submesh.triangleCount; i++) {
      const vertexIndex = skinData.indices[skinData.triangles[i]];
      let local = remap.get(vertexIndex);
      if (local === undefined) {
        const vertex = data.vertices[vertexIndex];
        const [x, y, z] = vertex.position;
        // The reduced M2->engine swizzle (see stars.ts's module doc): negate X and Y, keep Z.
        positions.push(-x, -y, z);
        const uv = vertex.textureCoords[0];
        uvs.push(uv[0], uv[1]);
        local = remap.size;
        remap.set(vertexIndex, local);
      }
      indices.push(local);
    }

    if (positions.length === 0) {
      continue;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geometry.setIndex(indices);

    batches.push({ geometry, texturePath });
  }

  return batches;
}

/**
 * Build one `THREE.Mesh` per batch with the sky-authored-model material every skybox in this client
 * shares: unlit, textured, two-sided (the box is viewed from inside), and -- per this task's own "sky
 * depth law" note -- OPAQUE and exempt from the transparent half of the law, exactly like the gradient
 * dome (`sky/__tests__/sky-depth-law.test.ts`'s own carve-out). `transparent: false, depthWrite: false,
 * depthTest: false` mirrors `SkyCone`'s own material verbatim: the world always wins the depth battle
 * because the skybox never writes to the depth buffer, regardless of draw order, so there is no need
 * for a forced `gl_FragDepth` the way the transparent celestial elements need one.
 */
export function buildSkyboxMeshes(batches: SkyboxBatch[], renderOrder: number): THREE.Mesh[] {
  return batches.map(({ geometry, texturePath }) => {
    const material = new THREE.MeshBasicMaterial({
      map: TextureLoader.PLACEHOLDER,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });

    TextureLoader.load(texturePath)
      .then((texture: THREE.Texture) => {
        material.map = texture;
        material.needsUpdate = true;
      })
      .catch((error: unknown) => {
        console.error(`Skybox: failed to load texture ${texturePath}:`, error);
      });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    mesh.matrixAutoUpdate = false;
    return mesh;
  });
}
