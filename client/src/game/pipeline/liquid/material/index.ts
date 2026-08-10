import * as THREE from 'three';

import MapLight from '../../../world/light/MapLight';
import TextureLoader from '../../texture-loader';
import fragmentShader from './shader.frag';
import vertexShader from './shader.vert';

/**
 * LiquidType.dbc's type column (SoundBank). Decides which light band tints the surface.
 */
const LIQUID_TYPE = {
  RIVER: 0,
  OCEAN: 1,
  MAGMA: 2,
  SLIME: 3
};

class LiquidMaterial extends THREE.ShaderMaterial {

  /**
   * Liquid tiles spanned by one texture repeat. Eight is one ADT chunk's worth, which stops the
   * per-tile repeat reading as a grid and lands near the 40-unit repeat implied by LiquidType.dbc's
   * first shaderFloatAttribute (0.025). Chosen to match a reference capture, not read from the format.
   */
  static UV_TILES_PER_REPEAT = 8.0;

  /**
   * Flipbook rate. Liquid texture sets are 30 frames, so this runs one full cycle per second. Tune
   * here rather than per material -- every liquid in the game shares this.
   */
  static FRAMES_PER_SECOND = 30.0;

  /**
   * Magma and slime carry their own light in the client: they stay bright in unlit rooms and take no
   * specular highlight. Keyed off the same SoundBank column that decides the water tint.
   */
  static isSelfIlluminated(type): boolean {
    const soundBank = type && type.data ? type.data.type : 0;

    return soundBank === LIQUID_TYPE.MAGMA || soundBank === LIQUID_TYPE.SLIME;
  }

  textureType: any;
  textureIndex: number;
  textures = [];
  animationTime = 0;
  private mapLight: MapLight | null = null;
  
  constructor(type) {
    super();

    this.textureType = type;

    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;

    this.side = THREE.BackSide;
    this.transparent = true;

    this.textureIndex = 0;
    this.textures = [];

    // Starting values only. Both are replaced by the light database on the first light update:
    // baseColor by the river or ocean band in updateWaterColor, fogColor by the map fog. They matter
    // just for the frame or two before a MapLight is attached, so a neutral water blue will do.
    //
    // LiquidType.dbc's own colour pair is not consulted here. It is zeroed for effectively every type
    // in 3.3.5a, and reading it only ever produced the constant that used to sit in this spot.
    const baseColor = new THREE.Color(0.25, 0.5, 0.8);
    const fogColor = new THREE.Color(0.25, 0.5, 0.8);

    // Default blend mode for liquids (0 = Combiners_Mod - multiply)
    const blendMode = type.blendMode !== undefined ? type.blendMode : 0;
    
    this.uniforms = {
      texture_sampler: { value: null },
      blendingMode: { value: blendMode },
      
      // Debug: Log the blending mode being used
      _debugBlendMode: { value: (() => {
        return blendMode;
      })() },
      

      useBaseColor: { value: 1 },
      baseColor: { value: baseColor },
      baseAlpha: { value: 0.1 },

       // Managed by light manager
      lightModifier: { value: 1.0 },
      ambientLight: { value: new THREE.Color(0.5, 0.6, 0.7) },
      diffuseLight: { value: new THREE.Color(0.3, 0.5, 0.7) },

       // Use light system's fog uniforms
      fogParams: { value: new THREE.Vector4() },
      fogColor: { value: new THREE.Color() },
      
      // Sun direction and colors from MapLight system
      sunParams: { value: new THREE.Vector4() },
      sunDiffuseColor: { value: new THREE.Color() },
      sunAmbientColor: { value: new THREE.Color() },
      
      // WMO interior/exterior flag
      indoor: { value: 0 },

      // Set from LiquidType's SoundBank in updateWaterColor. Seeded here too, so magma and slime are
      // never lit or given a glint for the frames before a MapLight is attached.
      selfIlluminated: { value: LiquidMaterial.isSelfIlluminated(type) ? 1 : 0 },

      // One texture repeat per UV_TILES_PER_REPEAT liquid tiles.
      uvScale: { value: 1.0 / LiquidMaterial.UV_TILES_PER_REPEAT }
    };

    const textures = this.loadTextures(this.textureType.texturePaths);
    this.uniforms.texture_sampler.value = textures[0];
  }

