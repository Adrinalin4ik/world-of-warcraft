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

// MOMT F_SIDN: the authored emissive colour, already normalized to 0..1 by laws.ts. Black on a
// material without the flag.
uniform vec3 sidnColor;

// The live night fraction: 1 overnight, 0 by day, ramping 20:30-21:30 and 06:00-07:00.
uniform float sidnNight;

// MOMT F_WINDOW: 1 for a window pane, 0 otherwise.
uniform float windowFlag;

// Debug-panel look deviation, NOT part of the reference: a flat multiplier on every WMO lane's
// final colour. 1.0 is faithful. Exists because the INT lane's law -- clamp(tex * MOCV * (1 + 4 *
// MOCV.a)) -- has no scene-light term at all, so there is nothing to raise for zones the artists
// baked very dark (Blackrock's lava caverns, e.g.). See applyWmoLighting for where it is applied.
uniform float wmoBrightness;

