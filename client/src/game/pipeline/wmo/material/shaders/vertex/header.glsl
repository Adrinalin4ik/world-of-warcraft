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
uniform vec4 emissiveColor;

varying vec2 coords[2];
varying vec4 colors[2];
varying vec4 fog;
