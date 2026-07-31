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
uniform float sunIntensity;

uniform vec4 fogParams;
uniform vec3 fogColor;
uniform float fogModifier;

uniform float animatedTransparency;

// WMO point lights (MOLT) affecting this model. Positions are world space, matching
// worldVertexPosition. Count is zero for anything not standing inside a WMO. Selected per object
// (world/light/laws.ts::selectPointLights), which commits at most three -- see MAX_WMO_LIGHTS below.
#define MAX_WMO_LIGHTS 3
uniform int wmoLightCount;
uniform vec3 wmoLightPosition[MAX_WMO_LIGHTS];
uniform vec3 wmoLightColor[MAX_WMO_LIGHTS];

varying vec2 coordinates[2];
varying vec4 vertexColor;
varying vec3 worldVertexNormal;
varying vec3 worldVertexPosition;
varying float cameraDistance;

uniform int interiorProbe;
uniform vec4 probeCoeffs[7];

/**
 * Diffuse contribution of the WMO's own point lights.
 *
 * Interiors get no sun, so without these a doodad indoors is lit by ambient alone. Lights are
 * selected per object, nearest-few to the object's own position (world/light/laws.ts::selectPointLights),
 * not per fragment, so there is no per-fragment cutoff here to match.
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

    // The reference's falloff (samples/benilla wow_model.wgsl::point_light_sum): a selected light
    // reaches the whole object with NO distance cutoff, so selection pops at object granularity --
    // the authored behaviour, not an artifact. Diffuse only; committed ambient and specular are zero.
    float attenuation = 1.0 / (0.7 * distance + 0.03 * distance * distance);

    float incidence = max(dot(normal, toLight / max(distance, 0.001)), 0.0);

    accumulated += wmoLightColor[i] * (incidence * attenuation);
  }

  return accumulated;
}

/**
 * The exterior M2 response -- the closed form of the shipped `Model2.bls` vertex program's lighting
 * block (samples/benilla wow_model.wgsl, and `lighting/sh.rs::prop_probe_coeffs` for the same curve):
 *
 *   E = A + D * I * (4/17) * (0.375 + 2*mu + 1.875*mu*mu),  mu = dot(N, toLight)
 *
 * This is NOT the fixed-function matte it replaces. Exterior M2s are drawn by Model2.bls -- gated on
 * the M2UseShaders cvar, which defaults to "1" -- and that program is an order-2 irradiance lobe. The
 * fixed-function light commits visible in a reference world frame belong to TERRAIN and WMO.
 *
 * Peaks at exactly 1.0 at mu = 1 by construction: (4/17)(0.375 + 2 + 1.875) = 1. Side-on leaves
 * 0.0882, fully-away 0.0588 -- an authored soft wrap, deliberately not a hard max(N.L, 0).
 *
 * CLAMP THE SUM, NEVER A TERM. The lobe dips to about -0.037*D around mu = -0.53 (low-order SH
 * ringing) and that dip is part of the response the reference chose. Clamping the sun term alone
 * would floor it away.
 *
 * Returns the UNCLAMPED ambient+diffuse sum -- `applyDiffuseLighting` is the one place that clamps,
 * after adding the point-light term. Do not re-clamp here: a nearby point light needs the negative
 * dip to still be there to sum against, or the shadow side of a model reads brighter than it should.
 */
vec3 m2SunLobe(in vec3 normal, in vec3 toLight, in vec3 ambient, in vec3 diffuse, in float intensity) {
  float mu = dot(normalize(normal), toLight);
  float lobe = (4.0 / 17.0) * (0.375 + 2.0 * mu + 1.875 * mu * mu);
  return ambient + diffuse * (intensity * lobe);
}

/**
 * Evaluate the per-instance interior light probe at a surface normal.
 *
 * The reference fills an interior MODD prop's light ONCE at create -- from the MODD entry's own baked
 * colour, never a footprint sample -- and commits it as an order-2 SH probe the vertex program
 * evaluates (samples/benilla wow_model.wgsl, the interior-prop lane). Being folded at create is why an
 * interior prop's light is day/night INDEPENDENT.
 *
 * The basis here MIRRORS `evalProbe` in world/light/laws.ts. If you change one, change both -- that
 * function exists so the unit tests and this shader cannot silently disagree.
 *
 * Note the lobe's soft wrap (side-on about 0.088 of the colour) is the reference's authored response,
 * deliberately NOT a hard max(N.L, 0).
 *
 * CLAMP THE SUM, NEVER A TERM (same invariant as `m2SunLobe` above): this function is currently the
 * interior lane's only term, so returning it unclamped is safe -- `applyDiffuseLighting` clamps the
 * whole `light` sum right after calling this. Do not reintroduce a clamp here once a second interior
 * term (e.g. a folded point light) exists alongside it.
 */
