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
};
