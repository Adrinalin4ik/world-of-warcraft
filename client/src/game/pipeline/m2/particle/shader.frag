precision highp float;

uniform sampler2D texture_sampler;

varying vec2 vUv;
varying vec4 vColor;

void main() {
  vec4 sampled = texture2D(texture_sampler, vUv);

  // Colour and alpha both come from the emitter's lifetime tracks, already normalised to 0..1 by
  // tracks.ts. The texture supplies the shape; the tracks supply the tint and the fade.
  gl_FragColor = vec4(sampled.rgb * vColor.rgb, sampled.a * vColor.a);
}
