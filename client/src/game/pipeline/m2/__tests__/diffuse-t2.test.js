import M2 from '..';
import M2Material from '../material';

// The `Diffuse_T2` gap, and the two things about it that a test can actually hold.
//
// Shader OUTPUT is not usefully unit-testable in jsdom -- there is no GL context and no rasterizer --
// so the budget goes where the bug actually lived: the shader-name -> table-entry mapping, and the
// vertex ATTRIBUTE the entry depends on. Both of those are plain data.
//
// What went wrong is worth stating, because it is the shape of failure these two assertions cover.
// `BatchManager.shaderNamesFromSingleOpTable` names `Diffuse_T2` for an explicit T2 texture mapping;
// `M2Material.VERTEX_SHADERS` had no such key; `assignShaders` therefore left `vertexShader`
// undefined; and three's `WebGLProgram` throws on that, taking down the whole `sceneView.render()`
// traversal rather than one batch. `UI_Human` -- character select's own stage -- has two such batches.
//
// The trap the first assertion guards is subtler than the absence was: `Diffuse_T2` is a ONE-unit
// shader that sources its single coordinate from the SECOND texcoord set. Writing `uv` there compiles,
// links, draws something plausible, and is wrong. The shipped `.bls` settles it -- see
// `material/vertex/diffuse-t2.glsl` for the two-instruction diff against `Diffuse_T1`.

describe('Diffuse_T2', () => {
  it('resolves to a vertex shader that reads the SECOND texcoord set', () => {
    const source = M2Material.VERTEX_SHADERS['Diffuse_T2'];

    expect(typeof source).toBe('string');

    // `coordinates[0]` -- the one coordinate slot a single-unit shader writes -- comes from `uv2`.
    expect(source).toMatch(/coordinates\[0\]\s*=\s*vec2\(uv2\)/);
    // And never from `uv`, which is the whole difference from `Diffuse_T1`.
    expect(source).not.toMatch(/coordinates\[\d\]\s*=\s*vec2\(uv\)/);
    // The shared main body spliced in, so this is a complete program and not just the variant body.
    expect(source).toContain('gl_Position');
  });

  it('gets a `uv2` attribute from the geometry builder', () => {
    // `createSubmeshGeometry` touches no instance state, so it can be driven directly. One triangle,
    // with a second texcoord set deliberately DIFFERENT from the first -- the previous code pushed
    // only the first set, and GL fed the shader a constant (0, 0) for the attribute it never got.
    //
    // Non-zero on purpose for a second reason: the builder only uploads slot 1 when the set carries
    // something (see its comment for why), so an all-zero fixture would pass this test for the wrong
    // reason.
    const vertex = (u, v, u2, v2) => ({
      position: [u, v, 0],
      normal: [0, 0, 1],
      boneIndices: [0, 0, 0, 0],
      boneWeights: [255, 0, 0, 0],
      textureCoords: [[u, v], [u2, v2]],
    });

    const vertices = [vertex(0, 0, 0.25, 0.5), vertex(1, 0, 0.5, 0.75), vertex(0, 1, 0.75, 1)];
    const geometry = M2.prototype.createSubmeshGeometry.call(
      null,
      { startTriangle: 0, triangleCount: 3 },
      [0, 1, 2],
      [0, 1, 2],
      vertices,
    );

    const uv = geometry.getAttribute('uv');
    const uv2 = geometry.getAttribute('uv2');

    expect(uv2).toBeDefined();
    expect(uv2.count).toBe(uv.count);
    expect([uv2.getX(0), uv2.getY(0)]).toEqual([0.25, 0.5]);
    // Not a copy of the first set, which is what a silent fallback would have produced.
    expect([uv.getX(0), uv.getY(0)]).toEqual([0, 0]);
  });
});
