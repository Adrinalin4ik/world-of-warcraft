#include <common>

uniform int layerCount;
uniform sampler2D alphaMaps[4];
uniform sampler2D textures[4];

varying vec4 fog;
varying vec2 vUv;
varying vec2 vUvAlpha;

varying vec3 vertexNormal;
varying vec3 vertexWorldPosition;
varying float cameraDistance;

uniform float lightModifier;
uniform vec3 ambientLight;
uniform vec3 diffuseLight;

// uniform float fogModifier;
// uniform float fogStart;
// uniform float fogEnd;
// uniform vec3 fogColor;

uniform vec4 sunParams;
uniform vec4 sunDiffuseColor;
uniform vec4 sunAmbientColor;
uniform vec4 materialParams;

uniform vec4 fogParams;
uniform vec4 fogColor;

// vec3 saturate(vec3 value) {
//   vec3 result = clamp(value, 0.0, 1.0);
//   return result;
// }

// float saturate(float value) {
//   float result = clamp(value, 0.0, 1.0);
//   return result;
// }

vec3 createLight(in vec3 normal, in vec3 direction, in vec3 diffuseColor, in vec3 ambientColor) {
  float factor = saturate(dot(-direction.xyz, normalize(normal.xyz)));

  vec3 light = saturate((diffuseColor.rgb * factor) + ambientColor.rgb);

  return light;
}

vec3 createSpecularLight(in vec3 normal, in vec3 direction, in vec3 viewDirection, in vec3 specularColor, in float shininess) {
  // direction points FROM sun TO surface, so we need -direction for light direction
  vec3 lightDirection = -direction;
  vec3 halfVector = normalize(lightDirection + viewDirection);
  float specularFactor = pow(max(dot(normalize(normal), halfVector), 0.0), shininess);
  
  // Make specular more dramatic and responsive to camera angle
  specularFactor = pow(specularFactor, 0.5); // Square root to make it more spread out
  
  return specularColor * specularFactor;
}

vec4 applyFog(vec4 color) {
  float f1 = (cameraDistance * fogParams.x) + fogParams.y;
  float f2 = max(f1, 0.0);
  float f3 = pow(f2, fogParams.z);
  float f4 = min(f3, 1.0);

  float fogFactor = 1.0 - f4;
  
  color.rgb = mix(color.rgb, fogColor.rgb, fogFactor);

  return color;
}

vec4 finalizeColor(vec4 color) {
  // if (fogModifier > 0.0) {
    color = applyFog(color);
  // }

  return color;
}

// Given a light direction and normal, return a directed diffuse light.
vec3 getDirectedDiffuseLight(vec3 lightDirection, vec3 lightNormal, vec3 diffuseLight) {
  float light = dot(lightNormal, -lightDirection);

  if (light < 0.0) {
    light = 0.0;
  } else if (light > 0.5) {
    light = 0.5 + ((light - 0.5) * 0.65);
  }

  vec3 directedDiffuseLight = diffuseLight.rgb * light;

  return directedDiffuseLight;
}

// Given a layer, light it with diffuse and ambient light.
vec4 lightLayer(vec4 color, vec3 light) {
  if (lightModifier > 0.0) {
    color.rgb *= light;
    color.rgb = saturate(color.rgb);
  }

  return color;
}

// Given a color, light it, and blend it with a layer.
vec4 lightAndBlendLayer(vec4 color, vec4 layer, vec4 blend, vec3 light) {
  layer = lightLayer(layer, light);
  color = (layer * blend.r) + ((1.0 - blend.r) * color); //use r color instead of a, because of RedFormat of material
  
  return color;
}

void main() {
  vec3 lightNormal = normalize(vertexNormal);
  vec3 viewDirection = normalize(cameraPosition - vertexWorldPosition);

  #if USE_LIGHTING == 1
    // Use dynamic sun direction from WorldLight system
    vec3 light = createLight(vertexNormal.xyz, sunParams.xyz, sunDiffuseColor.rgb, sunAmbientColor.rgb);
    
    // Add specular highlights for sun glints
    vec3 specularColor = vec3(0.4, 0.35, 0.3); // Moderate warm white for realistic glints
    float shininess = 16.0; // Realistic shininess for terrain surfaces
    vec3 specular = createSpecularLight(vertexNormal.xyz, sunParams.xyz, viewDirection, specularColor, shininess);
    
    light += specular;
    light = mix(light, vec3(1.0, 1.0, 1.0), 1.0 - materialParams.y);
  #else
    vec3 light = vec3(1.0, 1.0, 1.0);
  #endif
  
  vec4 layer;
  vec4 blend;

  // Base layer
  vec4 color = texture2D(textures[0], vUv);
  color = lightLayer(color, light);

  // 2nd layer
  if (layerCount > 1) {
    layer = texture2D(textures[1], vUv);
    blend = texture2D(alphaMaps[0], vUvAlpha);

    color = lightAndBlendLayer(color, layer, blend, light);
  }

  // // 3rd layer
  if (layerCount > 2) {
    layer = texture2D(textures[2], vUv);
    blend = texture2D(alphaMaps[1], vUvAlpha);

    color = lightAndBlendLayer(color, layer, blend, light);
  }

  // // 4th layer
  if (layerCount > 3) {
    layer = texture2D(textures[3], vUv);
    blend = texture2D(alphaMaps[2], vUvAlpha);

    color = lightAndBlendLayer(color, layer, blend, light);
  }


  color = finalizeColor(color);

  gl_FragColor = color;
}
