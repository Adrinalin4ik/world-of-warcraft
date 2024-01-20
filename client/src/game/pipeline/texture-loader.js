import * as THREE from 'three';
import gameSettings from '../settings';

const loader = new THREE.TextureLoader();

class TextureLoader {

  static cache = new Map();
  static references = new Map();
  static pendingUnload = new Set();
  static unloaderRunning = false;

  static UNLOAD_INTERVAL = gameSettings.texture.unloadInterval;

  static load(rawPath, wrapS = THREE.RepeatWrapping, wrapT = THREE.RepeatWrapping, flipY = true) {
    const path = rawPath.toUpperCase();

    // Ensure we cache based on texture settings. Some textures are reused with different settings.
    const textureKey = `${path};ws:${wrapS.toString()};wt:${wrapT.toString()};fy:${flipY}`;

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

    const encodedPath = encodeURI(`pipeline/${path}.png`);

    if (!this.cache.has(textureKey)) {
      // TODO: Promisify THREE's TextureLoader callbacks
      const texture = loader.load(encodedPath, function(texture) {
        texture.sourceFile = path;
        texture.textureKey = textureKey;

        texture.wrapS = wrapS;
        texture.wrapT = wrapT;
        texture.flipY = flipY;

        texture.needsUpdate = true;
      })
      if (texture) {
        this.cache.set(textureKey, texture);
      }
    }

    return this.cache.get(textureKey);
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
      if (this.cache.has(textureKey)) {
        this.cache.get(textureKey).dispose();
      }

      this.cache.delete(textureKey);
      this.references.delete(textureKey);
      this.pendingUnload.delete(textureKey);
    });

    setTimeout(this.backgroundUnload.bind(this), this.UNLOAD_INTERVAL);
  }

}

export default TextureLoader;
