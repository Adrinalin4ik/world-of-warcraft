#pragma glslify: import('./header.glsl')
#pragma glslify: import('./functions.glsl')

vec4 createFog(in float cameraDistance) {
  float f1 = (cameraDistance * fogParams.x) + fogParams.y;
  float f2 = max(f1, 0.0);
  float f3 = pow(f2, fogParams.z);
  float f4 = min(f3, 1.0);

  float fogFactor = 1.0 - f4;

  vec4 fog;

  fog.rgb = fogColor.rgb;
  fog.a = fogFactor;

  return fog;
}

void main() {
  vec3 objectPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 objectNormal = (modelMatrix * vec4(normal, 0.0)).xyz;

  float cameraDistance = length(modelViewMatrix * vec4(position, 1.0));

  // t1 coordinate
  coords[0] = uv;

  // Fog
  fog = createFog(cameraDistance);

  #if USE_LIGHTING == 1
    vec3 light = createLight(objectNormal.xyz, sunParams.xyz, sunDiffuseColor.rgb, sunAmbientColor.rgb);
    light = mix(light, vec3(1.0, 1.0, 1.0), 1.0 - materialParams.y);
  #else
    vec3 light = vec3(1.0, 1.0, 1.0);
  #endif

  #if USE_VERTEX_COLOR == 1
    vec4 vertexColor = vec4(acolor.rgb, acolor.a);
  #else
    vec4 vertexColor = vec4(0.5, 0.5, 0.5, 1.0);
  #endif

  #if BATCH_TYPE == 1
    // Transition between vertex color and light based on vertex alpha
    colors[0].rgb = saturate(mix(vertexColor.rgb, light.rgb * 0.5, vertexColor.a) + emissiveColor.rgb);
    colors[0].a = vertexColor.a;
  #endif

  #if BATCH_TYPE == 2
    // Transition between vertex color and light, same shape as batch A above.
    //
    // This used to add vertexColor on top of the light instead of being replaced by it. Where MOCV
    // alpha is 0 -- genuine interior geometry -- both forms collapse to vertexColor, so nothing
    // changes indoors. Where alpha rises, meaning the surface is meant to be lit from outside, the
    // additive form floored the result at the baked colour and left buildings looking midday-bright
    // at midnight no matter what the map light said.
    colors[0].rgb = saturate(mix(vertexColor.rgb, light.rgb * 0.5, vertexColor.a) + emissiveColor.rgb);
    colors[0].a = vertexColor.a;
  #endif

  #if BATCH_TYPE == 3
    // Multiply vertex color and light
    colors[0].rgb = saturate((vertexColor.rgb * light.rgb) + emissiveColor.rgb);
    colors[0].a = vertexColor.a;
  #endif

  colors[1] = vec4(0.0);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
//1