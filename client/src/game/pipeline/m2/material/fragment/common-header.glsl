#include <common>

uniform sampler2D textures[4];
uniform float alphaKey;


uniform float lightModifier;

uniform vec4 sunParams;
// vec3, not vec4: M2Material supplies these as THREE.Color, which has no .w. Declared vec4, the
// upload silently fails and they stay zero, so lit doodads multiply their texture by nothing and
// render as black silhouettes.
uniform vec3 sunDiffuseColor;
uniform vec3 sunAmbientColor;
uniform vec4 materialParams;

uniform vec4 fogParams;
uniform vec3 fogColor;
uniform float fogModifier;

uniform float animatedTransparency;

// WMO point lights (MOLT) affecting this model. Positions are world space, matching
// worldVertexPosition. Count is zero for anything not standing inside a WMO.
#define MAX_WMO_LIGHTS 4
uniform int wmoLightCount;
uniform vec3 wmoLightPosition[MAX_WMO_LIGHTS];
uniform vec3 wmoLightColor[MAX_WMO_LIGHTS];
uniform vec2 wmoLightAtten[MAX_WMO_LIGHTS];

varying vec2 coordinates[2];
varying vec4 vertexColor;
varying vec3 worldVertexNormal;
varying vec3 worldVertexPosition;
varying float cameraDistance;

vec3 createLight(in vec3 normal, in vec3 direction, in vec3 diffuseColor, in vec3 ambientColor) {
  float factor = saturate(dot(-direction.xyz, normalize(normal.xyz)));

  vec3 light = saturate((diffuseColor.rgb * factor) + ambientColor.rgb);

  return light;
}

/**
 * Diffuse contribution of the WMO's own point lights.
 *
 * Interiors get no sun, so without these a doodad indoors is lit by ambient alone. Attenuation is
 * linear between attenStart and attenEnd, which is what the client uses for omni lights.
 */
vec3 applyWmoPointLights(vec3 normal) {
  vec3 accumulated = vec3(0.0);

  // Loop bound must be a constant in GLSL ES 1.0, so the count is applied as a test inside.
  for (int i = 0; i < MAX_WMO_LIGHTS; i++) {
    if (i >= wmoLightCount) {
      continue;
    }

    vec3 toLight = wmoLightPosition[i] - worldVertexPosition;
    float distance = length(toLight);

    float attenStart = wmoLightAtten[i].x;
    float attenEnd = wmoLightAtten[i].y;

    // Full brightness inside attenStart, falling to nothing at attenEnd.
    float falloff = 1.0 - clamp((distance - attenStart) / max(attenEnd - attenStart, 0.001), 0.0, 1.0);
    if (falloff <= 0.0) {
      continue;
    }

    float incidence = max(dot(normal, toLight / max(distance, 0.001)), 0.0);

    accumulated += wmoLightColor[i] * (incidence * falloff);
  }

  return accumulated;
}

vec4 applyDiffuseLighting(vec4 result) {
  #if USE_LIGHTING == 1
    vec3 light = createLight(worldVertexNormal.xyz, sunParams.xyz, sunDiffuseColor.rgb, sunAmbientColor.rgb);
    light += applyWmoPointLights(normalize(worldVertexNormal.xyz));
    light = min(light, vec3(1.0, 1.0, 1.0));
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

  // fogModifier is zero for geometry flagged unfogged (render flag 0x02), which is most flame and
  // glow billboards. The uniform was being set but never declared here, so the flag did nothing.
  float fogFactor = (1.0 - f4) * fogModifier;

#if BLENDING_MODE <= 2
  // Opaque, alpha-keyed and alpha-blended geometry replaces what is behind it, so fog replaces its
  // colour in the usual way.
  color.rgb = mix(color.rgb, fogColor.rgb, fogFactor);
#elif BLENDING_MODE == 3 || BLENDING_MODE == 4 || BLENDING_MODE == 6
  // These modes *add* their result into the framebuffer. Mixing toward a lit fog colour therefore adds
  // light rather than removing it: a torch's additive glow picked up the fog tint and drew a coloured
  // halo over everything nearby -- violet, wherever the zone's fog colour is blue. Fog has to fade an
  // additive contribution toward black instead, which is the additive identity.
  color.rgb = mix(color.rgb, vec3(0.0), fogFactor);
#endif
  // BLENDING_MODE 5 is a pure modulate (DstColor/Zero). Its identity is white, and fogging it toward
  // either black or the fog colour would darken whatever it multiplies, so it is left alone.

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
