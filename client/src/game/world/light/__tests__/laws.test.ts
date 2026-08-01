/**
 * @jest-environment node
 */
import {
  applySkyAzimuthWarp,
  cap96,
  celestialSunDirection,
  cloudGlowIsSun,
  cloudGlowTrack,
  dawnDuskCurve,
  evalProbe,
  floor112,
  floor168,
  foldInteriorProbe,
  INTERIOR_LIGHT_AXIS,
  interpDayNight,
  Lobe,
  moonDirection,
  propProbeCoeffs,
  PropLobeLight,
  quantizeGlow,
  RGB,
  selectPointLights,
  sidnNightFraction,
  skyWarp,
  skyWarpAzimuthGlow,
  stormBlend,
  sunDiscScale,
  Vec3,
  warpSkyRingColor,
} from '../laws';

// benilla's golden case: the abbey stand MODD[24]. ambient/diffuse are its decoded colour words, and
// `AXIS` is an arbitrary unit direction -- the fold's identities hold in any frame, because the
// response depends only on mu = n.u. The frame-specific constant lives in INTERIOR_LIGHT_AXIS (Task 4).
const AMBIENT: RGB = [61 / 255, 59 / 255, 96 / 255];
const DIFFUSE: RGB = [90 / 255, 86 / 255, 141 / 255];

const normalize = (v: Vec3): Vec3 => {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
};

const AXIS = normalize([-0.30822, 0.9, -0.30822]);

const expectClose = (got: RGB, want: RGB) => {
  for (let ch = 0; ch < 3; ++ch) {
    expect(got[ch]).toBeCloseTo(want[ch], 5);
  }
};

describe('propProbeCoeffs', () => {
  it('returns exactly ambient + diffuse facing the lobe (mu = 1)', () => {
    const c = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }]);
    expectClose(evalProbe(c, AXIS), [
      AMBIENT[0] + DIFFUSE[0],
      AMBIENT[1] + DIFFUSE[1],
      AMBIENT[2] + DIFFUSE[2],
    ]);
  });

  it('wraps to ambient + 0.0588 x diffuse facing away (mu = -1)', () => {
    const c = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }]);
    const k = (4 / 17) * 0.25;
    const away: Vec3 = [-AXIS[0], -AXIS[1], -AXIS[2]];
    expectClose(evalProbe(c, away), [
      AMBIENT[0] + k * DIFFUSE[0],
      AMBIENT[1] + k * DIFFUSE[1],
      AMBIENT[2] + k * DIFFUSE[2],
    ]);
  });

  it('gives ambient + 0.0882 x diffuse side-on (mu = 0)', () => {
    const c = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }]);
    const k = (4 / 17) * 0.375;
    // Perpendicular to AXIS by construction: dot([az, 0, -ax], [ax, ay, az]) == 0.
    const side = normalize([AXIS[2], 0, -AXIS[0]]);
    expectClose(evalProbe(c, side), [
      AMBIENT[0] + k * DIFFUSE[0],
      AMBIENT[1] + k * DIFFUSE[1],
      AMBIENT[2] + k * DIFFUSE[2],
    ]);
  });

  it('is flat ambient with no lobes at all', () => {
    const c = propProbeCoeffs(AMBIENT, []);
    expectClose(evalProbe(c, [0, 1, 0]), AMBIENT);
    expectClose(evalProbe(c, [1, 0, 0]), AMBIENT);
  });

  it('is additive across lobes', () => {
    const second: Lobe = { dir: [0, 1, 0], color: [0.1, 0.2, 0.3] };
    const both = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }, second]);
    const first = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }]);
    const secondOnly = propProbeCoeffs([0, 0, 0], [second]);
    const a = evalProbe(both, AXIS);
    const b = evalProbe(first, AXIS);
    const c2 = evalProbe(secondOnly, AXIS);
    for (let ch = 0; ch < 3; ++ch) {
      expect(a[ch]).toBeCloseTo(b[ch] + c2[ch], 5);
    }
  });

  it('ignores a zero-length lobe direction rather than emitting NaN', () => {
    const c = propProbeCoeffs(AMBIENT, [{ dir: [0, 0, 0], color: DIFFUSE }]);
    expectClose(evalProbe(c, [0, 1, 0]), AMBIENT);
  });
});