  loadTextures(texturePaths) {
    // Placeholders keep the animation frame count correct while the textures decode, so `animate`
    // can cycle from the first frame without waiting on the whole set.
    const textures = texturePaths.map(() => TextureLoader.PLACEHOLDER);

    texturePaths.forEach((path, index) => {
      TextureLoader.load(path)
        .then((texture) => {
          textures[index] = texture;

          // The sampler holds a single texture rather than the array, so it has to be repointed if
          // the frame that just arrived is the one currently on screen.
          if (index === this.textureIndex % textures.length) {
            this.uniforms.texture_sampler.value = texture;
          }
        })
        .catch((error) => {
          console.error(`Failed to load liquid texture ${path}:`, error);
        });
    });

    this.textures = textures;

    return this.textures;
  }

  /**
   * Advance the texture flipbook.
   *
   * @param delta - Seconds since the previous frame, from THREE.Clock.getDelta
   */
  animate(delta: number) {
    if (this.textures.length === 0) {
      return;
    }

    // Driven by elapsed time, not by a frame counter. This used to step one frame every fifth call,
    // which tied the flow rate to the render rate: at 25-30 FPS a 30-frame lava cycle crawled along at
    // 5-6 frames a second, and the same water ran at twice that speed on a machine hitting 60.
    this.animationTime += delta || 0;

    const frame = Math.floor(this.animationTime * LiquidMaterial.FRAMES_PER_SECOND);
    const index = frame % this.textures.length;

    if (index !== this.textureIndex) {
      this.textureIndex = index;
      this.uniforms.texture_sampler.value = this.textures[index];
    }
  }

  /**
   * Set the map light system
   */
  setMapLight(mapLight: MapLight): void {
    this.mapLight = mapLight;
    this.updateLightUniforms();
  }

  /**
   * Update light uniforms from the map light system
   */
  updateLightUniforms(): void {
    if (this.mapLight) {
      const uniforms = this.mapLight.uniforms;
      this.uniforms.fogParams.value.copy(uniforms.fogParams.value);
      this.uniforms.fogColor.value.copy(uniforms.fogColor.value);
      // World-space sun direction: this shader lights against vertexWorldNormal. `uniforms.sunDir`
      // carries the view-space variant, which rotates with the camera.
      this.uniforms.sunParams.value.copy(this.mapLight.sunDir);
      this.uniforms.sunDiffuseColor.value.copy(uniforms.sunDiffuseColor.value);
      this.uniforms.sunAmbientColor.value.copy(uniforms.sunAmbientColor.value);

      this.updateWaterColor();
    }
  }

  /**
   * Take the water tint from the light database.
   *
   * LiquidType.dbc has a Color pair but leaves it zeroed for most types in 3.3.5a -- every WMO water
   * instance logs `0 0 0` -- so the client colours water from Light.dbc's river and ocean bands
   * instead. Those also move with time of day, which a static DBC colour never could.
   *
   * Magma and slime are self-illuminated and have no band: their texture already carries the colour,
   * so they are left untinted rather than being multiplied by a water blue.
   */
  updateWaterColor(): void {
    const type = this.textureType && this.textureType.data ? this.textureType.data.type : 0;

    this.uniforms.selfIlluminated.value = LiquidMaterial.isSelfIlluminated(this.textureType) ? 1 : 0;

    switch (type) {
      case LIQUID_TYPE.OCEAN:
        this.uniforms.baseColor.value.copy(this.mapLight.oceanCloseColor);
        this.uniforms.useBaseColor.value = 1;
        break;

      case LIQUID_TYPE.MAGMA:
      case LIQUID_TYPE.SLIME:
        this.uniforms.baseColor.value.setRGB(1.0, 1.0, 1.0);
        this.uniforms.useBaseColor.value = 0;
        break;

      default:
        this.uniforms.baseColor.value.copy(this.mapLight.riverCloseColor);
        this.uniforms.useBaseColor.value = 1;
        break;
    }
  }

  dispose() {
    super.dispose();

    this.textures.forEach((texture) => {
      TextureLoader.unload(texture);
    });
  }

 }

export default LiquidMaterial;
