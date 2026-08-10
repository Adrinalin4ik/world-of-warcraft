uniform int fragmentShaderMode;

uniform int textureCount;
uniform sampler2D textures[4];

varying vec2 uv1;
varying vec2 uv2;

varying float cameraDistance;

varying vec3 vertexWorldNormal;

varying vec4 animatedVertexColor;
uniform float animatedTransparency;

uniform float alphaKey;

uniform float lightModifier;
uniform vec3 ambientLight;
uniform vec3 diffuseLight;

uniform float fogModifier;
uniform float fogStart;
uniform float fogEnd;
uniform vec3 fogColor;

uniform int blendingMode;

vec4 fragCombinersWrath1Pass(sampler2D texture1, vec2 uv1) {
  vec4 texture1Color = texture2D(texture1, uv1);

  if (alphaKey == 1.0 && texture1Color.a <= 0.5) {
    discard;
  }

  vec4 c1 = texture1Color;

  // Apply animated transparency (defaults to 1.0)
  c1.a *= animatedTransparency;

  // Blend with vertex color using BGR channel swapping (WoW style)
  vec3 vertexColorBGR = animatedVertexColor.bgr;
  c1.rgb *= (vertexColorBGR * animatedVertexColor.a);

  // Restore full color intensity after blending with vertexColor
  c1.rgb *= 2.0;

  // Force transparent pixels to fully opaque if in opaque blending mode (0). Needed to prevent
  // transparent pixels from becoming inappropriately bright.
  if (blendingMode == 0) {
    c1.a = 1.0;
  }

  vec4 outputColor = c1;

  return outputColor;
}

vec4 fragCombinersWrath2Pass(sampler2D texture1, vec2 uv1, sampler2D texture2, vec2 uv2) {
  vec4 texture1Color = texture2D(texture1, uv1);
  vec4 texture2Color = texture2D(texture2, uv2);

  if (alphaKey == 1.0 && texture1Color.a <= 0.5) {
    discard;
  }

  vec4 c1 = texture1Color;
  vec4 c2 = texture2Color;

  // Apply animated transparency (defaults to 1.0)
  c1.a *= animatedTransparency;

  // Blend texture alphas
  c1.a *= c2.a;

  // Blend with vertex color using BGR channel swapping (WoW style)
  vec3 vertexColorBGR = animatedVertexColor.bgr;
  c1.rgb *= (vertexColorBGR * animatedVertexColor.a);

  // Restore full color intensity after blending with vertexColor
  c1.rgb *= 2.0;

  vec4 outputColor = c1;

  return outputColor;
}

vec3 createSpecularLight(vec3 normal, vec3 direction, vec3 viewDirection, vec3 specularColor, float shininess) {
  // direction points FROM sun TO surface, so we need -direction for light direction
  vec3 lightDirection = -direction;
  vec3 halfVector = normalize(lightDirection + viewDirection);
  float specularFactor = pow(max(dot(normalize(normal), halfVector), 0.0), shininess);
  
  // Make specular more dramatic and responsive to camera angle
  specularFactor = pow(specularFactor, 0.5); // Square root to make it more spread out
  
  return specularColor * specularFactor;
}

vec4 applyDiffuseLighting(vec4 color) {
  // Use dynamic sun direction from WorldLight system
  vec3 sunDir = sunParams.xyz;
  vec3 sunLight = sunDiffuseColor.rgb;
  vec3 viewDirection = normalize(cameraPosition - vertexWorldPosition);
  
  float light = clamp(dot(vertexWorldNormal, normalize(-sunDir)), 0.0, 1.0);

  vec3 diffusion = sunLight * light;
  diffusion += sunAmbientColor.rgb;
  
  // Add specular highlights for model glints
  vec3 specularColor = vec3(0.3, 0.28, 0.25); // Subtle warm white for realistic glints
  float shininess = 32.0; // Realistic shininess for character/object surfaces
  vec3 specular = createSpecularLight(vertexWorldNormal, sunDir, viewDirection, specularColor, shininess);
  
  diffusion += specular;
  diffusion = clamp(diffusion, 0.0, 1.0);

  color.rgb *= diffusion;

  return color;
}

vec4 applyFog(vec4 color) {
  // Use consistent fog calculation with the lighting system
  vec3 fogColorVec = fogColor;
  
  float fogFactor = (fogEnd - cameraDistance) / (fogEnd - fogStart);
  fogFactor = 1.0 - clamp(fogFactor, 0.0, 1.0);
  float fogColorFactor = fogFactor * fogModifier;

  // Only mix fog color for simple blending modes.
  if (blendingMode <= 2) {
    color.rgb = mix(color.rgb, fogColorVec, fogColorFactor);
  }

  // Ensure certain blending mode pixels become fully opaque by fog end.
  if (cameraDistance >= fogEnd) {
    color.rgb = fogColorVec;
    color.a = 1.0;
  }

  // Ensure certain blending mode pixels fade out as fog increases.
  if (blendingMode >= 2 && blendingMode < 6) {
    color.a *= 1.0 - fogFactor;
  }

  return color;
}

vec4 finalizeColor(vec4 color) {
  if (lightModifier > 0.0) {
    color = applyDiffuseLighting(color);
  }

  color = applyFog(color);

  return color;
}

void main() {
  vec4 color;

  // -1 = unknown / unhandled
  // Stopgap until all shaders are implemented and verified

  if (fragmentShaderMode == -1) {
    color = texture2D(textures[0], uv1);
  } else if (fragmentShaderMode == 0) {
    color = fragCombinersWrath1Pass(textures[0], uv1);
  } else if (fragmentShaderMode == 1) {
    color = fragCombinersWrath2Pass(textures[0], uv1, textures[1], uv2);
  }

  // Apply lighting and fog.
  color = finalizeColor(color);

  gl_FragColor = color;
}

// same name and type as VS
// varying vec3 vNormal;

// void main() {

//   // calc the dot product and clamp
//   // 0 -> 1 rather than -1 -> 1
//   vec3 light = vec3(0.5, 0.2, 1.0);

//   // ensure it's normalized
//   light = normalize(light);

//   // calculate the dot product of
//   // the light to the vertex normal
//   float dProd = max(0.0,
//                     dot(vNormal, light));

//   // feed into our frag colour
//   gl_FragColor = vec4(dProd, // R
//                       dProd, // G
//                       dProd, // B
//                       1.0);  // A

// }