describe('MODD colour byte laws', () => {
  // Compare in bytes, which is how the reference's own golden values are recorded.
  const asBytes = (c: RGB) => c.map((v) => Math.round(v * 255));

  it('caps the ambient word at value 96, hue preserved', () => {
    expect(asBytes(cap96([78, 76, 134]))).toEqual([56, 55, 96]);
    expect(asBytes(cap96([90, 86, 141]))).toEqual([61, 59, 96]);
  });

  it('passes an ambient word whose max is already <= 96 straight through', () => {
    expect(asBytes(cap96([96, 40, 20]))).toEqual([96, 40, 20]);
  });

  it('rounds the cap scale half-to-even, not half-up', () => {
    // max = 160 makes 96*255/160 - 0.5 land exactly on 152.5 -- the one tie in the whole byte domain.
    // Round-half-to-even gives scale 152, so the max channel recombines to (160*152 + 255) >> 8 = 95.
    // Math.round would give 153 and a max of 96. Note the cap therefore does NOT always land the max
    // exactly on 96; the reference's own rounding is what decides, and here it lands a byte under.
    expect(asBytes(cap96([160, 160, 160]))).toEqual([95, 95, 95]);
    expect(asBytes(cap96([160, 80, 40]))).toEqual([95, 48, 24]);
  });

  it('raises a diffuse word below 112 by a truncating scale', () => {
    expect(asBytes(floor112([56, 28, 14]))).toEqual([112, 56, 28]);
  });

  it('passes a diffuse word at or above 112 through untouched', () => {
    expect(asBytes(floor112([78, 76, 134]))).toEqual([78, 76, 134]);
    expect(asBytes(floor112([90, 86, 141]))).toEqual([90, 86, 141]);
  });

  it('leaves black black rather than dividing by zero', () => {
    expect(asBytes(floor112([0, 0, 0]))).toEqual([0, 0, 0]);
  });

  it('truncates the entity threshold at 168 the same way', () => {
    // The reference's decoded abbey benches: truncation gives 127 where nearest would give 128.
    expect(asBytes(floor168([59, 65, 92]))).toEqual([107, 118, 168]);
    expect(asBytes(floor168([69, 63, 83]))).toEqual([139, 127, 168]);
  });
});

describe('interpDayNight', () => {
  it('lerps between adjacent keyframes', () => {
    const table: Array<[number, number]> = [
      [0.0, 0.0],
      [0.5, 10.0],
    ];
    expect(interpDayNight(table, 0.25)).toBeCloseTo(5.0, 5);
  });

  it('wraps around the end of the day', () => {
    // Between the 0.75 key and the 0.25 key going forwards through midnight: 0.0 is halfway.
    const table: Array<[number, number]> = [
      [0.25, 0.0],
      [0.75, 4.0],
    ];
    expect(interpDayNight(table, 0.0)).toBeCloseTo(2.0, 5);
  });

  it('reproduces the sun elevation table at its keyframes', () => {
    const phi: Array<[number, number]> = [
      [0.0, 2.2165682],
      [0.25, 1.9198623],
      [0.5, 2.2165682],
      [0.75, 1.9198623],
    ];
    expect(interpDayNight(phi, 0.0)).toBeCloseTo(2.2165682, 5);
    expect(interpDayNight(phi, 0.25)).toBeCloseTo(1.9198623, 5);
    expect(interpDayNight(phi, 0.5)).toBeCloseTo(2.2165682, 5);
    expect(interpDayNight(phi, 0.125)).toBeCloseTo(2.0682153, 4);
  });
});

describe('sidnNightFraction', () => {
  const at = (hour: number, minute: number) => sidnNightFraction(hour * 60 + minute);

  it('is full overnight', () => {
    expect(at(0, 0)).toBeCloseTo(1.0, 5);
    expect(at(6, 0)).toBeCloseTo(1.0, 5);
    expect(at(23, 0)).toBeCloseTo(1.0, 5);
  });

  it('ramps out over 06:00 to 07:00', () => {
    expect(at(6, 30)).toBeCloseTo(0.5, 5);
    expect(at(7, 0)).toBeCloseTo(0.0, 5);
  });

  it('is off all day', () => {
    expect(at(12, 0)).toBeCloseTo(0.0, 5);
    expect(at(20, 30)).toBeCloseTo(0.0, 5);
  });

  it('ramps in over 20:30 to 21:30', () => {
    expect(at(21, 0)).toBeCloseTo(0.5, 5);
    expect(at(21, 30)).toBeCloseTo(1.0, 4);
  });
});

