export enum LIGHT_PARAM {
  PARAM_STANDARD = 0,
  PARAM_STANDARD_UNDERWATER,
  PARAM_STORMY,
  PARAM_STORMY_UNDERWATER,
  PARAM_DEATH,
  PARAM_5,
  PARAM_6,
  PARAM_7,
  NUM_LIGHT_PARAMS,
}

/**
 * Light.dbc's eight LightParams slot fields, in record order, indexed by `LIGHT_PARAM`.
 *
 * The single source of truth for these labels. Two diagnostics print them -- the console sweep in
 * `MapLight#dumpLightSlotBands` and the debug panel's slot row -- and they were separately hardcoded,
 * which let the panel keep showing the PRE-RENAME names (`skyFog`, `water`, `sunset`, `other`) after
 * the DBC schema had corrected them. Those old names are not merely terse, they are positionally
 * WRONG: what was called `sunset` is the stormy slot and what was called `other` is stormy
 * underwater. A diagnostic that mislabels the slot it is reporting is worse than no diagnostic,
 * because the reader trusts it -- so there is one list, and both surfaces read it.
 */
export const LIGHT_PARAM_LABELS = [
  'paramsStandard',
  'paramsUnderwater',
  'paramsStormy',
  'paramsStormyUnderwater',
  'paramsDeath',
  'reserved5',
  'reserved6',
  'reserved7',
];

export enum LIGHT_INT_BAND {
  BAND_DIRECT_COLOR = 0,
  BAND_AMBIENT_COLOR,
  BAND_SKY_TOP_COLOR,
  BAND_SKY_MIDDLE_COLOR,
  BAND_SKY_BAND_1_COLOR,
  BAND_SKY_BAND_2_COLOR,
  BAND_SKY_SMOG_COLOR,
  BAND_SKY_FOG_COLOR,
  BAND_SUN_COLOR,
  BAND_CLOUD_SUN_COLOR,
  BAND_CLOUD_EMISSIVE_COLOR,
  BAND_CLOUD_LAYER_1_AMBIENT_COLOR,
  BAND_CLOUD_LAYER_2_AMBIENT_COLOR,
  BAND_13,
  BAND_OCEAN_CLOSE_COLOR,
  BAND_OCEAN_FAR_COLOR,
  BAND_RIVER_CLOSE_COLOR,
  BAND_RIVER_FAR_COLOR,
  NUM_LIGHT_INT_BANDS,
}

export enum LIGHT_FLOAT_BAND {
  BAND_FOG_END,
  BAND_FOG_START_SCALAR,
  BAND_2,
  BAND_3,
  BAND_4,
  BAND_5,
  NUM_LIGHT_FLOAT_BANDS,
}

// Map corner coordinates for default light identification
export const MAP_CORNER_X = 17066.666;
export const MAP_CORNER_Y = 17066.666;


