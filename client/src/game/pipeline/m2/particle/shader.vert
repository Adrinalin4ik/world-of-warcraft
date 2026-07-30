precision highp float;

attribute vec3 iOffset;
attribute vec2 iScale;
attribute float iRotation;
attribute vec4 iColor;
attribute vec4 iUvRect;

varying vec2 vUv;
varying vec4 vColor;
varying float cameraDistance;

void main() {
  // `position` is the unit quad, spanning -0.5..0.5 in x and y with z = 0.
  vec2 corner = position.xy * iScale;

  float s = sin(iRotation);
  float c = cos(iRotation);
  vec2 spun = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);

  // Billboard: build the quad in view space so it always faces the camera, then let the projection
  // matrix do the rest. Taking the camera's right and up out of the view matrix is what keeps the quad
  // facing us without a per-particle lookAt on the CPU.
  vec4 viewCenter = viewMatrix * vec4(iOffset, 1.0);
  viewCenter.xy += spun;

  // position.xy spans -0.5..0.5, so +0.5 maps it to 0..1 within the atlas cell.
  //
  // Every texture is loaded with flipY = false (see texture-loader.js), so image row 0 lands at v = 0
  // -- v = 0 is the *top* of the source image. But position.y = +0.5 is up on screen, and a plain
  // `(position.y + 0.5)` would map "up" to v = 1, the *bottom* of the image, drawing every sprite
  // upside down (a flame's taper points the wrong way). Flipping the y term here, and only here,
  // corrects that without touching the cell selection (iUvRect.xy/zw) or the U axis. Do not "simplify"
  // this back to `position.xy + 0.5` -- it was tried, and it is wrong.
  vUv = iUvRect.xy + vec2(position.x + 0.5, 0.5 - position.y) * iUvRect.zw;
  vColor = iColor;

  // Distance from the camera to the particle's centre, in view space. The fog ramp in the fragment
  // shader is a function of this, and taking it from the billboard centre rather than per corner
  // keeps a single quad from being fogged unevenly across its own width.
  cameraDistance = length(viewCenter.xyz);

  gl_Position = projectionMatrix * viewCenter;
}
