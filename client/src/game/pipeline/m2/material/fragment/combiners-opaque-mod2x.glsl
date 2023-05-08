#pragma glslify: import('./common-header.glsl')

vec4 combinersOpaqueMod2x() {
  vec4 result;

  vec4 sampled0 = texture2D(textures[0], coordinates[0]);
  vec4 sampled1 = texture2D(textures[1], coordinates[1]);

  if (alphaKey == 1.0 && sampled0.a < 0.5) {
    discard;
  }

  result.rgb = sampled1.rgb * (sampled0.rgb * vertexColor.rgb);
  result.a = vertexColor.a * sampled1.a * animatedTransparency;

  result.rgb *= 4.0;

  return result;
}

void main() {
  vec4 result;

  result = combinersOpaqueMod2x();

  // Apply lighting and fog.
  result = finalizeColor(result);

  gl_FragColor = result;
}
