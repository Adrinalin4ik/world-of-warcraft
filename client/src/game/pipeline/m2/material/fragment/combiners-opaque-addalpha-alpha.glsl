#pragma glslify: import('./common-header.glsl')

/*
float4 main_PS_Combiners_Opaque_AddAlpha_Alpha(PixelInput input) : SV_Target
{
    float4 textureColor1 = texture1.Sample(sampler1, input.texCoord1);
	clip((modelPassParams.z && textureColor1.a <= 0.5f) ? -1 : 1);
    float4 textureColor2 = texture2.Sample(sampler2, input.texCoord2);

    textureColor1.a *= transparency.x;
    textureColor2.a *= transparency.y;

    float4 r0 = textureColor2;
    r0.rgb = r0.a * r0.rgb;
    float4 r1 = textureColor1;
    r1.rgb *= input.color.rgb;
    r0.a = -r1.a + 1;
    r1.rgb += r1.rgb;
    r0.rgb = r0.rgb * r0.a + r1.rgb;
    combinedColor.rgb = r0.rgb;
    combinedColor.a = input.color.a;

    return commonFinalize(combinedColor, input);
}
*/

vec4 combinersOpaqueAddAlphaAlpha() {
  vec4 result;

  vec4 sampled0 = texture2D(textures[0], coordinates[0]);
  vec4 sampled1 = texture2D(textures[1], coordinates[1]);

  if (alphaKey == 1.0 && sampled0.a < 0.5) {
    discard;
  }

  vec4 r0;
  vec4 r1;

  r0 = sampled1;
  r0.rgb = r0.a * r0.rgb;
  r1 = sampled0;
  r1.rgb *= vertexColor.rgb;
  r0.a = -r1.a + 1.0;
  r0.a *= animatedTransparency; // TODO correct?
  r1.rgb += r1.rgb;
  r0.rgb = r0.rgb * r0.a + r1.rgb;

  result.rgb = r0.rgb;
  result.a = vertexColor.a;

  return result;
}

void main() {
  vec4 result;

  result = combinersOpaqueAddAlphaAlpha();

  // Apply lighting and fog.
  result = finalizeColor(result);

  gl_FragColor = result;
}
