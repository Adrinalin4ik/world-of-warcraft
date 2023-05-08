#pragma glslify: import('./common-header.glsl')

vec4 combinersOpaqueAddAlpha() {
  vec4 result;

  vec4 sampled0 = texture2D(textures[0], coordinates[0]);
  vec4 sampled1 = texture2D(textures[1], coordinates[1]);

  if (alphaKey == 1.0 && sampled0.a < 0.5) {
    discard;
  }

  result.rgb = sampled0.rgb * (vertexColor.rgb * 2.0);
  result.rgb += (sampled1.rgb * sampled1.a);
  result.a = vertexColor.a * animatedTransparency;

  return result;
}

void main() {
  vec4 result;

  result = combinersOpaqueAddAlpha();

  // Apply lighting and fog.
  result = finalizeColor(result);

  gl_FragColor = result;
}