describe('dawnDuskCurve and skyWarp', () => {
  it('is zero across midday and deep night', () => {
    expect(dawnDuskCurve(720)).toBeCloseTo(0.0, 5);
    expect(dawnDuskCurve(0)).toBeCloseTo(0.0, 5);
    expect(dawnDuskCurve(1080)).toBeCloseTo(0.0, 5);
  });

  it('spikes to ~1 at dawn and dusk', () => {
    expect(dawnDuskCurve(390)).toBeGreaterThan(0.99);
    expect(dawnDuskCurve(1290)).toBeGreaterThan(0.99);
  });

  it('is partway up the dawn ramp at 06:00', () => {
    const mid = dawnDuskCurve(360);
    expect(mid).toBeGreaterThan(0.0);
    expect(mid).toBeLessThan(1.0);
  });

  it('is identically zero in a highlightSky = 0 zone at every hour', () => {
    for (let minute = 0; minute < 1440; minute += 15) {
      expect(skyWarp(minute, 0)).toBe(0);
    }
  });

  it('passes the curve through at highlightSky = 1', () => {
    expect(skyWarp(390, 1)).toBeCloseTo(dawnDuskCurve(390), 5);
  });
});

describe('applySkyAzimuthWarp', () => {
  const BASE: RGB = [0.2, 0.3, 0.9];
  const WARM: RGB = [0.9, 0.6, 0.3];
  const DARK: RGB = [0.05, 0.05, 0.15];

  it('is exactly identity at S = 0, for any azimuth pair -- the case the brief calls out by name', () => {
    for (let frag = 0; frag < Math.PI * 2; frag += 0.3) {
      for (let sun = 0; sun < Math.PI * 2; sun += 0.7) {
        expect(applySkyAzimuthWarp(BASE, WARM, DARK, frag, sun, 0)).toEqual(BASE);
      }
    }
  });

  it('is identity on the sun bearing itself (g = 1) even with S > 0', () => {
    // Phase 0.125 (see `skyWarpAzimuthGlow`'s doc) is where g = 1 lands, and it lands there when the
    // fragment azimuth equals the sun azimuth exactly (az = 0 -> +0.125 -> segment 3 exactly, g = 1).
    const sunAzimuth = 1.1;
    const result = applySkyAzimuthWarp(BASE, WARM, DARK, sunAzimuth, sunAzimuth, 1);
    for (let ch = 0; ch < 3; ++ch) {
      expect(result[ch]).toBeCloseTo(BASE[ch], 5);
    }
  });

  it('pulls the anti-sun bearing toward dark, never toward warm alone, at full strength', () => {
    const sunAzimuth = 0;
    const antiSun = Math.PI; // 180 degrees away
    const result = applySkyAzimuthWarp(BASE, WARM, DARK, antiSun, sunAzimuth, 1);
    // At the trough (g = -0.7) the ring is a prepass toward warm by s=1 (i.e. warm itself) and then a
    // second mix toward dark -- so the result must sit between warm and dark, not equal either
    // endpoint nor the untouched base.
    for (let ch = 0; ch < 3; ++ch) {
      expect(result[ch]).not.toBeCloseTo(BASE[ch], 3);
    }
  });
});

describe('skyWarpAzimuthGlow', () => {
  it('peaks at exactly 1 at phase 0.125 (the sun bearing) and troughs at -0.7 at 0.625', () => {
    expect(skyWarpAzimuthGlow(0.125)).toBeCloseTo(1, 5);
    expect(skyWarpAzimuthGlow(0.625)).toBeCloseTo(-0.7, 5);
  });

  it('wraps around at phase 0 the same as phase 1', () => {
    expect(skyWarpAzimuthGlow(0)).toBeCloseTo(skyWarpAzimuthGlow(1), 5);
  });
});

