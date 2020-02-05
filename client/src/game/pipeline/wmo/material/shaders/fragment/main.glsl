// #pragma glslify: import('./header.glsl')

uniform sampler2D textures[2];
// uniform vec4 materialParams;

varying vec2 coords[2];
varying vec4 colors[2];
varying vec4 fog;
// varying float alphaTest;

#pragma glslify: import('./functions.glsl')
#pragma glslify: import('./combiners.glsl')

void main() {
  vec4 result;

  // Branch for combiners
  // #if defined(COMBINERS_OPAQUE)
    // result = combinersOpaque();
  // #elif defined(COMBINERS_DIFFUSE)
    // result = combinersDiffuse();
  // #endif

  vec4 sampled0 = texture2D(textures[0], coords[0]);

  result.rgb = colors[0].rgb * sampled0.rgb;
  result.a = colors[0].a;

  // result.rgb = mix(result.rgb, fog.rgb, fog.a);


  // Alpha test
  // if (sampled0.a == 0.0) {
  //   result.a = colors[0].a * sampled0.a;
  //   discard;
  // }

  // Finalize
  // result = finalizeResult(result);

  gl_FragColor = result;
}
