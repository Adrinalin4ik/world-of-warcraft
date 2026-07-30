precision highp float;

varying vec2 vUv;

varying vec3 vertexWorldNormal;
varying vec3 vertexWorldPosition;
varying float cameraDistance;

attribute vec3 color;
attribute float alpha;

varying vec4 vertexColor;

uniform int indoor;

uniform int useBaseColor;
uniform vec3 baseColor;
uniform float baseAlpha;

uniform float uvScale;

 vec4 saturate(vec4 value) {
  vec4 result = clamp(value, 0.0, 1.0);
  return result;
}

 vec3 saturate(vec3 value) {
  vec3 result = clamp(value, 0.0, 1.0);
  return result;
}

 float saturate(float value) {
  float result = clamp(value, 0.0, 1.0);
  return result;
}

 void main() {
  // Liquid UVs arrive as tile indices, one texture repeat per 4.17-unit tile. That is dense enough
  // that the repeat reads as a visible grid of identical blobs across a large surface, which is not
  // how liquid looks in the client -- a lava pool there shows a few big slow-moving shapes.
  //
  // uvScale stretches the repeat over several tiles. This is matched by eye against a reference
  // capture rather than derived from the format; the nearest thing to an authority is
  // LiquidType.dbc's first shaderFloatAttribute, 0.025, whose reciprocal is a 40-unit repeat.
  //
  // V is negated rather than subtracted from 1: these BLPs upload as compressed DXT, which three.js
  // cannot flip for us, and with repeat wrapping a negation flips direction just as well while
  // surviving the scaling above.
  vUv = vec2(uv.x, -uv.y) * uvScale;

   vertexColor = vec4(color, alpha);

   // Applied wherever the liquid is, not just indoors. baseColor now carries the river or ocean tint
   // from the light database, and outdoor water needs it just as much -- gated on `indoor` it never
   // reached open water, which then fell through to a flat hardcoded blue in the fragment stage.
   // Alpha still only gets the indoor treatment, since that was about interior water opacity.
   if (useBaseColor == 1) {
    vertexColor.rgb = clamp(vertexColor.rgb + baseColor.rgb, 0.0, 1.0);

    if (indoor == 1) {
      vertexColor.a = clamp(mod(vertexColor.a, 1.0) + (1.0 - baseAlpha), 0.0, 1.0);
    }
  }

   // No `vec3` here: that declared a local shadowing the varying of the same name, so the varying went
  // to the fragment stage unwritten and its viewDirection -- hence every specular glint -- was
  // computed from garbage.
  vertexWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  cameraDistance = distance(cameraPosition, vertexWorldPosition);

   vertexWorldNormal = (modelMatrix * vec4(normal, 0.0)).xyz;

   gl_Position = projectionMatrix *
                modelViewMatrix *
                vec4(position, 1.0);
}