#pragma glslify: import('./common-header.glsl')

void main() {
	#pragma glslify: import('./common-main.glsl')

  // c0 mapping (env)
  coordinates[0] = envMapSphere(mvPosition.xyz, normal);

  // c0 texture animation
	vec4 c0a = animatedUVs[0] * vec4(coordinates[0], 0, 1.0);
	coordinates[0] = c0a.xy / c0a.w;

  gl_Position = projectionMatrix * mvPosition;
}
