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
varying float cameraDistance;

#ifdef USE_SKINNING
	uniform mat4 bindMatrix;
	uniform mat4 bindMatrixInverse;

	#ifdef BONE_TEXTURE
		uniform sampler2D boneTexture;
		uniform int boneTextureWidth;
		uniform int boneTextureHeight;

		mat4 getBoneMatrix( const in float i ) {
			float j = i * 4.0;
			float x = mod( j, float( boneTextureWidth ) );
			float y = floor( j / float( boneTextureWidth ) );

			float dx = 1.0 / float( boneTextureWidth );
			float dy = 1.0 / float( boneTextureHeight );

			y = dy * ( y + 0.5 );

			vec4 v1 = texture2D( boneTexture, vec2( dx * ( x + 0.5 ), y ) );
			vec4 v2 = texture2D( boneTexture, vec2( dx * ( x + 1.5 ), y ) );
			vec4 v3 = texture2D( boneTexture, vec2( dx * ( x + 2.5 ), y ) );
			vec4 v4 = texture2D( boneTexture, vec2( dx * ( x + 3.5 ), y ) );

			mat4 bone = mat4( v1, v2, v3, v4 );

			return bone;
		}
	#else
		uniform mat4 boneGlobalMatrices[ MAX_BONES ];

		mat4 getBoneMatrix( const in float i ) {
			mat4 bone = boneGlobalMatrices[ int(i) ];
			return bone;
		}
	#endif
#endif

vec2 envMapSphere(in vec3 cameraVertex, in vec3 normal) {
  vec3 cameraNormal = (modelViewMatrix * vec4(normal, 0.0)).xyz;

  vec3 normPos = -(normalize(cameraVertex));
  vec3 temp = reflect(normPos, cameraNormal);
  temp.z += 1.0;

  vec2 coord = ((normalize(temp).xy * 0.5) + vec2(0.5));

  return coord;
}
