/**
 * Weather -- the two ramped intensity channels of the reference client's `weather_intensity_ramp`
 * (benilla `crates/benilla/src/weather/mod.rs`, transcribed from `WoW.exe 0x67bc70`).
 *
 * Nothing here touches the renderer. The module imports nothing at all, for the same reason
 * `laws.ts` does not: these are laws, and a law that can only be exercised through a three.js
 * scene cannot be tested against the reference's own numbers.
 *
 * Two channels share one primitive:
 *
 * - **channel A -- effect intensity**, `spanScale = 1` over the grade domain. A full 0 -> 1 swing
 *   takes about ten seconds. Precipitation consumes not this but the knee-mapped
 *   {@link WeatherState.effectDensity}: `max((A - 0.25) * 4/3, 0)`, so below grade 0.25 nothing
 *   falls and 0.25..1 maps onto 0..1.
 * - **channel B -- sky density**, `spanScale = 4`, whose endpoints live in the **[0, 0.25] knee
 *   domain**.
 *
 * Channel B's `spanScale = 4` reads like "four times slower" and is not. Because `SetWeather`
 * (`0x67baf0`) writes `clamp(grade, 0, 0.25)` into B's endpoints, B's largest possible span is a
 * quarter of A's -- and the x4 in the denominator cancels exactly that quarter, so **both channels
 * swing in about ten seconds**. The reference's own notes record getting this wrong (reading the x4
 * as four-times-slower), which pinned the fog at 100% for roughly thirty seconds of every downswing
 * and presented to its director as "takes a long time until it gets sunny". It is the single most
 * misleading line in this file; the cancellation is the whole point of the knee domain.
 *
 * Because B ramps linearly across the entire swing while A must clear 0.25 before anything falls,
 * the overcast visibly LEADS the rain on the way up and starts clearing IMMEDIATELY on the way down.
 * That asymmetry is authored, not a bug to smooth out.
 *
 * The channels run on real elapsed seconds, so a transition keeps ramping through a loading screen
 * exactly as the reference's does.
 *
 * `stormBlend` -- the weight lighting lerps the storm `LightParams` record over the clear one by --
 * lives in `laws.ts` with the other resolved-lighting laws, not here.
 */

/** Wire weather types (`SMSG_WEATHER` / vmangos `WeatherType`). */
export enum WeatherKind {
  Fine = 0,
  Rain = 1,
  Snow = 2,
  Sand = 3,
}

/** `SMSG_WEATHER`'s type word -- anything unrecognised is fine weather, as the reference decodes it. */
export function weatherKindFromWire(value: number): WeatherKind {
  switch (value) {
    case 1:
      return WeatherKind.Rain;
    case 2:
      return WeatherKind.Snow;
    case 3:
      return WeatherKind.Sand;
    default:
      return WeatherKind.Fine;
  }
}

/** Channel B's knee: `SetWeather` clamps the grade to this before writing B's endpoints. */
const SKY_KNEE = 0.25;

/** The effect knee: below channel A = 0.25 nothing falls at all. */
const EFFECT_KNEE = 0.25;

/**
 * One ramped channel. `value = clampedLerp(from -> to, elapsed / ((|(to - from) * spanScale + 0.001|) * 10))`.
 *
 * The `+ 0.001` sits INSIDE the absolute value, matching `0x67bc70` (`|dv * span + 0.001| * 10`)
 * rather than the tidier-looking `(|dv| * span + 0.001) * 10`. The difference is sub-ten-milliseconds
 * and asymmetric -- an upswing denominator is 10.01 where the matching downswing is 9.99 -- so it is
 * transcribed exactly rather than normalised.
 */
class Channel {
  #from = 0;

  #to = 0;

  /** Ramp epoch, in the owner's accumulated seconds. */
  #start = 0;

  readonly #spanScale: number;

  constructor(spanScale: number) {
    this.#spanScale = spanScale;
  }

