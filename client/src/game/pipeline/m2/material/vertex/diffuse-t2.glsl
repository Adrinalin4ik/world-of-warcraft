
void main() {
	// GLSLIFY_COMMON_MAIN

	// c0 mapping (t2) -- the SECOND texcoord set into the FIRST (and only) coordinate slot.
	//
	// This is the whole content of the variant and it is easy to get subtly wrong, so it is pinned to
	// the shipped shader rather than to a guess. `blizzardry/extracted_data/shaders/Vertex/arbvp1/`
	// carries the real `.bls` for both names; their ARB text differs in exactly two instructions:
	//
	//   Diffuse_T1:  MOV R0.xy, vertex.attrib[6]   ...  DP4 result.texcoord[0].xy, R0, c[6..7]
	//   Diffuse_T2:  MOV R0.xy, vertex.attrib[7]   ...  DP4 result.texcoord[0].xy, R0, c[8..9]
	//
	// attrib[6]/attrib[7] are the M2 vertex's `textureCoords[0]`/`textureCoords[1]`, so T2 reads
	// `uv2`. Note the DESTINATION is `texcoord[0]` in both -- T2 is a one-texture-unit shader that
	// happens to source its coordinate from the second set, NOT a two-layer shader. Writing `uv` here
	// (or writing into `coordinates[1]`) compiles, draws, and is wrong.
	coordinates[0] = vec2(uv2);

	// c0 texture animation.
	//
	// `animatedUVs[0]`, and the reference's own index is deliberately NOT copied here. The `.bls`
	// reads texture-matrix slot 1 (`c[8..9]`) -- the slot keyed to texcoord set 2 -- whereas this
	// engine's `animatedUVs[i]` is keyed to OP index: `submesh.js#applyAnimatedUniformsBeforeRender`
	// fills slot i from `animationDef.uvAnimationIndices[i]`, and a T2 batch is single-op, so its one
	// UV animation only ever lands in slot 0. Reading slot 1 would read the identity matrix forever
	// and silently freeze any animated T2 batch.
	//
	// Which convention the reference actually intends is not settled by anything on disk, and it is
	// moot for every stage we load: measured across all eleven `UI_*` glue models, the only batches
	// that resolve to `Diffuse_T2` are UI_Human's two GROUNDSHADOW decals (submeshes 1 and 2), and
	// both carry an EMPTY uv-animation lookup -- so both matrices are identity either way.
	vec4 c0a = animatedUVs[0] * vec4(coordinates[0], 0, 1.0);
	coordinates[0] = c0a.xy / c0a.w;

  gl_Position = projectionMatrix * mvPosition;
}
