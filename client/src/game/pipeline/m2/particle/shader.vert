precision highp float;

attribute vec3 iOffset;
attribute vec2 iScale;
attribute float iRotation;
attribute vec4 iColor;
attribute vec4 iUvRect;

varying vec2 vUv;
varying vec4 vColor;

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
  vUv = iUvRect.xy + (position.xy + 0.5) * iUvRect.zw;
  vColor = iColor;

  gl_Position = projectionMatrix * viewCenter;
}
