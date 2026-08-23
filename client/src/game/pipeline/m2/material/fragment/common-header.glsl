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

// The interior fog triple (MapLight's resolved camera-in-WMO-room haze), published for WMO materials
// too (wmo/material/index.js). `interiorFog` is per-instance (per-object-light.ts) -- set when this
// particular doodad should hold its room's haze -- separate from `interiorProbe` above, which only
// selects the lighting LANE. See PerObjectLighting.interiorFog for why the two are not the same flag.
uniform vec4 wmoFogParams;
uniform vec3 wmoFogColor;
uniform int interiorFog;

uniform float animatedTransparency;

// The MOUSEOVER / TARGET model brighten -- the real client's per-model HIGHLIGHT EMISSIVE, as a flat
// additive lift on the lighting sum. 0 for everything that is not lit up.
//
// A CM2 instance carries it beside its fade alpha: an additive highlight emissive at
// `model+0x190/194/198` (setter `0x710d40`, default 0,0,0), pushed by `SetHighlight 0x614550` /
// `ClearHighlight 0x6144f0` and added by the animate kernel to the material emissive through
// `glMaterialfv(GL_EMISSION)` (`samples/benilla/.../instance_tint.rs:5-10` and
// `.../target/highlight.rs:1-10`, wow-re `selection-circle.md` PART 2 §5). The shipped config default
// is `0xff404040`, i.e. **+64/255 per channel** -- see `world/hover-highlight.ts#HIGHLIGHT_LIFT`, which
// is where that number lives.
//
// WHERE it is added is the whole of getting this right, and `applyDiffuseLighting` does it: GL_EMISSION
// lands INSIDE the lighting sum, which is clamped to [0,1] BEFORE the texture modulates it. So darks
// lift toward fully-lit and already-bright spots saturate -- the reference's own shader says exactly
// that ("darks lift toward fully-lit, already-bright spots saturate",
// `benilla/.../wow_model.wgsl:785-790`). Adding it after the clamp, or to the final colour, would be a
// wash rather than a brighten.
uniform float highlight;

// The per-object distance-fade alpha (pipeline/m2/fade/laws.ts -- the size-bucketed law from
// FUN_00683f80). 1.0 is opaque; the cull drops the object entirely at 0.0, so only the feathering
// band 0 < a < 1 ever reaches here.
//
// It multiplies into BOTH the cutout alpha test in each combiner AND the output alpha below. The
// test is what makes a fading prop erode edge-first rather than dim uniformly -- the reference's
// `discard if tex0.a * diffuse.a < threshold`. (Our threshold is 0.5 where the reference's is
// 224/255; that difference predates this and is deliberately left alone here, since changing it
// would alter the silhouette of every alpha-tested prop in the game.)
uniform float fadeAlpha;

// 1 when the fade's owner has put this material into real alpha blending for the duration of the
// ramp, so the output alpha can be weighted instead of dissolved. See `finalizeColor`.
uniform float fadeBlend;

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
    // The mouseover/target brighten, INSIDE the sum and BEFORE the clamp -- see `highlight`'s own
    // declaration for why that placement is the whole fidelity of it.
    light += highlight;

    light = clamp(light, 0.0, 1.0);
    light = mix(light, vec3(1.0, 1.0, 1.0), 1.0 - materialParams.y);
  #else
    // NO HIGHLIGHT ON AN UNLIT BATCH, and that is faithful rather than an omission: with GL_LIGHTING
    // off the client's own GL_EMISSION is dead, so a glow card or an eye flare does not brighten with
    // the body ("the fullbright/UNLIT path below faithfully never receives it",
    // `benilla/.../wow_model.wgsl:788-789`).
    vec3 light = vec3(1.0, 1.0, 1.0);
  #endif

  result.rgb *= light;

  return result;
}

vec4 applyFog(vec4 color) {
  // Interior-fogged instances (this doodad's owning WMO group is `lightingInterior`, or -- for a
  // unit standing in a WMO interior -- its own light-node classification, per-object-light.ts) take
  // the camera's claimed room triple instead of the scene's, exactly like the WMO shader's
  // `createFog` does at compile time. Everything else keeps the scene triple.
  vec3 fogRgb = fogColor;
  vec4 fogSpan = fogParams;

  if (interiorFog == 1) {
    fogRgb = wmoFogColor;
    fogSpan = wmoFogParams;
  }

  float f1 = (cameraDistance * fogSpan.x) + fogSpan.y;
  float f2 = max(f1, 0.0);
  // fogSpan.z is always 1.0 at the only packing site (blendLights), so the pow was a no-op costing
  // a per-fragment exponentiation and disguising a plain linear ramp. The law is
  // factor = 1 - clamp((end - eyeZ) / (end - start)).
  float f4 = min(f2, 1.0);

  // fogModifier is zero for geometry flagged unfogged (render flag 0x02), which is most flame and
  // glow billboards. The uniform was being set but never declared here, so the flag did nothing.
  float fogFactor = (1.0 - f4) * fogModifier;

#if BLENDING_MODE <= 2
  // Opaque, alpha-keyed and alpha-blended geometry replaces what is behind it, so fog replaces its
  // colour in the usual way.
  color.rgb = mix(color.rgb, fogRgb, fogFactor);
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

  // TWO FADE MECHANISMS, and the owner of the fade picks which by setting `fadeBlend`.
  //
  // **The multiply is the smooth one and it needs real blending.** With `SrcAlpha/OneMinusSrcAlpha` on
  // the colour channels and `Zero/One` on alpha -- which is what `ModelFade` installs, and only ever on
  // materials an instance OWNS -- weighting the output alpha blends the body against the world and
  // leaves the framebuffer's alpha at the cleared 1.0. That last part is the rule `material/index.ts`
  // states and the reason this cannot be done unconditionally: with `NoBlending` the alpha is written
  // straight through, the canvas goes sub-1, and the compositor adds the white page behind it. That was
  // the owner's white doodads.
  //
  // **The dissolve is the fallback for geometry nobody may re-blend**: a doodad's materials are SHARED
  // across every copy of that path in the zone, so putting them into blending would blend all of them --
  // the trap `CLAUDE.md` records three rounds of. An ordered screen-space threshold needs no blend state
  // and writes no alpha. Interleaved gradient noise is the standard choice: stable per pixel, so a still
  // camera shows a steady stipple rather than boiling noise.
  //
  // The dissolve is OURS. The reference has no dither anywhere; it never fades anything big and lets the
  // alpha test erode the small alpha-keyed props instead. The owner's report is why both exist: the
  // dissolve alone read as "слишком резко" on a mob, because a dither is granular per pixel and a distant
  // body covers few of them.
  if (fadeBlend > 0.5) {
    result.a *= fadeAlpha;
  } else if (fadeAlpha < 1.0) {
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (ign >= fadeAlpha) {
      discard;
    }
  }

  return result;
}
