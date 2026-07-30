#pragma glslify: import('./common-header.glsl')

/*
float4 main_PS_Combiners_Mod_Opaque(PixelInput input) : SV_Target
{
    float4 textureColor1 = texture1.Sample(sampler1, input.texCoord1);
	clip((modelPassParams.z && textureColor1.a <= 0.5f) ? -1 : 1);
    float4 textureColor2 = texture2.Sample(sampler2, input.texCoord2);

    textureColor1.a *= transparency.x;
    textureColor2.a *= transparency.y;

    float4 r0 = textureColor2;
    float4 r1 = textureColor1;
    r0.rgb *= r1.rgb;
    combinedColor.a = r1.a * input.color.a;
    r0.rgb *= input.color.rgb;
    r0.rgb *= 2.0f;
    combinedColor.rgb = r0.rgb;

    return commonFinalize(combinedColor, input);
}
*/

vec4 combinersModOpaque() {
  vec4 result;

  vec4 sampled0 = texture2D(textures[0], coordinates[0]);
  vec4 sampled1 = texture2D(textures[1], coordinates[1]);

  // TODO is this sampled0 or sampled1 to check alpha?
  if (alphaKey == 1.0 && sampled0.a < 0.5) {
    discard;
  }

  result.rgb = sampled0.rgb * sampled1.rgb * vertexColor.rgb * 2.0;
  result.a = sampled0.a * vertexColor.a * animatedTransparency;

  return result;
}

void main() {
  vec4 result;

  result = combinersModOpaque();

  // Apply lighting and fog.
  result = finalizeColor(result);

  gl_FragColor = result;
}
