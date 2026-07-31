uniform sampler2D textures[2];
uniform vec4 materialParams;
uniform float alphaTestValue;

varying vec2 coords[2];
varying vec4 vertexColorOut;
varying vec3 worldNormal;
varying vec4 fog;

// The scene light, pushed by MapLight. `sunParams.xyz` is the direction light TRAVELS, so the
// to-light vector is its negation.
uniform vec4 sunParams;
uniform vec3 sunDiffuseColor;
uniform vec3 sunAmbientColor;

// 0 for a material whose lighting is off (MOMT F_UNLIT).
uniform float lightModifier;

