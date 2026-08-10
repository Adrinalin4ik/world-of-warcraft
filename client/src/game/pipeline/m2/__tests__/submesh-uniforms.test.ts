/**
 * The per-draw uniform push.
 *
 * @jest-environment node
 */
import * as THREE from 'three';

import {
  applyAnimatedUniformsBeforeRender,
  applyFadeAlphaBeforeRender,
  applyUniformsBeforeRender,
} from '../submesh';

/** An M2Material-shaped stub: the uniforms the handlers touch, plus the dirty flag three reads. */
function material(animationDef: any = null) {
  return {
    animationDef,
    uniformsNeedUpdate: false,
    uniforms: {
      fadeAlpha: { value: 1.0 },
      animatedTransparency: { value: 1.0 },
      animatedVertexColorRGB: { value: new THREE.Vector3(1, 1, 1) },
      animatedVertexColorAlpha: { value: 1.0 },
      animatedUVs: {
        value: [
          new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(),
        ],
      },
    },
  } as any;
}

/** An M2-shaped placement carrying its own sampled value slots. */
function placement(over: any = {}) {
  const m2: any = new THREE.Group();
  m2.uvAnimationValues = [];
  m2.transparencyAnimationValues = [];
  m2.vertexColorAnimationValues = [];
  Object.assign(m2, over);

  // The real hierarchy the walk-up has to traverse: batch mesh -> Submesh -> M2.
  const submesh = new THREE.Group();
  const mesh = new THREE.Mesh();
  submesh.add(mesh);
  m2.add(submesh);

  return { m2, mesh };
}

const uvValue = (x: number) => ({
  translation: [x, 0, 0],
  rotation: [0, 0, 0, 1],
  scaling: [1, 1, 1],
  matrix: new THREE.Matrix4().makeTranslation(x, 0, 0),
});

/** Invoke the installed handler exactly as three's renderer does. */
const draw = (mesh: any, mat: any) =>
  applyUniformsBeforeRender.call(mesh, null, null, null, null, mat, null);

describe('sparse uvAnimationIndices', () => {
  /**
   * The headline bug. `BatchManager` only assigns an op's entry when that op HAS a UV animation, so
   * the index array is sparse -- and the material is shared. Leaving an unset slot alone hands the
   * next placement the previous one's matrix.
   */
  it('resets a slot the drawn placement does not animate', () => {
    const mat = material({
      uvAnimationIndices: [undefined, 3],
      transparencyAnimationIndex: -1,
      vertexColorAnimationIndex: -1,
    });

    const a = placement({ uvAnimationValues: [, , , uvValue(0.25)] });
    draw(a.mesh, mat);
    expect(mat.uniforms.animatedUVs.value[1].elements[12]).toBeCloseTo(0.25);

    // Placement B animates nothing. Slot 1 must go back to identity, not keep A's scroll.
    const b = placement();
    mat.animationDef = {
      uvAnimationIndices: [],
      transparencyAnimationIndex: -1,
      vertexColorAnimationIndex: -1,
    };
    draw(b.mesh, mat);

    expect(mat.uniforms.animatedUVs.value[1].equals(new THREE.Matrix4())).toBe(true);
  });

  it('leaves an op whose index resolves to no value slot at identity', () => {
    const mat = material({
      uvAnimationIndices: [7],
      transparencyAnimationIndex: -1,
      vertexColorAnimationIndex: -1,
    });
    const { mesh } = placement();

    draw(mesh, mat);

    expect(mat.uniforms.animatedUVs.value[0].equals(new THREE.Matrix4())).toBe(true);
  });
});

/**
 * Without this flag three re-uploads a ShaderMaterial's uniforms only when the material CHANGES
 * between draws -- and it does not change between two placements of one model. Every placement after
 * the first would draw with the first one's values, which is the failure this whole task removes.
 */
