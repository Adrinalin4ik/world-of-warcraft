#pragma glslify: import('./header.glsl')
#pragma glslify: import('./functions.glsl')
#pragma glslify: import('./combiners.glsl')

void main() {
  vec4 result;

  // Branch for combiners
  #if defined(COMBINERS_OPAQUE)
    result = combinersOpaque();
  #elif defined(COMBINERS_DIFFUSE)
    result = combinersDiffuse();
  #endif
  //test
  // Alpha test
  // if (result.a < materialParams.x) {
  //   discard;
  // }
  
  result = texture2D(textures[0], coords[0]);

  #if BLENDING_MODE == 0
    result.a = 1.0;
  #endif

  #if BLENDING_MODE == 1
    if (result.a < alphaTestValue) {
      discard;
    }
  #endif
  
  // Finalize
  result = finalizeResult(result);

  gl_FragColor = result;
}