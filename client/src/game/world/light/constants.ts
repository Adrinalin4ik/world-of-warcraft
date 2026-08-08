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

/**
 * Rows 8-13 were off by one against the reference's byte-verified table (`samples/benilla/crates/
 * benilla-formats/src/light/atmosphere.rs`: the band gather `0x6d64d0` stores sub-10/11/12 at
 * colour-table slots 9/10/11 = `0xce9c30/34/38`, the three palettes the cloud dome builder `0x6cfb00`
 * reads) -- this client had `BAND_SUN_COLOR` at row 8 (should be 9) and invented a FOURTH cloud band
 * across 9-12 (the reference has three: sun-glow tint, gradient slope, gradient base). Verified live
 * against real Light.dbc data before renumbering: row 9 reads as a genuine sun colour (warm orange at
 * dawn/dusk, pale white at noon, cool blue-white at night), rows 10/11 read as a plausible cloud
 * palette, and row 8 is a flat, non-diurnal grey with none of the sun row's day/night structure --
 * consistent with it being unnamed. None of rows 8-12 was consumed anywhere in the client before this
 * fix (only `BAND_SKY_SMOG_COLOR` and the water rows were read), so there was no live behaviour to
 * preserve.
 */
export enum LIGHT_INT_BAND {
  BAND_DIRECT_COLOR = 0,
  BAND_AMBIENT_COLOR,
  BAND_SKY_TOP_COLOR,
  BAND_SKY_MIDDLE_COLOR,
  BAND_SKY_BAND_1_COLOR,
  BAND_SKY_BAND_2_COLOR,
  BAND_SKY_SMOG_COLOR,
  BAND_SKY_FOG_COLOR,
  /** Unnamed in the reference too -- not consumed. */
  BAND_8,
  BAND_SUN_COLOR,
  /** Cloud sun-glow tint (reference `IB_CLOUD_SUN`). */
  BAND_CLOUD_SUN_COLOR,
  /** Cloud gradient slope (reference `IB_CLOUD_SLOPE`). */
  BAND_CLOUD_SLOPE_COLOR,
  /** Cloud gradient base (reference `IB_CLOUD_GBASE`). */
  BAND_CLOUD_BASE_COLOR,
  /** Unnamed in the reference too -- not consumed. */
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
  /**
   * Cloud density `C` (reference `FB_CLOUD_DENSITY`), byte-verified: the scalar gather `0x6d64d0`
   * stores float sub-3 at `[0xce9c64]`, feeding the coverage threshold `T = trunc((1 - C) * 255)`.
   * Live-checked against a real zone: reads 0.5 across the day for the seed light on map 0 (Elwynn),
   * a plausible authored density, not a hole or NaN.
   */
  BAND_CLOUD_DENSITY,
  BAND_4,
  BAND_5,
  NUM_LIGHT_FLOAT_BANDS,
}

// Map corner coordinates for default light identification
export const MAP_CORNER_X = 17066.666;
export const MAP_CORNER_Y = 17066.666;


