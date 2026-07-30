import * as THREE from 'three';
import { LightUniforms } from './types';

class SceneLightParams {
  #sunDir = new THREE.Vector3(-1.0, -1.0, -1.0);
  #sunDirView = new THREE.Vector3(-1.0, -1.0, -1.0);
  #sunDiffuseColor = new THREE.Color(0.25, 0.5, 1.0);
  #sunAmbientColor = new THREE.Color(0.5, 0.5, 0.5);

  #fogParams = new THREE.Vector4(1.0 / 577.0, 577.0, 1.0, 1.0);
  #fogColor = new THREE.Color(0.25, 0.5, 0.8);

  #riverCloseColor = new THREE.Color(0.25, 0.5, 0.8);
  #oceanCloseColor = new THREE.Color(0.25, 0.5, 0.8);

  #uniforms: LightUniforms = {
    sunDir: {
      value: this.#sunDirView,
    },
    sunDiffuseColor: {
      value: this.#sunDiffuseColor,
    },
    sunAmbientColor: {
      value: this.#sunAmbientColor,
    },
    fogParams: {
      value: this.#fogParams,
    },
    fogColor: {
      value: this.#fogColor,
    },
    riverCloseColor: {
      value: this.#riverCloseColor,
    },
    oceanCloseColor: {
      value: this.#oceanCloseColor,
    },
  };

  get sunDir() {
    return this.#sunDir;
  }

  get sunDirView() {
    return this.#sunDirView;
  }

  get sunDiffuseColor() {
    return this.#sunDiffuseColor;
  }

  get sunAmbientColor() {
    return this.#sunAmbientColor;
  }

  get fogParams() {
    return this.#fogParams;
  }

  get fogColor() {
    return this.#fogColor;
  }

  get riverCloseColor() {
    return this.#riverCloseColor;
  }

  get oceanCloseColor() {
    return this.#oceanCloseColor;
  }

  get uniforms() {
    return this.#uniforms;
  }

  transformSunDirView(viewMatrix: THREE.Matrix4) {
    this.#sunDirView.copy(this.#sunDir).transformDirection(viewMatrix).normalize();
  }
}

export default SceneLightParams;


