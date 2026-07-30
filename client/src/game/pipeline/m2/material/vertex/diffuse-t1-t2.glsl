#pragma glslify: import('./common-header.glsl')

void main() {
	#pragma glslify: import('./common-main.glsl')

	// c0 mapping (t1)
	coordinates[0] = vec2(uv);

	// c1 mapping (t2)
  coordinates[1] = vec2(uv2);

	// c0 texture animation
	vec4 c0a = animatedUVs[0] * vec4(coordinates[0], 0, 1.0);
	coordinates[0] = c0a.xy / c0a.w;

  // c1 texture animation
	vec4 c1a = animatedUVs[1] * vec4(coordinates[1], 0, 1.0);
	coordinates[1] = c1a.xy / c1a.w;

  gl_Position = projectionMatrix * mvPosition;
}
