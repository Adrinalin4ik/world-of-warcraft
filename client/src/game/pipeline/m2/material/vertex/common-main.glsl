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

// Camera distance
vec3 worldVertexPosition = (modelMatrix * vec4(position, 1.0)).xyz;
cameraDistance = distance(cameraPosition, worldVertexPosition);
