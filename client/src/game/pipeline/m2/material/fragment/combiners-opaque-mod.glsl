#pragma glslify: import('./common-header.glsl')

vec4 combinersOpaqueMod() {
  vec4 result;

  vec4 sampled0 = texture2D(textures[0], coordinates[0]);
  vec4 sampled1 = texture2D(textures[1], coordinates[1]);

  if (alphaKey == 1.0 && sampled0.a < 0.5) {
    discard;
  }

  result.rgb = sampled1.rgb * (vertexColor.rgb * sampled0.rgb * 2.0);
  result.a = vertexColor.a * sampled1.a * animatedTransparency;

  return result;
}

/*
!!ARBfp1.0
OPTION ARB_fog_linear;

TEMP R0;
TEMP R1;
TEX R0.xyz, fragment.texcoord[0], texture[0], 2D;
MUL R1.xyz, fragment.color.primary, R0;
TEX R0, fragment.texcoord[1], texture[1], 2D;
MUL result.color.xyz, R0, R1;
MUL result.color.w, fragment.color.primary, R0;
END
*/

void main() {
  vec4 result;

  result = combinersOpaqueMod();

  // Apply lighting and fog.
  result = finalizeColor(result);

  gl_FragColor = result;
}