describe('warpSkyRingColor', () => {
  const BASE: RGB = [0.2, 0.3, 0.9];
  const WARM: RGB = [0.9, 0.6, 0.3];
  const DARK: RGB = [0.05, 0.05, 0.15];

  it('is identity at s = 0 regardless of g', () => {
    expect(warpSkyRingColor(BASE, WARM, DARK, 1, 0)).toEqual(BASE);
    expect(warpSkyRingColor(BASE, WARM, DARK, -0.7, 0)).toEqual(BASE);
  });

  it('is identity at g = 1 (the sun bearing) regardless of s', () => {
    const result = warpSkyRingColor(BASE, WARM, DARK, 1, 1);
    for (let ch = 0; ch < 3; ++ch) {
      expect(result[ch]).toBeCloseTo(BASE[ch], 5);
    }
  });
});

describe('quantizeGlow and stormBlend', () => {
  it('quantizes glow to the byte the reference packs', () => {
    expect(quantizeGlow(0.65)).toBeCloseTo(0.647, 3);
    expect(quantizeGlow(1.0)).toBeCloseTo(1.0, 5);
    expect(quantizeGlow(0.0)).toBe(0);
  });

  it('saturates the storm blend at a quarter sky density', () => {
    expect(stormBlend(0)).toBe(0);
    expect(stormBlend(0.125)).toBeCloseTo(0.5, 5);
    expect(stormBlend(0.25)).toBeCloseTo(1.0, 5);
    // Clamped, so an out-of-domain density cannot overdrive the lerp.
    expect(stormBlend(1.0)).toBe(1);
  });
});

describe('foldInteriorProbe', () => {
  const AMB: RGB = [0.2, 0.2, 0.2];
  const DIF: RGB = [0.4, 0.4, 0.4];

  it('commits the diffuse word on the fixed axis, not the sun', () => {
    const c = foldInteriorProbe(AMB, DIF, [0, 0, 0], []);
    // Facing the fixed axis returns ambient + diffuse exactly.
    expectClose(evalProbe(c, normalize(INTERIOR_LIGHT_AXIS)), [0.6, 0.6, 0.6]);
  });

  it('adds a MOLR lobe at full gain inside attenStart', () => {
    const light: PropLobeLight = {
      position: [0, 0, 10],
      color: [0.5, 0, 0],
      attenStart: 20,
      attenEnd: 40,
    };
    const withLight = foldInteriorProbe(AMB, DIF, [0, 0, 0], [light]);
    const without = foldInteriorProbe(AMB, DIF, [0, 0, 0], []);
    // Facing the light, the red channel gains the full lobe peak.
    const toLight: Vec3 = [0, 0, 1];
    expect(evalProbe(withLight, toLight)[0] - evalProbe(without, toLight)[0]).toBeCloseTo(0.5, 5);
  });

  it('excludes a MOLR lobe at or beyond attenEnd', () => {
    const light: PropLobeLight = {
      position: [0, 0, 40],
      color: [0.5, 0, 0],
      attenStart: 20,
      attenEnd: 40,
    };
    const withLight = foldInteriorProbe(AMB, DIF, [0, 0, 0], [light]);
    const without = foldInteriorProbe(AMB, DIF, [0, 0, 0], []);
    expect(evalProbe(withLight, [0, 0, 1])).toEqual(evalProbe(without, [0, 0, 1]));
  });

  it('ramps a MOLR lobe linearly between attenStart and attenEnd', () => {
    const light: PropLobeLight = {
      position: [0, 0, 30],
      color: [0.5, 0, 0],
      attenStart: 20,
      attenEnd: 40,
    };
    const withLight = foldInteriorProbe(AMB, DIF, [0, 0, 0], [light]);
    const without = foldInteriorProbe(AMB, DIF, [0, 0, 0], []);
    // Halfway through the window -> half gain.
    const gained = evalProbe(withLight, [0, 0, 1])[0] - evalProbe(without, [0, 0, 1])[0];
    expect(gained).toBeCloseTo(0.25, 5);
  });

  it('overrides the axis when one is supplied', () => {
    // Plan 3 verifies INTERIOR_LIGHT_AXIS in a real interior. The parameter is how a correction lands
    // in one place, so it needs to actually be honoured.
    const axis: Vec3 = [0, 0, 1];
    const c = foldInteriorProbe(AMB, DIF, [0, 0, 0], [], axis);
    expectClose(evalProbe(c, axis), [0.6, 0.6, 0.6]);
  });
});

