precision highp float;

uniform sampler2D texture_sampler;

// 1.0 for blend mode 1 (ALPHA_KEY), 0.0 otherwise. `ShaderMaterial.alphaTest` does not do anything on
// its own -- three.js only wires up the discard for its built-in `<alphatest_fragment>` chunk, which
// this custom shader never includes. Mirrors `alphaKey` in the M2 material's own fragment shaders
// (see combiners-opaque.glsl), so mode 1 is hard-cut here exactly like it is there.
uniform float alphaKey;

varying vec2 vUv;
varying vec4 vColor;

void main() {
  vec4 sampled = texture2D(texture_sampler, vUv);

  if (alphaKey == 1.0 && sampled.a < 0.5) {
    discard;
  }

  // Colour and alpha both come from the emitter's lifetime tracks, already normalised to 0..1 by
  // tracks.ts. The texture supplies the shape; the tracks supply the tint and the fade.
  gl_FragColor = vec4(sampled.rgb * vColor.rgb, sampled.a * vColor.a);
}
