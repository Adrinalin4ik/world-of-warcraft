precision highp float;

attribute vec2 uvAlpha;

varying vec2 vUv;
varying vec2 vUvAlpha;

varying vec3 vertexNormal;
varying vec3 vertexWorldPosition;
varying float cameraDistance;

void main() {
  // Terrain textures are BLPs uploaded as compressed DXT, and three.js cannot flip a compressed
  // texture on upload the way it flipped the PNGs this pipeline used to fetch. Flip V here instead.
  // vUvAlpha is deliberately untouched: the alpha maps are DataTextures built from MCAL, not BLPs.
  vUv = vec2(uv.x, 1.0 - uv.y);
  vUvAlpha = uvAlpha;

  // Calculate world position for specular lighting
  vertexWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;

  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

  // Fog rides PLANAR EYE-Z (view-space depth), not radial distance. Radial over-fogs the screen
  // edges: a surface at the edge of view is farther from the eye than one dead ahead at the same
  // depth, so it hazes more and the fog visibly curves. VERIFIED in the reference (samples/benilla
  // terrain.wgsl and wow_model.wgsl both use planar eye-Z and say radial over-fogs the edges).
  cameraDistance = -mvPosition.z;

  vertexNormal = vec3(normal);

  // TODO: Potentially unnecessary for ADT shading
  // vertexWorldNormal = (modelMatrix * vec4(normal, 0.0)).xyz;

  gl_Position = projectionMatrix * mvPosition;
}
