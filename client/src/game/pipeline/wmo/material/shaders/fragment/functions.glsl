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
 *
 * The interior WINDOW law (MOMT 0x20; samples/benilla wow_model.wgsl, wmo-interior-night-light).
 *
 * An interior-group batch flagged WINDOW swaps GL_LIGHT0 for a brighter pair: ambient AND diffuse
 * both become the MIDPOINT of the direct and ambient bands, with ambient lifted a further 16/255
 * saturating. Folding the warm direct band in at full weight is what makes an interior pane read
 * bright and warm in daylight instead of taking the flat interior ambient -- and it still tracks
 * time of day. The exterior drawer has no WINDOW machinery, so exterior batches never take this.
 */
vec3 wmoLitFactor(vec3 normal, vec3 mocv) {
  vec3 toLight = -normalize(sunParams.xyz);
  float incidence = max(dot(normalize(normal), toLight), 0.0);

  vec3 ambient = sunAmbientColor;
  vec3 diffuse = sunDiffuseColor;

#if defined(INTERIOR)
  if (windowFlag > 0.0) {
    vec3 midpoint = 0.5 * (sunDiffuseColor + sunAmbientColor);
    ambient = midpoint + vec3(16.0 / 255.0);
    diffuse = midpoint;
  }
#endif

  vec3 light = ambient + diffuse * incidence;
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
  // TRANS: emission rides the lit pass, weighted by the same MOCV alpha that weights the lerp.
  vec3 emission = sidnColor * (sidnNight * vertexColorOut.a);
  result.rgb = tex.rgb * clamp(mix(vec3(1.0), lit, vertexColorOut.a) + emission, 0.0, 1.0);
#else
  // EXT -- an interior group's exterior-law batches, and every exterior group batch.
  // Emission at full weight -- never multiplied by MOCV, added INSIDE the clamp alongside the lit
  // terms, exactly where glMaterialfv(GL_EMISSION) sits in the fixed-function pipeline.
  vec3 emission = sidnColor * sidnNight;
  result.rgb = tex.rgb * clamp(wmoLitFactor(worldNormal, mocv) + emission, 0.0, 1.0);
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
