import * as THREE from 'three';

export type AreaLightParams = {
  id: number;
  intBands: any[][];
  floatBands: any[][];
  // The `LIGHT_FLOAT_BAND.BAND_FOG_END` table, interpolated the same way `floatBands` is, but BEFORE
  // `MapLight#processFloatBand`'s `1/36` unit conversion. Debug-readout-only: it exists so the raw DBC
  // value can be shown beside the scaled one and a wrongly-placed (or doubled) scale settles by
  // inspection instead of by guessing at the final fog range. Absent when the band itself is absent,
  // same as `floatBands`.
  rawFogEndBand?: any[];
};

export type AreaLight = {
  id: number;
  mapId: number;
  position: THREE.Vector3;
  falloffStart: number;
  falloffEnd: number;
  params: AreaLightParams[];
  /**
   * The Light.dbc record's eight raw LightParams slot ids, in DBC field order: `[skyFogID, waterID,
   * sunsetID, otherID, deathID, reserved5, reserved6, reserved7]`. Debug-readout-only (diagnostic 1)
   * -- `params` above only ever carries the resolved bands for slot 0 (`skyFogID`), the only slot
   * this client loads bands for. Printing all eight beside which one was actually loaded is what
   * lets a shifted field order, or a zone that authors a storm-like fog under the "standard" slot,
   * be told apart from a slot-selection bug. Optional so existing `AreaLight` fixtures built by hand
   * (blend.test.ts) keep satisfying the type.
   */
  lightSlots?: number[];
};

export type WeightedAreaLight = {
  light: AreaLight;
  weight: number;
  distance: number;
};

export type LightLocation = 'exterior' | 'interior';

export type LightUniforms = {
  sunDir: { value: THREE.Vector3 };
  sunDiffuseColor: { value: THREE.Color };
  sunAmbientColor: { value: THREE.Color };
  fogParams: { value: THREE.Vector4 };
  fogColor: { value: THREE.Color };
  // The camera-in-WMO interior fog, already crossfaded by `MapLight`'s `WmoFogRamp` and packed
  // identically to `fogParams` (see `fog.ts`'s `packFogParams`) -- a consumer picks between this and
  // `fogParams`/`fogColor` above with no extra maths.
  wmoFogParams: { value: THREE.Vector4 };
  wmoFogColor: { value: THREE.Color };
  // Water tints. LiquidType.dbc carries a Color pair but leaves it zeroed for most types in 3.3.5a,
  // so the client colours water from these light bands instead, which is also what makes it track
  // time of day.
  riverCloseColor: { value: THREE.Color };
  oceanCloseColor: { value: THREE.Color };
};
