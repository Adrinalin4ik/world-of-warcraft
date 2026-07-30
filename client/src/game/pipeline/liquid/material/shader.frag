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
// vec3, not vec4: these are supplied as THREE.Color, which has no .w component, so a vec4
// declaration leaves them uploaded as zero.
uniform vec3 fogColor;

uniform vec4 sunParams;
uniform vec3 sunDiffuseColor;
uniform vec3 sunAmbientColor;

uniform int indoor;

// Magma and slime emit their own light: LiquidType.dbc gives them no colour band, and in the client
// they stay bright regardless of how dark the room around them is. Scene lighting and specular
// highlights both get skipped for them.
uniform int selfIlluminated;

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

  // The square root that used to widen this is gone. Water is close to a flat plane, so the half
  // vector barely changes across it; halving the exponent turned a shininess-64 highlight into a
  // sheet that covered the whole surface and slid around with the camera, which read as the water
  // changing colour whenever the view turned. A tight highlight is the point of a glint.

  return specularColor * specularFactor;
}

 vec4 applyFog(vec4 color) {
  // fogParams is packed by the light system as (-fogStep, fogEnd * fogStep, exponent, 1), so this
  // ramp runs from 1 at fogStart down to 0 at fogEnd -- it is the *clarity*, not the fog amount.
  //
  // Using it directly as the mix factor therefore inverted the fog: liquid nearest the camera was
  // blended 100% to the fog colour while distant liquid stayed clear. Because that colour is uniform,
  // the whole surface came out as one flat tone with no texture and no response to UVs at all -- a
  // Blackrock lava pool rendered as a single dark red sheet.
  //
  // Same derivation as the ADT chunk shader, which had it right.
  float f1 = (cameraDistance * fogParams.x) + fogParams.y;
  float fogFactor = 1.0 - min(pow(max(f1, 0.0), fogParams.z), 1.0);

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

  // Molten rock is not a mirror. This highlight was inert until the liquid geometry gained a real
  // normal attribute -- before that `lightNormal` was NaN and the glint silently multiplied out to
  // nothing -- so switching normals on is what made lava suddenly look wet and over-reflective.
  vec3 specular = selfIlluminated == 1
    ? vec3(0.0)
    : createSpecularLight(lightNormal, sunParams.xyz, viewDirection, specularColor, shininess);

  // Deliberately not folded into globalLight: that value multiplies the water color, so a
  // view-dependent warm specular scaled the base color and made the surface shift hue as the camera
  // turned. Glints are added after lighting instead, further down.

   // Sample the water texture
   vec4 textureColor = texture2D(texture_sampler, vUv);
   
   // For water, prioritize vertex colors over texture colors
   // This ensures our fallback colors are used properly
   vec4 color = textureColor;
   
   // Use WoW-style blending logic based on blending mode
   float vertexBrightness = (vertexColor.r + vertexColor.g + vertexColor.b) / 3.0;
   
   if (vertexBrightness < 0.01) {
     // Nothing tinting this surface, so show the texture as authored. This is the magma and slime
     // path: they are self-illuminated, have no colour band in the light database, and the material
     // deliberately clears useBaseColor for them. It used to substitute a flat blue here, which threw
     // the texture away entirely and turned every untinted liquid into a featureless sheet.
     color.rgb = textureColor.rgb;
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

   // Self-illuminated liquids keep their texture's own brightness. Multiplying lava by a dim Blackrock
  // interior ambient turned a glowing orange pool into dark brown rock.
  if (lightModifier > 0.0 && selfIlluminated == 0) {
    if (indoor == 1) {
      color = lightIndoor(color, vertexColor, globalLight);
    } else {
      color = lightOutdoor(color, vertexColor, globalLight);
    }
  }

   // Additive glint, so it brightens the highlight without tinting the water underneath.
   color.rgb = clamp(color.rgb + specular, 0.0, 1.0);

   color = applyFog(color);

   gl_FragColor = color;
}