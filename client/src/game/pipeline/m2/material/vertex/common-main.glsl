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

  // NO `modelMatrix` here, and that is not an omission -- adding one double-transforms the normal.
  //
  // `skinMatrix` is already a MODEL-TO-WORLD map. `Skeleton.update` writes each palette entry as
  // `bone.matrixWorld * boneInverse`, and `poseBindSkeleton` takes those inverses in MODEL space
  // (before the M2 is in the scene), so an entry is
  //
  //     M2.matrixWorld  .  bonePose_model  .  bindPose_model^-1
  //
  // and the world transform is baked in. That is also why the POSITION works: with three's default
  // AttachedBindMode, `bindMatrix` stays the identity we pass while `bindMatrixInverse` is
  // recomputed as `matrixWorld^-1` every frame -- deliberately NOT its inverse -- so `skinned` above
  // is the world-space sum brought back into local space, which `modelViewMatrix` then expects.
  //
  // So both branches of this #ifdef DO hand the fragment stage a world-space normal; they just get
  // there by different routes, one through the palette and one through modelMatrix. A previous
  // "fix" here added modelMatrix to this branch on the reasoning that bone matrices are model-space.
  // They are not, and the result was the body lit through an extra whole yaw -- `Unit#model` sets
  // `rotation.z = PI` and the view carries the body heading on top of it.
  worldVertexNormal = (skinMatrix * vec4(normal, 0.0)).xyz;
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
