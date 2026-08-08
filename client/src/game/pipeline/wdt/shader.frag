precision highp float;

// Texture uniforms
uniform sampler2D diffuseTexture;
uniform sampler2D normalTexture;
uniform sampler2D specularTexture;
uniform sampler2D detailTexture;

// Material uniforms
uniform vec4 materialParams; // [shininess, specular, detail, unused]
uniform vec3 diffuseColor;
uniform vec3 specularColor;
uniform float alpha;

// New light system uniforms
uniform vec3 sunDir;
uniform vec3 sunDiffuseColor;
uniform vec3 sunAmbientColor;

// Fog uniforms
uniform vec4 fogParams; // [fogStep, fogEnd, unused, unused]
uniform vec3 fogColor;

// Terrain uniforms
uniform float terrainScale;
uniform vec2 terrainOffset;
uniform float detailScale;

// Varying inputs
varying vec2 vTexCoord;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec3 vViewNormal;
varying float vCameraDistance;
varying vec4 vVertexColor;

// Lighting function
vec3 applyLighting(vec3 color, vec3 normal, vec3 viewDir) {
  // Calculate lighting factor
  float lightFactor = clamp(dot(normal, -sunDir), 0.0, 1.0);
  
  // Combine diffuse and ambient lighting
  vec3 sunColor = clamp((sunDiffuseColor * lightFactor) + sunAmbientColor, 0.0, 1.0);
  
  // Apply lighting
  return color * sunColor;
}

// Specular lighting
vec3 applySpecular(vec3 normal, vec3 viewDir, vec3 specularColor, float shininess) {
  vec3 reflectDir = reflect(sunDir, normal);
  float spec = pow(max(dot(viewDir, reflectDir), 0.0), shininess);
  return specularColor * spec;
}

// Fog function
vec3 applyFog(vec3 color) {
  // Calculate fog factor using the new fog system
  float fogFactor = (vCameraDistance * fogParams.x) + fogParams.y;
  fogFactor = max(fogFactor, 0.0);
  fogFactor = min(fogFactor, 1.0);
  
  // Apply fog
  return mix(color, fogColor, fogFactor);
}

// Detail texture blending
vec3 applyDetailTexture(vec3 color, vec2 texCoord) {
  vec4 detail = texture2D(detailTexture, texCoord * detailScale);
  return mix(color, color * detail.rgb, detail.a * materialParams.z);
}

void main() {
  // Sample base texture
  vec4 baseColor = texture2D(diffuseTexture, vTexCoord);
  
  // Apply vertex color
  baseColor.rgb *= vVertexColor.rgb;
  baseColor.a *= vVertexColor.a;
  
  // Apply diffuse color
  baseColor.rgb *= diffuseColor;
  
  // Apply detail texture
  baseColor.rgb = applyDetailTexture(baseColor.rgb, vTexCoord);
  
  // Calculate view direction
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  
  // Apply lighting
  vec3 normal = normalize(vWorldNormal);
  baseColor.rgb = applyLighting(baseColor.rgb, normal, viewDir);
  
  // Apply specular highlights
  if (materialParams.y > 0.0) {
    vec3 specular = applySpecular(normal, viewDir, specularColor, materialParams.x);
    baseColor.rgb += specular * materialParams.y;
  }
  
  // Apply fog
  baseColor.rgb = applyFog(baseColor.rgb);
  
  // Set alpha
  baseColor.a *= alpha;
  
  // Clamp final color
  baseColor.rgb = clamp(baseColor.rgb, 0.0, 1.0);
  
  gl_FragColor = baseColor;
}


