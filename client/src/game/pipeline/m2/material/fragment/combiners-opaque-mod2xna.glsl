#pragma glslify: import('./common-header.glsl')

/*
float4 main_PS_Combiners_Opaque_Mod2xNA(PixelInput input) : SV_Target
{
    float4 textureColor1 = texture1.Sample(sampler1, input.texCoord1);
	clip((modelPassParams.z && textureColor1.a <= 0.5f) ? -1 : 1);
    float4 textureColor2 = texture2.Sample(sampler2, input.texCoord2);

    textureColor1.a *= transparency.x;
    textureColor2.a *= transparency.y;

    float4 r0 = textureColor1;
    float4 r1 = textureColor2;
    r0.rgb *= r1.rgb;
    r0.rgb *= input.color.rgb;
    r0.rgb *= 4.0f;
    combinedColor.rgb = r0.rgb;
    combinedColor.a = input.color.a;

    return commonFinalize(combinedColor, input);
}
*/

vec4 combinersOpaqueMod2xNA() {
  vec4 result;

  vec4 sampled0 = texture2D(textures[0], coordinates[0]);
  vec4 sampled1 = texture2D(textures[1], coordinates[1]);

  if (alphaKey == 1.0 && sampled0.a < 0.5) {
    discard;
  }

  result.rgb = sampled0.rgb * sampled1.rgb * vertexColor.rgb * 4.0;
  result.a = vertexColor.a * animatedTransparency;

  return result;
}

void main() {
  vec4 result;

  result = combinersOpaqueMod2xNA();

  // Apply lighting and fog.
  result = finalizeColor(result);

  gl_FragColor = result;
}
