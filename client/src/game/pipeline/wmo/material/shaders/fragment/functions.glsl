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
    // F_UNLIT: the draw is tex x white. Faithfully receives no emission either -- with lighting off
    // the fixed-function GL_EMISSION term is dead.
    return tex;
  }

  vec4 result = tex;
  result.rgb = tex.rgb * wmoLitFactor(worldNormal, vertexColorOut.rgb);
  return result;
}

vec4 finalizeResult(in vec4 result) {
  // Fog
  result.rgb = mix(result.rgb, fog.rgb, fog.a * materialParams.z);

  // Opacity
  result.a *= materialParams.w;

  return result;
}
