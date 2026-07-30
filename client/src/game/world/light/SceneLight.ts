import * as THREE from 'three';
import SceneLightParams from './SceneLightParams';
import { LightLocation, LightUniforms } from './types';

class SceneLight {
  #location: LightLocation = 'exterior';

  #params = {
    exterior: new SceneLightParams(),
    interior: new SceneLightParams(),
  };

  #uniforms = {
    exterior: this.#params.exterior.uniforms,
    interior: this.#params.interior.uniforms,
  };

  get location() {
    return this.#location;
  }

  set location(location: LightLocation) {
    this.#location = location;
  }

  get uniforms(): LightUniforms {
    return this.#uniforms[this.#location];
  }

  get sunDir() {
    return this.#params[this.#location].sunDir;
  }

  get sunDirView() {
    return this.#params[this.#location].sunDirView;
  }

  get sunDiffuseColor() {
    return this.#params[this.#location].sunDiffuseColor;
  }

  get sunAmbientColor() {
    return this.#params[this.#location].sunAmbientColor;
  }

  get fogParams() {
    return this.#params[this.#location].fogParams;
  }

  get fogStart() {
    return this.fogEnd - 1.0 / this.#params[this.#location].fogParams.x;
  }

  get fogEnd() {
    return this.#params[this.#location].fogParams.y;
  }

  get fogColor() {
    return this.#params[this.#location].fogColor;
  }

  get riverCloseColor() {
    return this.#params[this.#location].riverCloseColor;
  }

  get oceanCloseColor() {
    return this.#params[this.#location].oceanCloseColor;
  }

  /**
   * Params for a specific location, regardless of which one is currently active.
   *
   * The public getters above all resolve through `location`, so they can only ever read or write
   * whichever side is selected. Subclasses that compute both sides need to address them directly.
   */
  protected paramsFor(location: LightLocation) {
    return this.#params[location];
  }

  update(camera: THREE.Camera) {
    const viewMatrix = camera.matrixWorldInverse;

    this.#params.exterior.transformSunDirView(viewMatrix);
    this.#params.interior.transformSunDirView(viewMatrix);
  }
}

export default SceneLight;