describe('selectPointLights', () => {
  const light = (x: number, attenEnd = 100) => ({ position: [x, 0, 0] as Vec3, attenEnd });

  it('keeps the three nearest to the anchor', () => {
    const lights = [light(50), light(10), light(30), light(20), light(40)];
    const picked = selectPointLights([0, 0, 0], lights);
    expect(picked.map((l) => l.position[0])).toEqual([10, 20, 30]);
  });

  it('ranks by distance from the anchor, not from the origin', () => {
    const lights = [light(0), light(100)];
    const picked = selectPointLights([90, 0, 0], lights);
    expect(picked[0].position[0]).toBe(100);
  });

  it('excludes a candidate whose own range does not reach the anchor', () => {
    const lights = [light(10, 5), light(30)];
    const picked = selectPointLights([0, 0, 0], lights);
    expect(picked.map((l) => l.position[0])).toEqual([30]);
  });

  it('returns everything when fewer than the cap are in range', () => {
    expect(selectPointLights([0, 0, 0], [light(10)])).toHaveLength(1);
    expect(selectPointLights([0, 0, 0], [])).toHaveLength(0);
  });

  it('honours an explicit cap', () => {
    const lights = [light(10), light(20), light(30)];
    expect(selectPointLights([0, 0, 0], lights, 2)).toHaveLength(2);
  });
});

describe('SceneLight fog range', () => {
  it('recovers the fog start that blendLights packed', async () => {
    const SceneLight = (await import('../SceneLight')).default;
    const scene = new SceneLight();

    // Pack exactly as blendLights does for a 125..500 yard fog band.
    const start = 125;
    const end = 500;
    const step = 1 / (end - start);
    scene.fogParams.set(-step, end * step, 1, 1);

    expect(scene.fogEnd).toBeCloseTo(end, 4);
    expect(scene.fogStart).toBeCloseTo(start, 4);
  });

  it('recovers a zero-start band, which a sign error would miss', async () => {
    const SceneLight = (await import('../SceneLight')).default;
    const scene = new SceneLight();

    // Pack exactly as blendLights does for a 0..200 yard fog band.
    const start = 0;
    const end = 200;
    const step = 1 / (end - start);
    scene.fogParams.set(-step, end * step, 1, 1);

    expect(scene.fogEnd).toBeCloseTo(end, 4);
    expect(scene.fogStart).toBeCloseTo(start, 4);
  });
});

