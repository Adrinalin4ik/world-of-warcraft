precision highp float;

// Texture uniforms
uniform int textureCount;
uniform sampler2D textures[4];

// Material uniforms
uniform vec4 materialParams; // [alpha, alphaTest, lighting, fog]

// New light system uniforms
uniform vec3 sunDir;
uniform vec3 sunDiffuseColor;
uniform vec3 sunAmbientColor;

// Fog uniforms
uniform vec4 fogParams; // [fogStep, fogEnd, unused, unused]
uniform vec3 fogColor;

// Animation uniforms
uniform float animatedTransparency;

// Varying inputs
varying vec2 vTexCoord1;
varying vec2 vTexCoord2;
varying vec3 vViewNormal;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
varying float vCameraDistance;
varying vec4 vVertexColor;

// Texture combination functions
void combineOpaque(inout vec4 color, in vec4 tex0) {
  color.rgb = color.rgb * tex0.rgb;
}

void combineAdd(inout vec4 color, in vec4 tex0) {
  color.rgb = color.rgb + tex0.rgb;
  color.a = color.a + tex0.a;
}

void combineDecal(inout vec4 color, in vec4 tex0) {
  color.rgb = mix(color.rgb, tex0.rgb, color.a);
}

void combineFade(inout vec4 color, in vec4 tex0) {
  color.rgb = mix(tex0.rgb, color.rgb, color.a);
}

void combineMod(inout vec4 color, in vec4 tex0) {
  color.rgb = color.rgb * tex0.rgb;
  color.a = color.a * tex0.a;
}

void combineMod2x(inout vec4 color, in vec4 tex0) {
  color.rgb = color.rgb * tex0.rgb * 2.0;
  color.a = color.a * tex0.a * 2.0;
}

void combineOpaqueOpaque(inout vec4 color, in vec4 tex0, in vec4 tex1) {
  color.rgb = (color.rgb * tex0.rgb) * tex1.rgb;
}

void combineOpaqueAdd(inout vec4 color, in vec4 tex0, in vec4 tex1) {
  color.rgb = (color.rgb * tex0.rgb) + tex1.rgb;
  color.a = color.a + tex1.a;
}

void combineOpaqueAddAlpha(inout vec4 color, in vec4 tex0, in vec4 tex1) {
  color.rgb = (color.rgb * tex0.rgb) + (tex1.rgb * tex1.a);
}

void combineOpaqueAddAlphaAlpha(inout vec4 color, in vec4 tex0, in vec4 tex1) {
  color.rgb = (color.rgb * tex0.rgb) + (tex1.rgb * tex1.a * tex0.a);
}

void combineOpaqueMod(inout vec4 color, in vec4 tex0, in vec4 tex1) {
  color.rgb = (color.rgb * tex0.rgb) * tex1.rgb;
  color.a = color.a * tex1.a;
}

void combineOpaqueMod2x(inout vec4 color, in vec4 tex0, in vec4 tex1) {
  color.rgb = (color.rgb * tex0.rgb) * tex1.rgb * 2.0;
  color.a = color.a * tex1.a * 2.0;
}

void combineOpaqueMod2xNa(inout vec4 color, in vec4 tex0, in vec4 tex1) {
  color.rgb = (color.rgb * tex0.rgb) * tex1.rgb * 2.0;
}

void combineOpaqueMod2xNaAlpha(inout vec4 color, in vec4 tex0, in vec4 tex1) {
  color.rgb = (color.rgb * tex0.rgb) * mix(tex1.rgb * 2.0, vec3(1.0), tex0.a);
}

void combineModOpaque(inout vec4 color, in vec4 tex0, in vec4 tex1) {
  color.rgb = (color.rgb * tex0.rgb) * tex1.rgb;
  color.a = color.a * tex0.a;
}

void combineModMod(inout vec4 color, in vec4 tex0, in vec4 tex1) {
  color.rgb = (color.rgb * tex0.rgb) * tex1.rgb;
  color.a = (color.a * tex0.a) * tex1.a;
}

void combineModAdd(inout vec4 color, in vec4 tex0, in vec4 tex1) {
  color.rgb = (color.rgb * tex0.rgb) + tex1.rgb;
  color.a = (color.a * tex0.a) + tex1.a;
}

void combineModMod2x(inout vec4 color, in vec4 tex0, in vec4 tex1) {
  color.rgb = (color.rgb * tex0.rgb) * tex1.rgb * 2.0;
  color.a = (color.a * tex0.a) * tex1.a * 2.0;
}

// Lighting function
vec3 applyLighting(vec3 color) {
  vec3 viewNormal = vViewNormal;
  
  #ifdef DOUBLE_SIDED
    float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
    viewNormal *= faceDirection;
  #endif
  
  // Calculate lighting factor
  float lightFactor = clamp(dot(viewNormal, -sunDir), 0.0, 1.0);
  
  // Combine diffuse and ambient lighting
  vec3 sunColor = clamp((sunDiffuseColor * lightFactor) + sunAmbientColor, 0.0, 1.0);
  
  // Apply lighting based on material params
  return mix(color, color * sunColor, materialParams.z);
}

// Fog function
vec3 applyFog(vec3 color) {
  // Calculate fog factor using the new fog system
  float fogFactor = (vCameraDistance * fogParams.x) + fogParams.y;
  fogFactor = max(fogFactor, 0.0);
  fogFactor = min(fogFactor, 1.0);
  
  // Apply fog
  return mix(color, fogColor, fogFactor * materialParams.w);
}

// Alpha test function
void applyAlphaTest(vec4 color) {
  #ifdef ALPHA_TO_COVERAGE
    color.a = smoothstep(materialParams.y, materialParams.y + fwidth(color.a), color.a);
    if (color.a == 0.0) {
      discard;
    }
  #else
    if (color.a < materialParams.y) {
      discard;
    }
  #endif
}

void main() {
  // Initialize color
  vec4 color = vec4(1.0, 1.0, 1.0, 1.0);
  
  // Apply vertex color
  color.rgb *= vVertexColor.rgb;
  color.a *= vVertexColor.a;
  
  // Apply animated transparency
  color.a *= animatedTransparency;
  
  // Apply textures based on texture count
  if (textureCount >= 1) {
    vec4 tex0 = texture2D(textures[0], vTexCoord1);
    
    if (textureCount == 1) {
      combineOpaque(color, tex0);
    } else if (textureCount >= 2) {
      vec4 tex1 = texture2D(textures[1], vTexCoord2);
      
      // Use different combination functions based on material type
      // This would be determined by the material definition
      combineOpaqueOpaque(color, tex0, tex1);
    }
  }
  
  // Apply alpha test
  applyAlphaTest(color);
  
  // Apply lighting
  color.rgb = applyLighting(color.rgb);
  
  // Apply fog
  color.rgb = applyFog(color.rgb);
  
  // Clamp final color
  color.rgb = clamp(color.rgb, 0.0, 1.0);
  
  gl_FragColor = color;
}


