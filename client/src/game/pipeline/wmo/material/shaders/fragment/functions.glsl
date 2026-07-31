/**
 * The WMO surface law (samples/benilla, wow_model.wgsl WMO lane).
 *
 * WMO geometry genuinely IS fixed-function in the reference -- GL_LIGHTING with one directional
 * light -- so it takes a plain matte, NOT the order-2 irradiance lobe the M2 lane uses:
 *
 *   out = tex x clamp(MOCV x (ambient + diffuse x max(N.L, 0)))
 *
 * Two orderings matter and are easy to get backwards:
 *
 *  - MOCV multiplies the light terms INSIDE the clamp. Under GL_COLOR_MATERIAL the vertex colour is
 *    the material's ambient+diffuse, not a post-multiply on the result.
 *  - The light sum saturates FIRST, and the texture modulates the clamped result. The other order
 *    lets a bright term push a surface past its own fully-lit texture.
 */
vec3 wmoLitFactor(vec3 normal, vec3 mocv) {
  vec3 toLight = -normalize(sunParams.xyz);
  float incidence = max(dot(normalize(normal), toLight), 0.0);
  vec3 light = sunAmbientColor + sunDiffuseColor * incidence;
  return clamp(mocv * light, 0.0, 1.0);
}

vec4 applyWmoLighting(vec4 tex) {
  if (lightModifier <= 0.0) {
    return tex;
  }

  vec3 mocv = vertexColorOut.rgb;
  vec4 result = tex;

#if defined(INTERIOR) && BATCH_CLASS == 1
  // INT -- UNLIT by design. The baked vertex colours ARE the room's light: the artists' lamp,
  // forge, hearth and candle warmth, constant day and night. No exterior light reaches it, and the
  // reference commits no point lights to any WMO surface.
  //
  // MOCV ALPHA is an authored self-illumination mask, applied as `tex x MOCV x (1 + 4 x MOCV.a)`.
  // The literal 4 is read off the reference's interior pixel shader, and unlike the light sum above
  // this product is NOT pre-clamped -- it may legitimately overdrive to white. A fireplace surround
  // bakes alpha around 100/255, giving roughly x2.6. It is near zero everywhere unpainted, where
  // this collapses to the plain tex x MOCV it replaces.
  result.rgb = clamp(tex.rgb * mocv * (1.0 + 4.0 * vertexColorOut.a), 0.0, 1.0);
#elif defined(INTERIOR) && BATCH_CLASS == 2
  // TRANS -- the per-vertex lerp between the lit surface and that unlit bake. The reference draws
  // this as two passes (lit x SRC_ALPHA + unlit x (1 - SRC_ALPHA)); collapsed to one pass, the lit
  // factor is mix(1, lit, MOCV.a).
  vec3 lit = wmoLitFactor(worldNormal, mocv);
  result.rgb = tex.rgb * mix(vec3(1.0), lit, vertexColorOut.a);
#else
  // EXT -- an interior group's exterior-law batches, and every exterior group batch.
  result.rgb = tex.rgb * wmoLitFactor(worldNormal, mocv);
#endif

  return result;
}

vec4 finalizeResult(in vec4 result) {
  // Fog
  result.rgb = mix(result.rgb, fog.rgb, fog.a * materialParams.z);

  // Opacity
  result.a *= materialParams.w;

  return result;
}