describe('cloud glow envelope + moon direction', () => {
  // Mirrors benilla's own `cloud_glow_track_matches_the_client_envelope` test byte-for-byte, since
  // the non-monotonic table's whole point is the seam wrap this test pins down.
  it('is full at noon, notches to zero at dawn/dusk, and wraps back to full past the dusk notch', () => {
    expect(cloudGlowTrack(720)).toBe(1.0); // noon
    expect(cloudGlowTrack(0.20139 * 1440)).toBe(0.0); // the 04:50 notch

    const notch = cloudGlowTrack(0.9236 * 1440); // approaching the 22:10 notch from below
    expect(notch).toBeLessThan(0.01);

    // The cliff: one minute-step past the notch, the array-order scan runs off the non-monotonic
    // tail and the seam wrap snaps the envelope back to 1.0 -- the verified mechanism this whole
    // table exists to reproduce. Sorting the table would make this assertion fail.
    expect(cloudGlowTrack(0.9237 * 1440)).toBe(1.0);
    expect(cloudGlowTrack(0.95 * 1440)).toBe(1.0); // deep night stays wrapped to full

    const midDusk = cloudGlowTrack(0.9097 * 1440); // halfway 21:30 -> 22:10
    expect(midDusk).toBeCloseTo(0.5, 2);
  });

  it('picks the sun inside the 04:50-22:10 window and the moon outside it, agreeing with the glow window', () => {
    expect(cloudGlowIsSun(720)).toBe(true); // noon
    expect(cloudGlowIsSun(0.95 * 1440)).toBe(false); // deep night

    // The window's own edges, inclusive.
    expect(cloudGlowIsSun(0.2013889 * 1440)).toBe(true);
    expect(cloudGlowIsSun(0.9236111 * 1440)).toBe(true);
    expect(cloudGlowIsSun(0.2013888 * 1440)).toBe(false);
    expect(cloudGlowIsSun(0.9236112 * 1440)).toBe(false);
  });

  it('parks the moon below the horizon at noon and overhead at midnight, agreeing with cloudGlowIsSun', () => {
    const noon = moonDirection(720);
    const midnight = moonDirection(0);

    // z = cosPhi in this client's unpermuted WoW frame (see moonDirection's doc comment): positive
    // is above the WoW-frame horizon, matching MapLight's existing sun-direction convention.
    expect(noon[2]).toBeLessThan(0); // below the horizon at noon
    expect(midnight[2]).toBeGreaterThan(0); // overhead at midnight

    expect(cloudGlowIsSun(720)).toBe(true); // sun drives the glow when the moon is down
    expect(cloudGlowIsSun(0)).toBe(false); // moon drives the glow when it's up
  });

  it('holds the moon at a constant 45 degree azimuth, the suns own bearing', () => {
    const heading = (d: Vec3) => Math.atan2(d[1], d[0]);
    const expected = Math.PI * 0.25;

    for (const minute of [0, 180, 480, 720, 900, 1200, 1439]) {
      expect(heading(moonDirection(minute))).toBeCloseTo(expected, 5);
    }
  });
});

describe('celestialSunDirection (the visible rising/setting sun, distinct from the lighting sun)', () => {
  it('parks below the horizon at midnight and sits near zenith at solar noon', () => {
    const midnight = celestialSunDirection(0);
    const noon = celestialSunDirection(720);

    expect(midnight[2]).toBeLessThan(0); // parked -10 degrees, below the WoW-frame horizon
    expect(noon[2]).toBeGreaterThan(0.9); // near zenith: cos(5deg) ~ 0.996
  });

  it('actually crosses the horizon at dawn/dusk, unlike the near-fixed lighting sun', () => {
    // The lighting sun (MapLight#sunDir, SUN_PHI_TABLE) never leaves its ~20-37 degree elevation
    // band. The celestial sun must genuinely rise through zero around sunrise/sunset.
    const beforeDawn = celestialSunDirection(0.2 * 1440)[2]; // 04:48, still below the horizon
    const afterDawn = celestialSunDirection(0.35 * 1440)[2]; // 08:24, risen
    expect(beforeDawn).toBeLessThan(0);
    expect(afterDawn).toBeGreaterThan(0);
  });

  it('holds a constant 45 degree azimuth, the same bearing as the lighting sun', () => {
    const heading = (d: Vec3) => Math.atan2(d[1], d[0]);
    const expected = Math.PI * 0.25;

    for (const minute of [0, 180, 480, 720, 900, 1200, 1439]) {
      expect(heading(celestialSunDirection(minute))).toBeCloseTo(expected, 5);
    }
  });
});

describe('sunDiscScale', () => {
  it('is 2x at the dawn/dusk horizon and 1x across midday (vanilla size table 0xce8cac)', () => {
    expect(sunDiscScale(6 * 60)).toBeCloseTo(2.0, 3); // 06:00 sunrise
    expect(sunDiscScale(21 * 60)).toBeCloseTo(2.0, 3); // 21:00 sunset
    expect(sunDiscScale(12 * 60)).toBeCloseTo(1.0, 3); // solar noon
    expect(sunDiscScale(9 * 60)).toBeCloseTo(1.0, 3); // mid-morning plateau
  });

  it('ramps smoothly between the horizon and the midday plateau rather than stepping', () => {
    const partial = sunDiscScale(6 * 60 + 20); // between the 06:00 and 06:45 keys
    expect(partial).toBeGreaterThan(1.0);
    expect(partial).toBeLessThan(2.0);
  });
});
