#pragma glslify: import('./common-header.glsl')

vec4 combinersModMod2x() {
  vec4 result;

  vec4 sampled0 = texture2D(textures[0], coordinates[0]);
  vec4 sampled1 = texture2D(textures[1], coordinates[1]);

  if (alphaKey == 1.0 && sampled0.a < 0.5) {
    discard;
  }

  result.rgb = sampled0.rgb * sampled1.rgb * vertexColor.rgb * 4.0;
  result.a = sampled0.a * sampled1.a * vertexColor.a * animatedTransparency;

  return result;
}

void main() {
  vec4 result;

  result = combinersModMod2x();

  // Apply lighting and fog.
  result = finalizeColor(result);

  gl_FragColor = result;
}