vec3 evalInteriorProbe(in vec3 normal) {
  vec3 n = normalize(normal);
  vec4 n1 = vec4(n, 1.0);
  vec4 quad = vec4(n.x * n.y, n.y * n.z, n.z * n.z, n.x * n.z);
  float x2y2 = n.x * n.x - n.y * n.y;

  vec3 result;
  result.r = dot(probeCoeffs[0], n1) + dot(probeCoeffs[3], quad) + probeCoeffs[6].x * x2y2;
  result.g = dot(probeCoeffs[1], n1) + dot(probeCoeffs[4], quad) + probeCoeffs[6].y * x2y2;
  result.b = dot(probeCoeffs[2], n1) + dot(probeCoeffs[5], quad) + probeCoeffs[6].z * x2y2;

  return result;
}

vec4 applyDiffuseLighting(vec4 result) {
  #if USE_LIGHTING == 1
    vec3 light;

    if (interiorProbe == 1) {
      // Interior prop: its folded probe IS its light. No sun, no time of day. Point lights are already
      // folded into the probe at spawn, so none are added here.
      light = evalInteriorProbe(worldVertexNormal);
    } else {
      vec3 toLight = -normalize(sunParams.xyz);
      light = m2SunLobe(worldVertexNormal, toLight, sunAmbientColor, sunDiffuseColor, sunIntensity);
      light += applyWmoPointLights(normalize(worldVertexNormal.xyz));
    }

    // Clamp the SUM, never a term: both lanes above hand back unclamped values (the exterior lane's
    // point lights are added in above; the interior probe's own docstring says the same). Clamping
    // BOTH ends matters -- a bare min() would leave the sun lobe's negative dip in place, and that
    // negative factor would darken the albedo below black once multiplied through.
    light = clamp(light, 0.0, 1.0);
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
  // fogParams.z is always 1.0 at the only packing site (blendLights), so the pow was a no-op costing
  // a per-fragment exponentiation and disguising a plain linear ramp. The law is
  // factor = 1 - clamp((end - eyeZ) / (end - start)).
  float f4 = min(f2, 1.0);

  // fogModifier is zero for geometry flagged unfogged (render flag 0x02), which is most flame and
  // glow billboards. The uniform was being set but never declared here, so the flag did nothing.
  float fogFactor = (1.0 - f4) * fogModifier;

#if BLENDING_MODE <= 2
  // Opaque, alpha-keyed and alpha-blended geometry replaces what is behind it, so fog replaces its
  // colour in the usual way.
  color.rgb = mix(color.rgb, fogColor.rgb, fogFactor);
#elif BLENDING_MODE == 3 || BLENDING_MODE == 4
  // Modes 3 (NoAlphaAdd) and 4 (Add) *add* their result into the framebuffer. Mixing toward a lit fog
  // colour therefore adds light rather than removing it: a torch's additive glow picked up the fog tint
  // and drew a coloured halo over everything nearby -- violet, wherever the zone's fog colour is blue.
  // Fog has to fade an additive contribution toward black instead, which is the additive identity.
  //
  // Mode 6 (Mod2x) used to be lumped in here too, which is wrong -- it is a multiply-and-double, not an
  // add, and fogging it toward black darkened it instead of neutralising it. See the Mod2x branch below.
  color.rgb = mix(color.rgb, vec3(0.0), fogFactor);
#elif BLENDING_MODE == 5
  // Mode 5 (Mod) is a pure multiply (applyBlendingMode: DstColor/Zero). Its identity is WHITE -- fade
  // toward that, so a modulating decal (e.g. a shadow blob) stops affecting the framebuffer at fog
  // distance instead of staying crisp forever.
  color.rgb = mix(color.rgb, vec3(1.0), fogFactor);
#elif BLENDING_MODE == 6
  // Mode 6 (Mod2x) multiplies and doubles (applyBlendingMode: DstColor/SrcColor), so its identity is
  // grey (0.5): mixing toward that neutralises the doubling instead of darkening it toward black.
  color.rgb = mix(color.rgb, vec3(0.50196078), fogFactor);
#endif

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
