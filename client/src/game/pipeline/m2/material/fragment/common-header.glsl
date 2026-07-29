#include <common>

uniform sampler2D textures[4];
uniform float alphaKey;


uniform float lightModifier;

uniform vec4 sunParams;
uniform vec4 sunDiffuseColor;
uniform vec4 sunAmbientColor;
uniform vec4 materialParams;

uniform vec4 fogParams;
uniform vec4 fogColor;

uniform float animatedTransparency;

varying vec2 coordinates[2];
varying vec4 vertexColor;
varying vec3 worldVertexNormal;
varying float cameraDistance;

vec3 createLight(in vec3 normal, in vec3 direction, in vec3 diffuseColor, in vec3 ambientColor) {
  float factor = saturate(dot(-direction.xyz, normalize(normal.xyz)));

  vec3 light = saturate((diffuseColor.rgb * factor) + ambientColor.rgb);

  return light;
}

vec4 applyDiffuseLighting(vec4 result) {
  #if USE_LIGHTING == 1
    vec3 light = createLight(worldVertexNormal.xyz, sunParams.xyz, sunDiffuseColor.rgb, sunAmbientColor.rgb);
    light = mix(light, vec3(1.0, 1.0, 1.0), 1.0 - materialParams.y);
  #else
    vec3 light = vec3(1.0, 1.0, 1.0);
  #endif

  result.rgb *= light;

  return result;
}

vec4 applyFog(vec4 color) {
  float f1 = (cameraDistance * fogParams.x) + fogParams.y;
  float f2 = max(f1, 0.0);
  float f3 = pow(f2, fogParams.z);
  float f4 = min(f3, 1.0);

  float fogFactor = 1.0 - f4;
  
  color.rgb = mix(color.rgb, fogColor.rgb, fogFactor);

  return color;
}

// vec4 applyFog(vec4 result) {
//   float fogFactor = (fogEnd - cameraDistance) / (fogEnd - fogStart);
//   fogFactor = 1.0 - clamp(fogFactor, 0.0, 1.0);
//   float fogColorFactor = fogFactor * fogModifier;

//   // Only mix fog color for simple blending modes.
//   #if BLENDING_MODE <= 2
//     result.rgb = mix(result.rgb, fogColor.rgb, fogColorFactor);
//   #endif

//   // Ensure certain blending mode pixels become fully opaque by fog end.
//   if (cameraDistance >= fogEnd) {
//     result.rgb = fogColor.rgb;
//     result.a = 1.0;
//   }

//   // Ensure certain blending mode pixels fade out as fog increases.
//   #if BLENDING_MODE >= 2 && BLENDING_MODE < 6
//     result.a *= 1.0 - fogFactor;
//   #endif

//   return result;
// }

vec4 finalizeColor(vec4 result) {
  
  result = applyDiffuseLighting(result);

  result = applyFog(result);

  return result;
}