  value(now: number): number {
    const den = Math.abs((this.#to - this.#from) * this.#spanScale + 0.001) * 10;
    const t = Math.min(1, Math.max(0, (now - this.#start) / den));
    return this.#from + (this.#to - this.#from) * t;
  }

  /**
   * Begin ramping toward `target` from the **old target**, not from the current ramped value.
   * `SetWeather` (`0x67baf0`) re-stamps the epoch and writes `from <- old *target*`
   * (`param_1[1] = *param_1`).
   *
   * That means a mid-swing change of mind JUMPS to the previous endpoint before ramping away from
   * it -- retargeting Fine five seconds into a rain upswing snaps the channel to 1.0 and then
   * ramps down from there, rather than continuing smoothly from ~0.5. The jump is real and the
   * reference client accepts it. Resuming from the current value is smoother and is exactly the
   * invention benilla made and later reverted, so it is not what this does.
   */
  retarget(target: number, now: number): void {
    this.#from = this.#to;
    this.#to = target;
    this.#start = now;
  }

  /** The wire's `instant` flag: jump straight to `target` with no ramp. */
  snap(target: number): void {
    this.#from = target;
    this.#to = target;
  }

  get target(): number {
    return this.#to;
  }
}

/**
 * The zone weather state -- the client-side mirror of the reference's `CMapWeather` manager.
 *
 * Driven from the debug UI for now rather than from `SMSG_WEATHER`; `setWeather`'s signature is the
 * wire's own (`type`, `grade`, `instant`) so the network path can call it unchanged later.
 */
export class WeatherState {
  /** The latest wire type, `Fine` included. */
  #kind: WeatherKind = WeatherKind.Fine;

  /**
   * The latest type an effect should spawn for. A type change cuts over at once (Fine included, so
   * a fine packet stops spawning immediately); the outgoing type's particles simply live out their
   * lifetimes. Only a same-type grade change drains through the ramp.
   */
  #effectKind: WeatherKind = WeatherKind.Fine;

  readonly #intensity = new Channel(1);

  readonly #sky = new Channel(4);

  /** Accumulated real seconds -- the channels' clock. */
  #now = 0;

  #intensityA = 0;

  #effectDensity = 0;

  #skyDensity = 0;

  get kind(): WeatherKind {
    return this.#kind;
  }

  get effectKind(): WeatherKind {
    return this.#effectKind;
  }

  /** Channel A's raw ramped value -- the wire grade, ramped. Instruments read this. */
  get effectIntensity(): number {
    return this.#intensityA;
  }

  /**
   * `max((A - 0.25) * 4/3, 0)` -- the density an effect actually spawns at. Nothing consumes it yet
   * (there is no precipitation renderer), but it is the same primitive and it is the value a
   * consumer must take rather than {@link effectIntensity}, so it is resolved here rather than
   * left for a caller to rediscover the knee.
   */
  get effectDensity(): number {
    return this.#effectDensity;
  }

  /** Channel B's current value, in the [0, 0.25] knee domain. `laws.stormBlend` turns it into `bcc`. */
  get skyDensity(): number {
    return this.#skyDensity;
  }

  /**
   * Apply one wire update (`SetWeather 0x67baf0` semantics). A `Fine` packet targets 0 whatever its
   * grade says.
   */
  setWeather(kind: WeatherKind, grade: number, instant: boolean): void {
    const target = kind === WeatherKind.Fine ? 0 : Math.min(1, Math.max(0, grade));
    if (kind !== this.#kind) {
      this.#effectKind = kind;
    }
    this.#kind = kind;
    const skyTarget = Math.min(SKY_KNEE, target);
    if (instant) {
      this.#intensity.snap(target);
      this.#sky.snap(skyTarget);
    } else {
      this.#intensity.retarget(target, this.#now);
      this.#sky.retarget(skyTarget, this.#now);
    }
    this.#resolve();
  }

  /** Advance the ramps by `dt` real seconds and republish. */
  tick(dt: number): void {
    this.#now += dt;
    this.#resolve();
  }

  /** The spawn density for one effect type: the active effect gets the ramped density, others 0. */
  densityFor(kind: WeatherKind): number {
    return this.#effectKind === kind ? this.#effectDensity : 0;
  }

  #resolve(): void {
    const a = this.#intensity.value(this.#now);
    this.#intensityA = a;
    this.#effectDensity = Math.max(0, (a - EFFECT_KNEE) * (4 / 3));
    this.#skyDensity = this.#sky.value(this.#now);
  }
}
