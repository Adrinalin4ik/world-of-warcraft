varying vec2 vUv;

uniform sampler2D texture_sampler;

varying vec4 vertexColor;
varying vec3 vertexWorldNormal;
varying vec3 vertexWorldPosition;
varying float cameraDistance;

uniform int textureCount;
uniform sampler2D textures[4];
uniform int blendingMode;

uniform float lightModifier;
uniform vec3 ambientLight;
uniform vec3 diffuseLight;

uniform vec4 fogParams;
uniform vec4 fogColor;

uniform vec4 sunParams;
uniform vec4 sunDiffuseColor;
uniform vec4 sunAmbientColor;

uniform int indoor;

 // // Given a light direction and normal, return a directed diffuse light.
vec3 createGlobalLight(vec3 lightDirection, vec3 lightNormal, vec3 diffuseLight, vec3 ambientLight) {
  // Use dynamic sun direction from WorldLight system
  vec3 sunDir = sunParams.xyz;
  vec3 sunLight = sunDiffuseColor.rgb;
  
  float light = dot(lightNormal, -sunDir);

   if (light < 0.0) {
    light = 0.0;
  } else if (light > 0.5) {
    light = 0.5 + ((light - 0.5) * 0.65);
  }

   vec3 directedDiffuseLight = sunLight * light;

   directedDiffuseLight.rgb += sunAmbientColor.rgb;
  directedDiffuseLight = clamp(directedDiffuseLight, 0.0, 1.0);

   return directedDiffuseLight;
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

 vec4 applyFog(vec4 color) {
  // Use light system's fog calculation
  // fogParams: [-(1.0/fogRange), (1.0/fogRange)*fogEnd, 1.0, 0.0]
  // fogColor: [r, g, b, a]
  
  float fogFactor = cameraDistance * fogParams.x + fogParams.y;
  fogFactor = clamp(fogFactor, 0.0, 1.0);
  
  // Apply fog color mixing
  color.rgb = mix(color.rgb, fogColor.rgb, fogFactor);

   return color;
}

 vec4 lightIndoor(vec4 color, vec4 vertexColor, vec3 light) {
  vec3 groupColor = vertexColor.rgb;

   vec3 indoorLight;

   indoorLight = (vertexColor.a * light.rgb) + ((1.0 - vertexColor.a) * groupColor);
  indoorLight.rgb = clamp(indoorLight.rgb, 0.0, 1.0);

   color.rgb *= indoorLight;

   return color;
}

 vec4 lightOutdoor(vec4 color, vec4 vertexColor, vec3 light) {
  vec3 outdoorLight = light.rgb + (vertexColor.rgb * 2.0);
  outdoorLight.rgb = clamp(outdoorLight.rgb, 0.0, 1.0);

   color.rgb *= outdoorLight;

   return color;
}

 void main() {
  vec3 lightNormal = normalize(vertexWorldNormal);
  vec3 viewDirection = normalize(cameraPosition - vertexWorldPosition);
  vec3 globalLight = createGlobalLight(vec3(0,0,0), lightNormal, diffuseLight, ambientLight);
  
  // Add specular highlights for water reflections
  vec3 specularColor = vec3(0.6, 0.55, 0.5); // Moderate white for realistic water glints
  float shininess = 64.0; // Realistic shininess for water surfaces
  vec3 specular = createSpecularLight(lightNormal, sunParams.xyz, viewDirection, specularColor, shininess);
  
  globalLight += specular;

   // Sample the water texture
   vec4 textureColor = texture2D(texture_sampler, vUv);
   
   // For water, prioritize vertex colors over texture colors
   // This ensures our fallback colors are used properly
   vec4 color = textureColor;
   
   // Use WoW-style blending logic based on blending mode
   float vertexBrightness = (vertexColor.r + vertexColor.g + vertexColor.b) / 3.0;
   
   if (vertexBrightness < 0.01) {
     // DBC colors are black, use a reasonable water color
     color.rgb = vec3(0.4, 0.6, 0.7);
   } else {
     // Apply WoW-style blending based on blending mode
     if (blendingMode == 0) {
       // Combiners_Mod: Multiply vertex color with texture color
       color.rgb = vertexColor.rgb * textureColor.rgb;
     } else if (blendingMode == 1) {
       // Combiners_Add: Add vertex color to texture color
       color.rgb = vertexColor.rgb + textureColor.rgb;
     } else {
       // Default: Use vertex color as base, add some texture influence
       color.rgb = mix(vertexColor.rgb, textureColor.rgb, 0.1);
     }
   }
   
   color.a = max(color.a, vertexColor.a);

   // Knock out transparent pixels in blending mode 1
   if (blendingMode == 1 && color.a < (10.0 / 255.0)) {
     discard;
   }

   if (lightModifier > 0.0) {
    if (indoor == 1) {
      color = lightIndoor(color, vertexColor, globalLight);
    } else {
      color = lightOutdoor(color, vertexColor, globalLight);
    }
  }

   color = applyFog(color);

   gl_FragColor = color;
}