describe('uniformsNeedUpdate', () => {
  it('is raised when a UV matrix is pushed', () => {
    const mat = material({
      uvAnimationIndices: [0],
      transparencyAnimationIndex: -1,
      vertexColorAnimationIndex: -1,
    });
    const { mesh } = placement({ uvAnimationValues: [uvValue(0.5)] });

    draw(mesh, mat);

    expect(mat.uniformsNeedUpdate).toBe(true);
  });

  it('is raised for an animated slot even when the matrix OBJECT is unchanged', () => {
    // The same placement drawn on two frames keeps one matrix object and rewrites it in place, so a
    // reference compare sees no change while the contents moved.
    const mat = material({
      uvAnimationIndices: [0],
      transparencyAnimationIndex: -1,
      vertexColorAnimationIndex: -1,
    });
    const { mesh } = placement({ uvAnimationValues: [uvValue(0.5)] });

    draw(mesh, mat);
    mat.uniformsNeedUpdate = false;
    draw(mesh, mat);

    expect(mat.uniformsNeedUpdate).toBe(true);
  });

  it('is raised when the fade alpha changes', () => {
    const mat = material();
    const { m2, mesh } = placement();
    m2.fadeAlpha = 0.4;

    draw(mesh, mat);

    expect(mat.uniforms.fadeAlpha.value).toBeCloseTo(0.4);
    expect(mat.uniformsNeedUpdate).toBe(true);
  });

  /**
   * The reason the raise is conditional: the flag re-uploads the material's ENTIRE uniform list, and
   * most M2 batches animate nothing and sit at a constant fade alpha.
   */
  it('stays down for a batch with nothing to say', () => {
    const mat = material({
      uvAnimationIndices: [],
      transparencyAnimationIndex: -1,
      vertexColorAnimationIndex: -1,
    });
    const { mesh } = placement();

    // The FIRST draw does change something: it swaps the material's own four freshly constructed
    // Matrix4s for the shared identity. That happens once per material, ever. Steady state is what
    // this test is about, so measure from the second draw.
    draw(mesh, mat);
    mat.uniformsNeedUpdate = false;

    draw(mesh, mat);
    expect(mat.uniformsNeedUpdate).toBe(false);
  });

  it('stays down on a redraw whose values are all identical', () => {
    const mat = material({
      uvAnimationIndices: [],
      transparencyAnimationIndex: 0,
      vertexColorAnimationIndex: -1,
    });
    const { mesh } = placement({ transparencyAnimationValues: [0.25] });

    draw(mesh, mat);
    expect(mat.uniformsNeedUpdate).toBe(true);

    mat.uniformsNeedUpdate = false;
    draw(mesh, mat);
    expect(mat.uniformsNeedUpdate).toBe(false);
  });
});

describe('null index guards', () => {
  /**
   * `BatchManager.stubDef()` leaves both indices `null` when the batch has no such animation, and
   * `null >= 0` is TRUE in JS -- so an unguarded test reads slot 0 and pushes another channel's
   * value.
   */
  it('does not treat a null transparency index as slot 0', () => {
    const mat = material({
      uvAnimationIndices: [],
      // What `M2Material` stores after its `?? -1`; the raw def value is `null`.
      transparencyAnimationIndex: -1,
      vertexColorAnimationIndex: -1,
    });
    const { mesh } = placement({ transparencyAnimationValues: [0.1] });

    draw(mesh, mat);

    expect(mat.uniforms.animatedTransparency.value).toBe(1.0);
  });

  it('does not treat a null vertex-colour index as slot 0', () => {
    const mat = material({
      uvAnimationIndices: [],
      transparencyAnimationIndex: -1,
      vertexColorAnimationIndex: -1,
    });
    const { mesh } = placement({
      vertexColorAnimationValues: [{ color: [1, 0, 0], alpha: 0.2 }],
    });

    draw(mesh, mat);

    expect(mat.uniforms.animatedVertexColorRGB.value.x).toBe(1);
    expect(mat.uniforms.animatedVertexColorRGB.value.y).toBe(1);
    expect(mat.uniforms.animatedVertexColorAlpha.value).toBe(1.0);
  });

  it('pushes a real index-0 channel', () => {
    const mat = material({
      uvAnimationIndices: [],
      transparencyAnimationIndex: 0,
      vertexColorAnimationIndex: 0,
    });
    const { mesh } = placement({
      transparencyAnimationValues: [0.5],
      vertexColorAnimationValues: [{ color: [0.1, 0.2, 0.3], alpha: 0.4 }],
    });

    draw(mesh, mat);

    expect(mat.uniforms.animatedTransparency.value).toBeCloseTo(0.5);
    expect(mat.uniforms.animatedVertexColorRGB.value.z).toBeCloseTo(0.3);
    expect(mat.uniforms.animatedVertexColorAlpha.value).toBeCloseTo(0.4);
  });
});

