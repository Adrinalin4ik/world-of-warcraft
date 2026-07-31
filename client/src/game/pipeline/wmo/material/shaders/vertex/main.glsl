vec4 createFog(in float cameraDistance) {
  // Interior-lit batches (INTERIOR define, set from the group's `lightingInterior`) fog with the
  // camera's claimed room triple instead of the scene's, so the storm outside an inn's open door
  // stays grey while the room keeps its own haze. Exterior/trans-of-exterior groups, terrain, liquid
  // and sky are never built with INTERIOR, so they always take the scene triple.
#if defined(INTERIOR)
  vec3 fogRgb = wmoFogColor;
  vec4 fogSpan = wmoFogParams;
#else
  vec3 fogRgb = fogColor;
  vec4 fogSpan = fogParams;
#endif

  float f1 = (cameraDistance * fogSpan.x) + fogSpan.y;
  float f2 = max(f1, 0.0);
  // fogSpan.z is always 1.0 at the only packing site (blendLights / packFogParams), so the pow was a
  // no-op costing a per-fragment exponentiation and disguising a plain linear ramp. The law is
  // factor = 1 - clamp((end - eyeZ) / (end - start)).
  float f4 = min(f2, 1.0);

  float fogFactor = 1.0 - f4;

  vec4 fog;

  fog.rgb = fogRgb;
  fog.a = fogFactor;

  return fog;
}

void main() {
  vec3 objectPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 objectNormal = (modelMatrix * vec4(normal, 0.0)).xyz;

  // Fog rides PLANAR EYE-Z (view-space depth), not radial distance. Radial over-fogs the screen
  // edges: a surface at the edge of view is farther from the eye than one dead ahead at the same
  // depth, so it hazes more and the fog visibly curves. VERIFIED in the reference (samples/benilla
  // terrain.wgsl and wow_model.wgsl both use planar eye-Z and say radial over-fogs the edges).
  float cameraDistance = -(modelViewMatrix * vec4(position, 1.0)).z;

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