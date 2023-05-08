#pragma glslify: import('./common-header.glsl')

vec4 combinersOpaqueMod2xNAAlphaOld() {
  vec4 result;

  vec4 sampled0 = texture2D(textures[0], coordinates[0]);
  vec4 sampled1 = texture2D(textures[1], coordinates[1]);

  if (alphaKey == 1.0 && sampled0.a < 0.5) {
    discard;
  }

  vec4 r0 = sampled1;
  vec4 r1 = sampled0;

  r0.rgb *= r1.rgb;
  r1.rgb = -r0.rgb * 2.0 + r1.rgb;
  r0.rgb += r0.rgb;
  r0.rgb = r1.a * r1.rgb + r0.rgb;
  r0.rgb *= vertexColor.a * 0.5;
  r0.rgb *= 2.0;

  result.rgb = r0.rgb;
  result.a = vertexColor.a * animatedTransparency;

  return result;
}

vec4 combinersOpaqueMod2xNAAlpha() {
  vec4 result;

  vec4 sampled0 = texture2D(textures[0], coordinates[0]);
  vec4 sampled1 = texture2D(textures[1], coordinates[1]);

  if (alphaKey == 1.0 && sampled0.a < 0.5) {
    discard;
  }

  vec4 r0 = sampled0;
  vec4 r1 = sampled1;

  r1.rgb *= r0.rgb;
  r1.rgb *= 2.0;
  r0.rgb += -r1.rgb;
  r0.rgb = (r0.a * r0.rgb) + r1.rgb;

  result.rgb = r0.rgb * vertexColor.rgb * 2.0;
  result.a = vertexColor.a * animatedTransparency;

  return result;
}

/*
!!ARBfp1.0
OPTION ARB_fog_linear;

PARAM c[1] = { { 2 } };
TEMP R0;
TEMP R1;
TEX R0, fragment.texcoord[0], texture[0], 2D;
TEX R1.xyz, fragment.texcoord[1], texture[1], 2D;
MUL R1.xyz, R0, R1;
MUL R1.xyz, R1, c[0].x;
ADD R0.xyz, R0, -R1;
MAD R0.xyz, R0.w, R0, R1;
MUL result.color.xyz, R0, fragment.color.primary;
MOV result.color.w, fragment.color.primary;
END
*/

void main() {
  vec4 result;

  result = combinersOpaqueMod2xNAAlpha();

  // Apply lighting and fog.
  result = finalizeColor(result);

  gl_FragColor = result;
}
