#pragma glslify: import('./header.glsl')
#pragma glslify: import('./functions.glsl')
#pragma glslify: import('./combiners.glsl')

void main() {
  vec4 result;

  // Branch for combiners
  // #if defined(COMBINERS_OPAQUE)
  //   result = combinersOpaque();
  // #elif defined(COMBINERS_DIFFUSE)
  //   result = combinersDiffuse();
  // #endif

  // Alpha test
  // if (result.a < materialParams.x) {
  //   discard;
  // }
  result = texture2D(textures[0], coords[0]);
  // Finalize
  result = finalizeResult(result);

  gl_FragColor = result;
}