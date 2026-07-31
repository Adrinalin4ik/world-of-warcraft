import * as THREE from 'three';
import { LightUniforms } from './types';
import { DEFAULT_FOG_PARAMS } from './fog';

class SceneLightParams {
  #sunDir = new THREE.Vector3(-1.0, -1.0, -1.0);
  #sunDirView = new THREE.Vector3(-1.0, -1.0, -1.0);
  #sunDiffuseColor = new THREE.Color(0.25, 0.5, 1.0);
  #sunAmbientColor = new THREE.Color(0.5, 0.5, 0.5);

  // `DEFAULT_FOG_PARAMS` is `packFogParams`'s output, not a hand-written literal -- a hand-written
  // (x, y) pair here is exactly how this went wrong before: `x` must be NEGATIVE (see `fog.ts`'s
  // `packFogParams` doc), and a positive `x` pins the shader's fog factor to 0 at every distance,
  // i.e. no fog at all, for any material that has not yet received a real light.
  #fogParams = new THREE.Vector4(...DEFAULT_FOG_PARAMS);
  #fogColor = new THREE.Color(0.25, 0.5, 0.8);

  // The camera-in-WMO interior fog (`MapLight`'s `WmoFogRamp` output), packed identically to
  // `fogParams` above. Defaults to the same scene fog values so a frame rendered before the first
  // `MapLight.update()` call has no visible seam between the two.
  #wmoFogParams = new THREE.Vector4(...DEFAULT_FOG_PARAMS);
  #wmoFogColor = new THREE.Color(0.25, 0.5, 0.8);

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
    wmoFogParams: {
      value: this.#wmoFogParams,
    },
    wmoFogColor: {
      value: this.#wmoFogColor,
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

  get wmoFogParams() {
    return this.#wmoFogParams;
  }

  get wmoFogColor() {
    return this.#wmoFogColor;
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