describe('the node walk', () => {
  it('finds the value slots two hops up, from the batch mesh', () => {
    const mat = material({
      uvAnimationIndices: [0],
      transparencyAnimationIndex: -1,
      vertexColorAnimationIndex: -1,
    });
    const { mesh } = placement({ uvAnimationValues: [uvValue(0.75)] });

    // The batch mesh itself carries none of these.
    expect((mesh as any).uvAnimationValues).toBeUndefined();

    draw(mesh, mat);

    expect(mat.uniforms.animatedUVs.value[0].elements[12]).toBeCloseTo(0.75);
  });

  it('leaves the uniforms alone for a mesh with no owning placement', () => {
    const mat = material({
      uvAnimationIndices: [0],
      transparencyAnimationIndex: 0,
      vertexColorAnimationIndex: -1,
    });
    const orphan = new THREE.Mesh();

    draw(orphan, mat);

    expect(mat.uniforms.animatedTransparency.value).toBe(1.0);
    expect(mat.uniformsNeedUpdate).toBe(false);
  });

  it('does nothing for a material carrying no animationDef', () => {
    const mat = material(null);
    const { mesh } = placement({ transparencyAnimationValues: [0.5] });

    expect(() => draw(mesh, mat)).not.toThrow();
    expect(mat.uniforms.animatedTransparency.value).toBe(1.0);
  });
});

describe('handler chaining', () => {
  it('runs BOTH pushes in one draw', () => {
    const mat = material({
      uvAnimationIndices: [],
      transparencyAnimationIndex: 0,
      vertexColorAnimationIndex: -1,
    });
    const { m2, mesh } = placement({ transparencyAnimationValues: [0.3] });
    m2.fadeAlpha = 0.6;

    draw(mesh, mat);

    expect(mat.uniforms.fadeAlpha.value).toBeCloseTo(0.6);
    expect(mat.uniforms.animatedTransparency.value).toBeCloseTo(0.3);
  });

  /**
   * `||` would short-circuit and skip the second push entirely once the first reported a change.
   */
  it('still runs the animated push when the fade push already reported a change', () => {
    const mat = material({
      uvAnimationIndices: [],
      transparencyAnimationIndex: 0,
      vertexColorAnimationIndex: -1,
    });
    const { m2, mesh } = placement({ transparencyAnimationValues: [0.3] });
    m2.fadeAlpha = 0.5;

    draw(mesh, mat);

    expect(mat.uniforms.animatedTransparency.value).toBeCloseTo(0.3);
  });

  it('binds `this` to the drawn mesh in each handler', () => {
    const mat = material({
      uvAnimationIndices: [0],
      transparencyAnimationIndex: -1,
      vertexColorAnimationIndex: -1,
    });
    const { m2, mesh } = placement({ uvAnimationValues: [uvValue(0.2)] });
    m2.fadeAlpha = 0.9;

    // Called with the SAME argument list three.js uses, and `this` bound to the mesh. Both handlers
    // reach their owner only by walking up from `this`, so a lost binding shows as no push at all.
    expect(applyFadeAlphaBeforeRender.call(mesh, null, null, null, null, mat, null)).toBe(true);
    expect(applyAnimatedUniformsBeforeRender.call(mesh, null, null, null, null, mat, null))
      .toBe(true);

    expect(mat.uniforms.fadeAlpha.value).toBeCloseTo(0.9);
    expect(mat.uniforms.animatedUVs.value[0].elements[12]).toBeCloseTo(0.2);
  });
});
