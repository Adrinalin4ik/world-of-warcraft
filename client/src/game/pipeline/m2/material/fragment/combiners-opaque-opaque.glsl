#pragma glslify: import('./common-header.glsl')

vec4 combinersOpaqueOpaque() {
  vec4 result;

  vec4 sampled0 = texture2D(textures[0], coordinates[0]);
  vec4 sampled1 = texture2D(textures[1], coordinates[1]);

  // TODO: Does this apply to opaque+opaque?
  if (alphaKey == 1.0 && sampled0.a < 0.5) {
    discard;
  }

  result.rgb = sampled0.rgb * sampled1.rgb * vertexColor.rgb * 2.0;
  result.a = vertexColor.a;

  return result;
}

/*
!!ARBfp1.0
OPTION ARB_fog_linear;

TEMP R0;
TEMP R1;
TEX R0.xyz, fragment.texcoord[0], texture[0], 2D;
TEX R1.xyz, fragment.texcoord[1], texture[1], 2D;
MUL R0.xyz, fragment.color.primary, R0;
MUL result.color.xyz, R0, R1;
MOV result.color.w, fragment.color.primary;
END
*/

void main() {
  vec4 result;

  result = combinersOpaqueOpaque();

  // Apply lighting and fog.
  result = finalizeColor(result);

  gl_FragColor = result;
}
