precision highp float;
#define MAX_BONES 200

// Standard Three.js attributes
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

// Skinning attributes
attribute vec4 skinIndex;
attribute vec4 skinWeight;

// Varying outputs
varying vec2 vTexCoord1;
varying vec2 vTexCoord2;
varying vec3 vViewNormal;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
varying float vCameraDistance;
varying vec4 vVertexColor;

// Uniforms
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;

// Animation uniforms
uniform vec3 animatedVertexColorRGB;
uniform float animatedVertexColorAlpha;
uniform float animatedTransparency;
uniform mat4 animatedUVs[4];

// Skinning uniforms
#ifdef USE_SKINNING
  #ifdef BONE_TEXTURE
    uniform highp sampler2D boneTexture;
    uniform int boneTextureSize;
    
    mat4 getBoneMatrix(const in float i) {
      float j = i * 4.0;
      float x = mod(j, float(boneTextureSize));
      float y = floor(j / float(boneTextureSize));
      float dx = 1.0 / float(boneTextureSize);
      float dy = 1.0 / float(boneTextureSize);
      y = dy * (y + 0.5);
      
      vec4 v1 = texture2D(boneTexture, vec2(dx * (x + 0.5), y));
      vec4 v2 = texture2D(boneTexture, vec2(dx * (x + 1.5), y));
      vec4 v3 = texture2D(boneTexture, vec2(dx * (x + 2.5), y));
      vec4 v4 = texture2D(boneTexture, vec2(dx * (x + 3.5), y));
      
      return mat4(v1, v2, v3, v4);
    }
  #else
    uniform mat4 boneMatrices[MAX_BONES];
    
    mat4 getBoneMatrix(const in float i) {
      return boneMatrices[int(i)];
    }
  #endif
#endif

// Texture coordinate generation functions
vec2 sphereMap(vec3 position, vec3 normal) {
  vec3 viewPosition = normalize(vec3(modelViewMatrix * vec4(position, 1.0)));
  vec3 viewNormal = normalize(normalMatrix * normal);
  
  vec3 temp = (-viewPosition - (viewNormal * (2.0 * dot(-viewPosition, viewNormal))));
  temp = vec3(temp.x, temp.y, temp.z + 1.0);
  
  return (normalize(temp).xy * 0.5) + vec2(0.5);
}

void main() {
  // Initialize texture coordinates
  vTexCoord1 = uv;
  vTexCoord2 = uv;
  
  // Apply texture animations
  vec4 uv1a = animatedUVs[0] * vec4(vTexCoord1, 0.0, 1.0);
  vTexCoord1 = uv1a.xy / uv1a.w;
  
  vec4 uv2a = animatedUVs[1] * vec4(vTexCoord2, 0.0, 1.0);
  vTexCoord2 = uv2a.xy / uv2a.w;
  
  // Transform position
  vec3 transformed = position;
  
  #ifdef USE_SKINNING
    mat4 boneMatX = getBoneMatrix(skinIndex.x);
    mat4 boneMatY = getBoneMatrix(skinIndex.y);
    mat4 boneMatZ = getBoneMatrix(skinIndex.z);
    mat4 boneMatW = getBoneMatrix(skinIndex.w);
    
    vec4 skinVertex = vec4(transformed, 1.0);
    
    vec4 skinned = vec4(0.0);
    skinned += boneMatX * skinVertex * skinWeight.x;
    skinned += boneMatY * skinVertex * skinWeight.y;
    skinned += boneMatZ * skinVertex * skinWeight.z;
    skinned += boneMatW * skinVertex * skinWeight.w;
    
    transformed = skinned.xyz;
  #endif
  
  // Calculate world position
  vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
  
  // Calculate camera distance for fog
  vCameraDistance = distance(cameraPosition, vWorldPosition);
  
  // Transform normal to world space
  vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  
  // Transform normal to view space for lighting
  vViewNormal = normalize(normalMatrix * normal);
  
  // Set vertex color
  vVertexColor.rgb = animatedVertexColorRGB * 0.5;
  vVertexColor.a = animatedVertexColorAlpha;
  
  // Calculate final position
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
}


