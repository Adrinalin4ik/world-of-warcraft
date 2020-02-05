// THREE's built-in color attribute is a vec3, but Wowser needs RGBA.
attribute vec4 acolor;

uniform vec4 fogParams;
uniform vec4 fogColor;

uniform vec4 sunParams;
uniform vec3 sunDiffuseColor;
uniform vec3 sunAmbientColor;

uniform vec4 materialParams;
uniform vec3 emissiveColor;

varying vec2 coords[2];
varying vec2 colors[2];
varying vec4 fog;
