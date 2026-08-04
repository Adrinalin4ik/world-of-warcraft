/**
 * MOHD header flags.
 *
 * `SKIP_ROOT_AMBIENT_COLOR` is 0x02's effect on `fixVertexColors` (it suppresses the ambient
 * subtraction). The same bit is documented as `use_unified_render_path`, and it has a second, larger
 * consequence -- see `UNIFIED_RENDER_PATH` below. Both names are kept because both effects are real
 * and the call sites read very differently.
 */
const flags = {
  SKIP_MOCV_ATTENUATION:        0x00001,
  SKIP_ROOT_AMBIENT_COLOR:      0x00002,

  /**
   * `use_unified_render_path` -- the same bit as `SKIP_ROOT_AMBIENT_COLOR`, named for its other
   * consequence: on this path MOCV is NOT the per-vertex shade multiplier, and the surface takes
   * plain scene lighting instead.
   *
   * A DELIBERATE DIVERGENCE from samples/benilla, which does not read MOHD flags for lighting at all
   * (verified by grep over `wmo/root.rs` and `wmo/group.rs`: the only MOHD field it touches is
   * `wmoID`). The evidence for reading it here, all measured in game on NIGHTELFSMALLHOUSE_WSG:
   *
   *   1. its MOCV parses correctly -- parallel to MOVT, BGRA, guard passes, `mocvUsable: true`;
   *   2. and is genuinely near-zero on the exterior shell (min 0, max exactly 127, 1837 of 2016
   *      vertices below byte 51), so `tex x mocv x lit` is black by arithmetic;
   *   3. attenuation is correctly skipped for it (0x01 is set) and its root ambient is honestly 0;
   *   4. it is the ONLY WMO in view carrying this bit -- flags 0xf against 0x5 on CTFORC_A,
   *      CTFNIGHTELF_A and ORCHUT_WSG, all of which render correctly;
   *   5. suppressing the MOCV multiply (via the shader's own unlit branch) renders it correctly.
   *
   * Only (5) and the flag's documented meaning explain (2) together: the artists left MOCV black
   * because the client does not read it on this path.
   */
  UNIFIED_RENDER_PATH:          0x00002
};

export default flags;
