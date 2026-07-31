void main() {
  vec4 result;

  // Branch for combiners. Both consume colors[0] -- the lit vertex colour the vertex stage computes.
  #if defined(COMBINERS_OPAQUE)
    result = combinersOpaque();
  #elif defined(COMBINERS_DIFFUSE)
    result = combinersDiffuse();
  #else
    // No combiner define: fall back to the plain texture rather than rendering nothing. This is the
    // one path where discarding the vertex colour is correct, because no combiner ran.
    result = texture2D(textures[0], coords[0]);
  #endif

  #if BLENDING_MODE == 0
    // Opaque geometry: force alpha to 1 so a texture's stray alpha cannot make it translucent.
    result.a = 1.0;
  #endif

  #if BLENDING_MODE == 1
    if (result.a < alphaTestValue) {
      discard;
    }
  #endif

  result = applyWmoLighting(result);

  result = finalizeResult(result);

  gl_FragColor = result;
}