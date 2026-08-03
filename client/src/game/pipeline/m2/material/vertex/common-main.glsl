vec3 transformed = vec3(position);

#ifdef USE_SKINNING
  mat4 boneMatX = getBoneMatrix(skinIndex.x);
  mat4 boneMatY = getBoneMatrix(skinIndex.y);
  mat4 boneMatZ = getBoneMatrix(skinIndex.z);
  mat4 boneMatW = getBoneMatrix(skinIndex.w);
#endif

#ifdef USE_SKINNING
  vec4 skinVertex = bindMatrix * vec4(transformed, 1.0);

  vec4 skinned = vec4( 0.0 );
  skinned += boneMatX * skinVertex * skinWeight.x;
  skinned += boneMatY * skinVertex * skinWeight.y;
  skinned += boneMatZ * skinVertex * skinWeight.z;
  skinned += boneMatW * skinVertex * skinWeight.w;
  skinned = bindMatrixInverse * skinned;
#endif

#ifdef USE_SKINNING
  mat4 skinMatrix = mat4(0.0);
  skinMatrix += skinWeight.x * boneMatX;
  skinMatrix += skinWeight.y * boneMatY;
  skinMatrix += skinWeight.z * boneMatZ;
  skinMatrix += skinWeight.w * boneMatW;

  // `modelMatrix` as well as the skin, because bone matrices map model space onto POSED MODEL space
  // -- exactly like `skinned` above, which `modelViewMatrix` then takes the rest of the way. Without
  // it the two branches of this #ifdef hand the fragment stage vectors in DIFFERENT SPACES, while
  // both consumers -- `sunParams.xyz` in m2SunLobe and `wmoLightPosition` in applyWmoPointLights --
  // are world space.
  //
  // For a unit that error is a whole yaw: `Unit#model` sets `m2.rotation.z = PI` and the view carries
  // the body heading on top. So the sun arrives from the wrong side and, at night, every fragment
  // lands near the lobe's minimum -- ambient plus 6% of diffuse. Measured with the night sun
  // (#4b5b97) and ambient (#0f3456) that is light (0.08, 0.22, 0.38), which against dark ground is
  // the difference between a dim body and one nobody can find.
  worldVertexNormal = (modelMatrix * skinMatrix * vec4(normal, 0.0)).xyz;
#else
  worldVertexNormal = (modelMatrix * vec4(normal, 0.0)).xyz;
#endif

#ifdef USE_SKINNING
  vec4 mvPosition = modelViewMatrix * skinned;
#else
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
#endif

// Vertex color
vertexColor = vec4(animatedVertexColorRGB.rgb * 0.5, animatedVertexColorAlpha);

// Camera distance. worldVertexPosition is a varying rather than a local so the fragment stage can
// use it to attenuate WMO point lights.
worldVertexPosition = (modelMatrix * vec4(position, 1.0)).xyz;

// Fog rides PLANAR EYE-Z (view-space depth), not radial distance. Radial over-fogs the screen edges:
// a surface at the edge of view is farther from the eye than one dead ahead at the same depth, so it
// hazes more and the fog visibly curves. VERIFIED in the reference (samples/benilla terrain.wgsl and
// wow_model.wgsl both use planar eye-Z and say radial over-fogs the edges). mvPosition already carries
// the skinned position on the skinned path, so this is correct there too.
cameraDistance = -mvPosition.z;
