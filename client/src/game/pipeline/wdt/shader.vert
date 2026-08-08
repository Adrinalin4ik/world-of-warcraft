precision highp float;

// Standard Three.js attributes
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

// Varying outputs
varying vec2 vTexCoord;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec3 vViewNormal;
varying float vCameraDistance;
varying vec4 vVertexColor;

// Uniforms
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;

// Terrain uniforms
uniform float terrainScale;
uniform vec2 terrainOffset;
uniform float heightScale;

// Animation uniforms
uniform float time;
uniform vec4 animatedVertexColor;

void main() {
  // Transform position
  vec3 transformed = position;
  
  // Apply terrain scaling and offset
  transformed.xz *= terrainScale;
  transformed.xz += terrainOffset;
  
  // Calculate world position
  vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
  
  // Calculate camera distance for fog
  vCameraDistance = distance(cameraPosition, vWorldPosition);
  
  // Transform normal to world space
  vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  
  // Transform normal to view space for lighting
  vViewNormal = normalize(normalMatrix * normal);
  
  // Set texture coordinates
  vTexCoord = uv;
  
  // Set vertex color
  vVertexColor = animatedVertexColor;
  
  // Calculate final position
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
}


