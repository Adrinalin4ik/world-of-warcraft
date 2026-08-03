precision highp float;

attribute vec2 uv2;

uniform float billboarded;

uniform vec3 animatedVertexColorRGB;
uniform float animatedVertexColorAlpha;
uniform float animatedTransparency;
uniform mat4 animatedUVs[4];

varying vec2 coordinates[2];
varying vec4 vertexColor;
varying vec3 worldVertexNormal;
varying vec3 worldVertexPosition;
varying float cameraDistance;

// three's OWN skinning declarations: `bindMatrix`, `bindMatrixInverse`, `boneTexture` and
// `getBoneMatrix`, guarded by `USE_SKINNING` inside the chunk itself. `common-main.glsl` calls
// getBoneMatrix; this is where it comes from.
//
// It used to be hand-rolled here, and it read two uniforms three does not have -- `boneTextureWidth`
// and `boneTextureHeight`. Three supplies the bone texture but derives its size in GLSL
// (`textureSize(boneTexture, 0)`); a uniform nothing uploads reads as ZERO, so `mod(j, 0.0)` gave NaN
// and `1.0 / 0.0` gave Inf. Every bone matrix came back NaN, `gl_Position` with it, and the GPU
// discarded every vertex -- so the draw call was issued and covered nothing.
//
// That failure is completely silent. It compiles, it links, it raises no warning, `onAfterRender`
// still fires, and every uniform still reads correct from JS because none of them reaches the shader.
// A skinned body drew nothing while static doodads, which never enter this path, were fine.
//
// Delegated rather than corrected: three has changed how bone matrices reach the shader more than
// once (boneTextureSize, then boneTextureWidth/Height, now textureSize), and any version we
// hand-write here will drift again on the next upgrade.
#include <skinning_pars_vertex>

vec2 envMapSphere(in vec3 cameraVertex, in vec3 normal) {
  vec3 cameraNormal = (modelViewMatrix * vec4(normal, 0.0)).xyz;

  vec3 normPos = -(normalize(cameraVertex));
  vec3 temp = reflect(normPos, cameraNormal);
  temp.z += 1.0;

  vec2 coord = ((normalize(temp).xy * 0.5) + vec2(0.5));

  return coord;
}
