// New modular light system based on scene implementation
export { default as MapLight } from './MapLight';
export { default as SceneLight } from './SceneLight';
export { default as SceneLightParams } from './SceneLightParams';

// M2 and WMO light integration
export { M2LightIntegration } from './M2LightIntegration';
export { WMOLightIntegration } from './WMOLightIntegration';

// M2 shader integration
export { default as M2MaterialNewShaders } from '../../pipeline/m2/material/M2MaterialNewShaders';

// M2 lite integration (memory efficient)
export { default as M2LoaderLite } from '../../pipeline/m2/M2LoaderLite';
export { default as M2ManagerLite } from '../../pipeline/m2/M2ManagerLite';
export { default as M2MaterialLite } from '../../pipeline/m2/material/M2MaterialLite';

// WDT integration
export { default as WDTLoader } from '../../pipeline/wdt/WDTLoader';
export { default as WDTManager } from '../../pipeline/wdt/WDTManager';
export { default as WDTMaterial } from '../../pipeline/wdt/WDTMaterial';

// WDT lite integration (memory efficient)
export { default as WDTLoaderLite } from '../../pipeline/wdt/WDTLoaderLite';
export { default as WDTManagerLite } from '../../pipeline/wdt/WDTManagerLite';
export { default as WDTMaterialLite } from '../../pipeline/wdt/WDTMaterialLite';

// Utility functions
export {
  getDayNightTime,
  interpolateColorTable,
  interpolateNumericTable, lerpColors, lerpNumbers, selectLightsForPosition
} from './utils';

// Blending functions
export { blendLights } from './blend';

// Types and constants
export type {
  AreaLight,
  AreaLightParams, LightLocation,
  LightUniforms, WeightedAreaLight
} from './types';

export {
  LIGHT_FLOAT_BAND, LIGHT_INT_BAND, LIGHT_PARAM, MAP_CORNER_X,
  MAP_CORNER_Y
} from './constants';

export {
  SUN_PHI_TABLE,
  SUN_THETA_TABLE
} from './sun-tables';

