#pragma glslify: import('./header.glsl')
#pragma glslify: import('./functions.glsl')

vec4 createFog(in float cameraDistance) {
  float f1 = (cameraDistance * fogParams.x) + fogParams.y;
  float f2 = max(f1, 0.0);
  float f3 = pow(f2, fogParams.z);
  float f4 = min(f3, 1.0);

  float fogFactor = 1.0 - f4;

  vec4 fog;

  fog.rgb = fogColor.rgb;
  fog.a = fogFactor;

  return fog;
}

void main() {
  vec3 objectPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 objectNormal = (modelMatrix * vec4(normal, 0.0)).xyz;

  float cameraDistance = length(modelViewMatrix * vec4(position, 1.0));

  // t1 coordinate
  coords[0] = uv;

  // Fog
  fog = createFog(cameraDistance);

  // Lighting moved to the fragment stage (the reference evaluates N.L per fragment). The vertex
  // stage now only transports what that needs. The old `light * 0.5` here and the matching `* 2.0`
  // in the combiners were a cancelling pair of fudges around the missing real law; both are gone.
  #if USE_VERTEX_COLOR == 1
    vertexColorOut = acolor;
  #else
    vertexColorOut = vec4(1.0, 1.0, 1.0, 1.0);
  #endif

  worldNormal = objectNormal;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
//1