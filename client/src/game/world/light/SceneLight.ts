import * as THREE from 'three';
import { unpackFogParams } from './fog';
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

  /**
   * `blendLights` packs `fogParams` as the (slope, intercept) pair the shader evaluates directly --
   * `x = -1/(end - start)`, `y = end/(end - start)` -- not as (step, end). Recovering `end`/`start`
   * from that packing is exactly `unpackFogParams` (`fog.ts`), the same helper `packFogParams` there
   * packs it with -- reading this back out wrong has already cost this project one fix round, so
   * there is one definition for both directions now, not a second copy of the inverse maths here.
   */
  get fogEnd() {
    return unpackFogParams(this.#params[this.#location].fogParams.x, this.#params[this.#location].fogParams.y).end;
  }

  get fogStart() {
    return unpackFogParams(this.#params[this.#location].fogParams.x, this.#params[this.#location].fogParams.y).start;
  }

  get fogColor() {
    return this.#params[this.#location].fogColor;
  }

  /**
   * The camera-in-WMO interior fog, already crossfaded by `MapLight`'s `WmoFogRamp` -- packed the
   * same way `fogParams` is, via the same `packFogParams` helper, so a consumer needs no extra maths
   * to choose between this and the scene fog above.
   */
  get wmoFogParams() {
    return this.#params[this.#location].wmoFogParams;
  }

  get wmoFogColor() {
    return this.#params[this.#location].wmoFogColor;
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


