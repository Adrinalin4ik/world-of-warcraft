import * as THREE from 'three';

export type AreaLightParams = {
  id: number;
  intBands: any[][];
  floatBands: any[][];
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
  // Water tints. LiquidType.dbc carries a Color pair but leaves it zeroed for most types in 3.3.5a,
  // so the client colours water from these light bands instead, which is also what makes it track
  // time of day.
  riverCloseColor: { value: THREE.Color };
  oceanCloseColor: { value: THREE.Color };
};
