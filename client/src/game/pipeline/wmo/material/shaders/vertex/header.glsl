// THREE's built-in color attribute is a vec3, but Wowser needs RGBA.
attribute vec4 acolor;

uniform vec4 fogParams;
// vec3, not vec4: WMOMaterial supplies these as THREE.Color, which has no .w component, so a vec4
// declaration leaves them uploaded as zero.
uniform vec3 fogColor;

uniform vec4 sunParams;
uniform vec3 sunDiffuseColor;
uniform vec3 sunAmbientColor;

uniform vec4 materialParams;

varying vec2 coords[2];
// The lighting inputs the fragment stage needs. The reference evaluates N.L per fragment, so the
// vertex stage hands over the raw normal and MOCV rather than a pre-lit colour.
varying vec4 vertexColorOut;
varying vec3 worldNormal;
varying vec4 fog;
