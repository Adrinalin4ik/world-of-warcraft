precision highp float;

varying vec2 vUv;

varying vec3 vertexWorldNormal;
varying float cameraDistance;

attribute vec3 color;
attribute float alpha;

varying vec4 vertexColor;

uniform int interior;

uniform int useBaseColor;
uniform vec3 baseColor;
uniform float baseAlpha;

void main() {
  vUv = uv;

  vertexColor = vec4(color, alpha);

  if (interior == 1 && useBaseColor == 1) {
    vertexColor.rgb = clamp(vertexColor.rgb + baseColor.rgb, 0.0, 1.0);
    vertexColor.a = clamp(mod(vertexColor.a, 1.0) + (1.0 - baseAlpha), 0.0, 1.0);
  }

  vec3 vertexWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  cameraDistance = distance(cameraPosition, vertexWorldPosition);

  vertexWorldNormal = (modelMatrix * vec4(normal, 0.0)).xyz;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
