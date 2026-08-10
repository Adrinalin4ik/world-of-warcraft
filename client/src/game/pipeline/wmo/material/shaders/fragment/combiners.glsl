vec4 combinersOpaque() {
  vec4 sampled0 = texture2D(textures[0], coords[0]);

  vec4 result;
  result.rgb = sampled0.rgb;
  result.a = 1.0;

  return result;
}

vec4 combinersDiffuse() {
  vec4 sampled0 = texture2D(textures[0], coords[0]);

  vec4 result;
  result.rgb = sampled0.rgb;
  result.a = sampled0.a;

  return result;
}
