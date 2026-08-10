precision highp float;

uniform sampler2D texture_sampler;

// 1.0 for blend mode 1 (ALPHA_KEY), 0.0 otherwise. `ShaderMaterial.alphaTest` does not do anything on
// its own -- three.js only wires up the discard for its built-in `<alphatest_fragment>` chunk, which
// this custom shader never includes. Mirrors `alphaKey` in the M2 material's own fragment shaders
// (see combiners-opaque.glsl), so mode 1 is hard-cut here exactly like it is there.
uniform float alphaKey;

// The zone's fog ramp, copied from MapLight every frame by ParticleManager. Particles are unlit --
// the reference's particle shader takes no diffuse or ambient term -- but they ARE fogged, and
// without this a distant flame stayed at full brightness while the geometry behind it faded out.
uniform vec4 fogParams;
uniform vec3 fogColor;

// The interior fog triple, and the per-emitter flag selecting it -- mirrors `wmoFogParams` /
// `wmoFogColor` / `interiorFog` in m2/material/fragment/common-header.glsl. Set by ParticleManager
// from the owning M2 instance's `perObjectLighting.interiorFog` (per-object-light.ts), so an emitter
// hanging off a doodad standing in a WMO interior fogs with the room's haze too, not just its own
// mesh batches.
uniform vec4 wmoFogParams;
uniform vec3 wmoFogColor;
uniform float interiorFog;

varying vec2 vUv;
varying vec4 vColor;
varying float cameraDistance;

// Deliberately identical to applyFog in m2/material/fragment/common-header.glsl, including the
// blend-mode split. Particles and the batches they sit among must fog the same way or the same
// texture reads differently in each.
vec4 applyFog(vec4 color) {
  vec3 fogRgb = fogColor;
  vec4 fogSpan = fogParams;

  if (interiorFog > 0.5) {
    fogRgb = wmoFogColor;
    fogSpan = wmoFogParams;
  }

  float f1 = (cameraDistance * fogSpan.x) + fogSpan.y;
  float f2 = max(f1, 0.0);
  // fogSpan.z is always 1.0 at the only packing site (blendLights), so the pow was a no-op costing
  // a per-fragment exponentiation and disguising a plain linear ramp. The law is
  // factor = 1 - clamp((end - eyeZ) / (end - start)).
  float f4 = min(f2, 1.0);

  float fogFactor = 1.0 - f4;

#if BLENDING_MODE <= 2
  // Opaque, alpha-keyed and alpha-blended particles replace what is behind them, so fog replaces
  // their colour in the usual way.
  color.rgb = mix(color.rgb, fogRgb, fogFactor);
#elif BLENDING_MODE == 3 || BLENDING_MODE == 4
  // Modes 3 (NoAlphaAdd) and 4 (Add) *add* their result into the framebuffer. Mixing toward a lit
  // fog colour would ADD light rather than remove it -- a distant torch would paint a coloured halo
  // over the fog instead of fading into it. Fog has to fade an additive contribution toward black,
  // its identity. Mode 6 (Mod2x) is NOT an additive mode -- see its own branch below.
  color.rgb = mix(color.rgb, vec3(0.0), fogFactor);
#elif BLENDING_MODE == 5
  // Mode 5 (Mod) is a pure multiply (DstColor/Zero). Its identity is WHITE -- fade toward that, so a
  // modulating particle stops affecting the framebuffer at fog distance instead of staying crisp
  // forever.
  color.rgb = mix(color.rgb, vec3(1.0), fogFactor);
#elif BLENDING_MODE == 6
  // Mode 6 (Mod2x) multiplies and doubles (DstColor/SrcColor), so its identity is grey (0.5): mixing
  // toward that neutralises the doubling instead of darkening it toward black.
  color.rgb = mix(color.rgb, vec3(0.50196078), fogFactor);
#endif

  return color;
}

void main() {
  vec4 sampled = texture2D(texture_sampler, vUv);

  if (alphaKey == 1.0 && sampled.a < 0.5) {
    discard;
  }

  // Colour and alpha both come from the emitter's lifetime tracks, already normalised to 0..1 by
  // tracks.ts. The texture supplies the shape; the tracks supply the tint and the fade.
  gl_FragColor = applyFog(vec4(sampled.rgb * vColor.rgb, sampled.a * vColor.a));
}
