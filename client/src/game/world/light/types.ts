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
