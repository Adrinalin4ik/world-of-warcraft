#pragma glslify: import('./common-header.glsl')

vec4 combinersOpaque() {
  vec4 result;

  vec4 sampled0 = texture2D(textures[0], coordinates[0]);

  if (alphaKey == 1.0 && sampled0.a < 0.5) {
    discard;
  }

  result.rgb = sampled0.rgb * vertexColor.rgb * 2.0;
  result.a = vertexColor.a;

  return result;
}

void main() {
  vec4 result;

  result = combinersOpaque();

  // Apply lighting and fog.
  result = finalizeColor(result);

  gl_FragColor = result;
}
