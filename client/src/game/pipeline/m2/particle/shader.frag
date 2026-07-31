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

varying vec2 vUv;
varying vec4 vColor;
varying float cameraDistance;

// Deliberately identical to applyFog in m2/material/fragment/common-header.glsl, including the
// blend-mode split. Particles and the batches they sit among must fog the same way or the same
// texture reads differently in each.
vec4 applyFog(vec4 color) {
  float f1 = (cameraDistance * fogParams.x) + fogParams.y;
  float f2 = max(f1, 0.0);
  // fogParams.z is always 1.0 at the only packing site (blendLights), so the pow was a no-op costing
  // a per-fragment exponentiation and disguising a plain linear ramp. The law is
  // factor = 1 - clamp((end - eyeZ) / (end - start)).
  float f4 = min(f2, 1.0);

  float fogFactor = 1.0 - f4;

#if BLENDING_MODE <= 2
  // Opaque, alpha-keyed and alpha-blended particles replace what is behind them, so fog replaces
  // their colour in the usual way.
  color.rgb = mix(color.rgb, fogColor.rgb, fogFactor);
#elif BLENDING_MODE == 3 || BLENDING_MODE == 4 || BLENDING_MODE == 6
  // Additive modes add into the framebuffer, so mixing toward a lit fog colour would ADD light
  // rather than remove it -- a distant torch would paint a coloured halo over the fog instead of
  // fading into it. Fog has to fade an additive contribution toward black, its identity.
  color.rgb = mix(color.rgb, vec3(0.0), fogFactor);
#endif
  // BLENDING_MODE 5 is a pure modulate (DstColor/Zero) whose identity is white; fogging it toward
  // either black or the fog colour would darken whatever it multiplies, so it is left alone.

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
