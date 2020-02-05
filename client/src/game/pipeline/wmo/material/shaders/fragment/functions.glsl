vec4 finalizeResult(in vec4 result) {
  // Fog
  result.rgb = mix(result.rgb, fog.rgb, fog.a);

  // Opacity
  // result.a *= materialParams.w;

  return result;
}
