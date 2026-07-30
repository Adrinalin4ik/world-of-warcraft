import * as THREE from 'three';
import gameSettings from '../settings';
import { BLP_IMAGE_FORMAT } from '../../wow-data-parser/blp/const';
import WorkerPool from './worker/pool';

const THREE_FORMAT = {
  [BLP_IMAGE_FORMAT.IMAGE_DXT1]: THREE.RGBA_S3TC_DXT1_Format,
  [BLP_IMAGE_FORMAT.IMAGE_DXT3]: THREE.RGBA_S3TC_DXT3_Format,
  [BLP_IMAGE_FORMAT.IMAGE_DXT5]: THREE.RGBA_S3TC_DXT5_Format,
  [BLP_IMAGE_FORMAT.IMAGE_ABGR8888]: THREE.RGBAFormat
};

const COMPRESSED_FORMATS = new Set([
  BLP_IMAGE_FORMAT.IMAGE_DXT1,
  BLP_IMAGE_FORMAT.IMAGE_DXT3,
  BLP_IMAGE_FORMAT.IMAGE_DXT5
]);

/**
 * Loads BLP textures straight from the asset host.
 *
 * Decoding happens in a worker and DXT levels reach the GPU still compressed, so `load` is async and
 * hands back a promise. Callers that need something to render in the meantime can put `PLACEHOLDER`
 * in the slot and swap in the real texture when it arrives.
 *
 * Orientation is deliberately uniform: every texture is created with `flipY = false`, because
 * three.js cannot flip a compressed upload and a DXT texture would otherwise disagree with a
 * palettized one. Surfaces that want the opposite V direction flip it in their vertex shader.
 */
class TextureLoader {

  static cache = new Map();
  static references = new Map();
  static pendingUnload = new Set();
  static unloaderRunning = false;

  static UNLOAD_INTERVAL = gameSettings.texture.unloadInterval;

  static _placeholder = null;

  /**
   * Shared empty texture for slots whose real texture has not arrived yet. Never mutate it: it is
   * shared by every material that is still waiting.
   */
  static get PLACEHOLDER() {
    if (!this._placeholder) {
      this._placeholder = new THREE.Texture();
      this._placeholder.name = 'placeholder';
    }
    return this._placeholder;
  }

  static load(rawPath, wrapS = THREE.RepeatWrapping, wrapT = THREE.RepeatWrapping) {
    const path = rawPath.toUpperCase();

    // Ensure we cache based on texture settings. Some textures are reused with different settings.
    const textureKey = `${path};ws:${wrapS.toString()};wt:${wrapT.toString()}`;

    // Prevent unintended unloading.
    if (this.pendingUnload.has(textureKey)) {
      this.pendingUnload.delete(textureKey);
    }

    // Background unloader might need to be started.
    if (!this.unloaderRunning) {
      this.unloaderRunning = true;
      this.backgroundUnload();
    }

    // Keep track of references.
    let refCount = this.references.get(textureKey) || 0;
    ++refCount;
    this.references.set(textureKey, refCount);

    if (!this.cache.has(textureKey)) {
      const loading = WorkerPool.enqueue('BLP', path).then((spec) => {
        if (!spec) {
          throw new Error(`Failed to decode texture: ${path}`);
        }

        return this.createTexture(path, textureKey, spec, wrapS, wrapT);
      });

      this.cache.set(textureKey, loading);
    }

    return this.cache.get(textureKey);
  }

  static createTexture(path, textureKey, spec, wrapS, wrapT) {
    const format = THREE_FORMAT[spec.format];

    if (format === undefined) {
      throw new Error(`Unsupported texture format ${spec.format}: ${path}`);
    }

    const mipmaps = spec.mipmaps;
    let texture;

    if (COMPRESSED_FORMATS.has(spec.format)) {
      texture = new THREE.CompressedTexture(mipmaps, spec.width, spec.height, format);
    } else {
      texture = new THREE.DataTexture(mipmaps[0].data, spec.width, spec.height, format);
      texture.mipmaps = mipmaps;
    }

    // A mip chain we supply ourselves must not be regenerated. Where the BLP carries only one level
    // there is no chain to sample, so mipmap filtering would leave the texture incomplete and it
    // would render black.
    texture.generateMipmaps = false;
    texture.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    texture.wrapS = wrapS;
    texture.wrapT = wrapT;
    texture.flipY = false;
    texture.anisotropy = 16;

    texture.name = path;
    texture.sourceFile = path;
    texture.textureKey = textureKey;

    texture.needsUpdate = true;

    return texture;
  }

  static unload(texture) {
    if (!texture) return;
    const textureKey = texture.textureKey;

    let refCount = this.references.get(textureKey) || 1;
    --refCount;

    if (refCount === 0) {
      this.pendingUnload.add(textureKey);
    } else {
      this.references.set(textureKey, refCount);
    }
  }

  static backgroundUnload() {
    this.pendingUnload.forEach((textureKey) => {
      const loading = this.cache.get(textureKey);

      if (loading) {
        // The cache holds promises, so a texture can be dropped while it is still decoding. Dispose
        // once it settles, and swallow a rejection here: whoever asked for it already saw the error.
        loading.then((texture) => texture.dispose()).catch(() => {});
      }

      this.cache.delete(textureKey);
      this.references.delete(textureKey);
      this.pendingUnload.delete(textureKey);
    });

    setTimeout(this.backgroundUnload.bind(this), this.UNLOAD_INTERVAL);
  }

}

export default TextureLoader;
