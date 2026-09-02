import { spellData } from '../pipeline/dbc/spell-data';
import { kitEmitters } from './spell-kit-fx';
import { warnOnce } from '../ui/framexml/lua/methods/region';

/**
 * **THE AURA STATE KIT: what a buff looks like for as long as it lasts.**
 *
 * The owner cast a mage's shield on himself and saw nothing ("попробовал забафать себя, щитом мага и
 * не увидел визуального эффекта"). This is the layer that was missing, and it is a different layer
 * from the cast flash: a buff's visual is **not** driven by `SMSG_SPELL_GO`. It hangs off the unit's
 * AURA state, arms when a spell id appears in the unit's aura slots, and lives until that id leaves
 * them.
 *
 * ## The mechanism, and the one place the reference cannot be copied
 *
 * Ported from `samples/benilla/crates/benilla-app/src/creature_anim/spell_visual.rs:1132`
 * (`arm_aura_state_fx`), which byte-pins the whole chain: the aura watcher `0x604d00 -> 0x6123f0 ->
 * 0x5ff350` reads `SpellVisual` **field 4** and plays that kit at **stage 2** (`0x5ff4c2: push 2`);
 * the remove path `0x612320 -> 0x5ff290` reaps it with `0x614150(spellId, force=1)`.
 *
 * **The SOURCE of the slot list does not transfer, and this is the sharpest 1.12/3.3.5a difference in
 * the area.** The reference reads `store.0.unit_auras()` -- 1.12 carried a unit's auras in its UPDATE
 * FIELDS (`UNIT_FIELD_AURA`, 48 slots). Those fields were **removed** after 1.12 and replaced by
 * `SMSG_AURA_UPDATE` / `SMSG_AURA_UPDATE_ALL`, which is why this client's aura truth lives in
 * `network/game/object/auras.ts#AuraHandler` and not in an update-field block.
 * `network/game/object/auras.ts` establishes that with two independent checks against data already in
 * this repo. So: **mechanism from the reference, slot source from this build.** There is exactly ONE
 * aura source of truth in this client and this module deliberately does not add a second -- it is
 * handed a slot list and diffs it.
 *
 * ## THE ARM PREDICATE IS "DOES THIS KIT DO ANYTHING", NOT "DOES IT HAVE A MODEL"
 *
 * The reference's own B114 defect was exactly the narrower predicate: Stealth's kit carries no effect
 * models at all -- its whole visual is one `CharProc` -- so an effects-only test dropped it and the
 * character showed nothing. This client can only draw the MODEL half today (see the named gap below),
 * so the narrower predicate is what is implemented, and the gap it leaves is reported with its
 * measured size rather than left silent.
 *
 * ## Measured on the served files, not estimated
 *
 * `spellvisual.dbc` (9406 records / 32 fields / 128 B) and `spellvisualkit.dbc` (8663 / 38 / 152) --
 * both headers agreeing with the entity docstrings that measured them:
 *
 *  - **3837** visuals carry a state kit; **2201** distinct kits, all live rows.
 *  - **1786** of those kits carry at least one effect model. The distribution of models per kit is
 *    `{0: 415, 1: 1473, 2: 239, 3: 38, 4: 13, 5: 19, 6: 3, 7: 1}` -- so the median armed kit spawns
 *    **one** model and the mean is **1.25** (2237 models over 1786 kits). That is the number the
 *    frame-cost note below is built on.
 *  - By slot, the state stage lives at the unit's FEET and CHEST: base 902, chest 579, head 216,
 *    hands 157 + 172, breath 69, world plant 121. The two slots this build cannot place
 *    (`spell-kit-fx.ts#UNTAGGED_SLOTS`, the 3.3.5a weapon pair) are touched by **14** state kits out
 *    of 2201, so the refusal there costs almost nothing on this stage.
 *  - Only **2** of 2237 effect ids fail to resolve to a model path.
 *  - **7470** spells reach a state kit that has at least one effect model -- the population this
 *    module serves.
 *
 * The owner's own case, resolved end to end on those files: Mana Shield 1463 -> visual 968 -> state
 * kit 990 -> base slot effect 718 -> `Spells\ManaShield_State_Base.mdx`; Ice Barrier 11426 -> 4302 ->
 * 3672 -> `spells\iceshield_state.mdx`; Power Word: Shield 17 -> 784 -> 847 ->
 * `Spells\HolyDivineShield_State_Base.mdx`. **Frost Ward, Fire Ward and all four Armor spells carry
 * NO state kit at all** (`stateKitID = 0`), so those genuinely have no body visual in the data and
 * their absence is not a defect.
 *
 * ## NAMED GAPS -- never a silent no-op
 *
 *  1. **The `CharProc` half of a state kit is not rendered.** A kit's four `CharProc` slots are what
 *     the aura does to the body ITSELF -- its translucency (proc 14), its tint (proc 1), its
 *     animation rate (proc 11) -- and the reference ships all three
 *     (`benilla-app/src/aura_visual.rs`). None of it is built here: this client has no per-unit alpha
 *     or tint channel, and `CLAUDE.md` records that writing a unit's materials from an effect pass is
 *     a write into every other copy in the zone (`ownsBatches` is the test). Measured size of the
 *     hole: **465** state kits carry a `CharProc`, of which **157 carry one and no effect model at
 *     all**, and those 157 are reached by **972 spells** -- headed by exactly the kits the reference
 *     names, at the same ids on this build: **kit 312** (Stealth 1784-1787, Vanish) and **kit 3450**
 *     (Invisibility 66, Fade 586). Proc census over state kits: type 1 (tint) 307, type 14 (alpha)
 *     83, type 11 (rate) 80, plus types 0/2/3/5/6/7/8/13/15/17 the reference does not model either.
 *     So a stealthed rogue is still fully opaque, and that is this gap and not a new one.
 *  2. **Nothing advances a spawned effect model's own animation**, which is
 *     `world/spell-kit-effects.ts`' own standing residual and matters MORE for an aura than for a
 *     cast. Measured on the three served shield models: `manashield_state_base.m2` has **0 particle
 *     emitters** (12 vertices, 3 additive materials, 3 transparency tracks),
 *     `iceshield_state.m2` has 1 and `icebarrier_state.m2` has 4 -- so for Mana Shield the MESH is
 *     the entire effect. All three author exactly the reference's stage-2 triple, sequence **0
 *     `Stand`** / **158 `Hold`** / **159 `Decay`** (Mana Shield 700 / 633 / 1100 ms), and every
 *     transparency track carries `globalSequence = -1`, i.e. it runs off the model's own clock rather
 *     than a global one. Nothing hands `Stand` over to `Hold`, so the shield holds its birth pose for
 *     the aura's whole life. It is VISIBLE rather than absent -- `M2#createTransparencyAnimations`
 *     initialises every track's value to **1.0** (`pipeline/m2/index.ts:903`) and nothing lowers it
 *     -- so the effect draws at FULL additive alpha where the artist authored a 0 -> 1 birth ramp
 *     settling to about 0.24-0.30 in `Hold`. Brighter and flatter than the real client, and named as
 *     such. Closing it is the posing pass in that module's own report, not a change here.
 *  3. **The kit SOUND** (`SpellVisualKit` column 15, and every one of these kits fills it -- Mana
 *     Shield 39, Ice Barrier 6616) is not rung: this client has no audio engine.
 *
 * ## Frame cost
 *
 * **This module costs ZERO per frame, by construction, and that is the design decision rather than an
 * optimisation.** An aura changes on a packet, never on a frame, so the diff is driven by
 * `AuraHandler`'s own `'auras'` emit and runs once per aura packet for the one unit that packet named.
 * The reference has to gate its equivalent on `Changed<ObjectStore>` and says why -- at its LBRS pin
 * an ungated version re-walked ~800 aura slot sets per frame re-deriving an unchanged answer
 * (`spell_visual.rs:1132`'s own comment). An event feed has no such failure mode available to it.
 *
 * A diff is one `Set` build and two membership walks over one unit's slots, which the server caps at
 * a few tens.
 *
 * **The continuing cost is the spawned models, and it is paid by `SpellKitEffects` and
 * `ParticleManager`, not here.** What this module changes is the POPULATION: a cast flash lives for
 * one sequence, an aura model lives for minutes, so the live-instance count is now a function of how
 * many buffed units are in view rather than of how many casts are in flight. At the measured **1.25
 * models per armed kit**, twenty buffed units carrying three visual-bearing auras each is
 * `20 x 3 x 1.25 = 75` live instances. Per instance per frame `SpellKitEffects#update` does one
 * `entities.get` (the `ownerGone` probe), one array-length read, one null compare, and an
 * `applyBillboards` only for a model that has billboarded bones -- so the tick itself is trivial at
 * that count. The real per-instance cost is the model's own emitters inside
 * `ParticleManager#animate`, which is that manager's existing per-emitter cost; the measured emitter
 * counts for the shield family are **0, 1 and 4**, and Mana Shield's zero means the commonest case
 * adds no emitter work at all. **The millisecond figure is still owed** -- it needs the models parsed
 * in a browser, which this round could not do -- and it is named as owed rather than estimated, the
 * same standing `spell-kit-effects.ts` takes for its own.
 */

/**
 * One unit's armed state kits: the spell ids this watcher has begun a persistent instance for.
 *
 * The reference's `armed: Local<EntityHashMap<Vec<u32>>>` and for its stated reason -- it tracks
 * exactly the `(unit, spell)` pairs THIS watcher began, so a remove edge never reaps another owner's
 * persistent instances (a channel hold whose spell also rides an aura).
 */
type ArmedByUnit = Map<string, Set<number>>;

/** What one diff decided: which spell ids to arm on this unit, and which to reap. */
export interface AuraKitDiff {
  /** `(spellId, kitId)` pairs to begin a persistent instance for. */
  begin: Array<{ spellId: number; kitId: number }>;
  /** Spell ids whose persistent instances must be reaped. */
  reap: number[];
}

/** An empty diff, shared -- the overwhelmingly common answer and not worth an allocation. */
const NOTHING: AuraKitDiff = { begin: [], reap: [] };

/**
 * Does this state kit do anything this client can draw?
 *
 * `kitEmitters` is the single resolver for a kit's attach-point models and world plant
 * (`spell-kit-fx.ts`), so asking it is what keeps this predicate and the actual spawn from ever
 * disagreeing about whether a kit is empty -- the failure the reference's B114 note describes from the
 * other direction.
 *
 * **Deliberately narrower than the reference's predicate**, which also arms on a `CharProc` or a kit
 * sound. See the module header's gap 1 for the measured size of what that costs and why the wider
 * predicate would arm something with nothing to show.
 */
function kitDraws(kitId: number): boolean {
  return kitEmitters(kitId).length > 0;
}

/**
 * The aura state-kit watcher: a slot list in, an arm/reap decision out.
 *
 * Pure over its own `armed` map -- no scene, no packets, no clock -- which is what makes the diff
 * testable and is the same reason `movement/server-ride.ts` is shaped this way.
 */
export class AuraStateKits {
  private armed: ArmedByUnit = new Map();

  /**
   * Spell id -> the state kit to arm, or `null` for "nothing to arm" (no state kit, or a kit this
   * client cannot draw).
   *
   * A MEMO, and it is what makes the two refusal counters mean something. Without it every aura
   * packet re-resolves and re-counts the same standing auras, so `noStateKit` and `charProcOnly`
   * would measure packet traffic instead of distinct spells -- and `warnOnce`'s dedupe would hide
   * that the number was inflating. With it, each counter is incremented exactly once per distinct
   * spell id and reads as "how many spells fell in this hole".
   *
   * **It must be dropped when the spell data arrives**, and `resweep` does that: every entry
   * resolved before `Spell.dbc` landed is a null that says nothing about the data. Caching those for
   * the session is precisely how the DBC race would become permanent instead of transient.
   */
  private resolved = new Map<number, number | null>();

  /**
   * Counters a probe reads, each one per DISTINCT spell id (see `resolved`). `charProcOnly` is gap
   * 1's live population: auras whose state kit exists and carries something, but nothing this client
   * draws -- the honest measure of how often a buff is refused rather than served.
   */
  public stats = {
    diffs: 0, armed: 0, reaped: 0, noStateKit: 0, charProcOnly: 0,
  };

  /**
   * Resolve one spell to the state kit to arm, memoised, counting and naming a refusal exactly once.
   */
  private kitFor(spellId: number): number | null {
    const cached = this.resolved.get(spellId);
    if (cached !== undefined) {
      return cached;
    }
    const kitId = spellData.stateKit(spellId);
    if (kitId === null) {
      // No state kit at all. The COMMON answer and not a gap: Frost Ward, Fire Ward and every Armor
      // spell measure `stateKitID = 0`, i.e. the data says these auras have no body visual.
      this.stats.noStateKit += 1;
      this.resolved.set(spellId, null);
      return null;
    }
    if (!kitDraws(kitId)) {
      // The kit exists and this client cannot draw it -- gap 1. NAMED rather than silently skipped,
      // and counted so how often it happens is a number.
      this.stats.charProcOnly += 1;
      this.resolved.set(spellId, null);
      warnOnce(
        `aura visual: spell ${spellId}'s state kit ${kitId} carries no effect model this client `
        + 'can place, so the aura shows nothing on the body. Its visual is a CharProc (translucency '
        + '/ tint / animation rate), which needs a per-unit render channel this client does not '
        + 'have -- 157 state kits and 972 spells are in this hole, headed by Stealth (kit 312) and '
        + 'Invisibility (kit 3450). See game/classes/aura-visual.ts.',
      );
      return null;
    }
    this.resolved.set(spellId, kitId);
    return kitId;
  }

  /**
   * Diff one unit's live aura spell ids against what is armed for it.
   *
   * `spellIds` may contain duplicates -- the same spell applied by two casters holds two slots, and
   * that is ONE state instance either way (the reference dedupes for the same reason). Order is
   * irrelevant; identity is the spell id.
   */
  diff(guid: string, spellIds: readonly number[]): AuraKitDiff {
    this.stats.diffs += 1;
    const prev = this.armed.get(guid);
    const live = new Set(spellIds);

    const reap: number[] = [];
    if (prev !== undefined) {
      for (const spellId of prev) {
        if (!live.has(spellId)) {
          reap.push(spellId);
        }
      }
    }

    const begin: Array<{ spellId: number; kitId: number }> = [];
    for (const spellId of live) {
      if (prev !== undefined && prev.has(spellId)) {
        continue; // already armed, the aura is merely still there -- no edge
      }
      const kitId = this.kitFor(spellId);
      if (kitId === null) {
        continue; // no state kit, or one this client cannot draw -- `kitFor` counted and named it
      }
      begin.push({ spellId, kitId });
    }

    if (begin.length === 0 && reap.length === 0) {
      // NOTHING IS RECORDED FOR A UNIT WE ARMED NOTHING FOR. An earlier version stored an empty
      // `Set` here to "keep the set in step", which recorded nothing and cost a Map entry per unit
      // whose auras this client cannot draw -- for ever, since only a reap edge removes one. It also
      // made `trackedUnits` count units with no instances at all, i.e. lie about the population it
      // exists to measure. An absent record and an empty one are indistinguishable to every reader
      // below (`prev.has` is false either way and the loop over `prev` runs zero times), so the
      // entry bought nothing.
      return NOTHING;
    }

    // The armed set is rebuilt from what SURVIVED plus what we are arming now -- never from `live`,
    // which would claim ownership of a spell whose kit we refused and then reap an instance we never
    // began.
    const next = new Set<number>();
    if (prev !== undefined) {
      for (const spellId of prev) {
        if (live.has(spellId)) {
          next.add(spellId);
        }
      }
    }
    for (const { spellId } of begin) {
      next.add(spellId);
    }
    // AN EMPTY SURVIVOR SET DELETES THE KEY rather than storing an empty `Set`, and a test caught
    // this: a guid whose last aura was reaped kept a record for the rest of the session, so
    // `trackedUnits` grew monotonically and never came back down. Harmless to behaviour -- an empty
    // record reads the same as none -- and a real leak of the number that reports the population.
    if (next.size === 0) {
      this.armed.delete(guid);
    } else {
      this.armed.set(guid, next);
    }

    this.stats.armed += begin.length;
    this.stats.reaped += reap.length;
    return { begin, reap };
  }

  /**
   * **Give back ownership of spells we did NOT manage to arm, and keep everything we did.**
   *
   * The distinction this exists to preserve, and its absence was a defect: a diff can return a
   * `begin` list the caller then fails to act on -- the body is not in the world this instant, so
   * there is nothing to hang a model on. Those spells must be disowned, because no instance exists
   * for them and a later reap would find nothing; but the spells armed by EARLIER diffs must be
   * KEPT, because their instances are live and this record is the only thing that can ever reap
   * them.
   *
   * `forget` was being used for this and it cannot distinguish the two -- it drops the whole unit.
   * A shield armed a minute ago and still up is exactly the case that gets lost, and a shield is the
   * commonest instance of the shape. See `aura-visuals.ts`'s absent-body branch for the two edges
   * and which one this is.
   *
   * A no-op for a guid we hold nothing for, and it never CREATES a record: disowning is subtraction
   * only.
   */
  unarm(guid: string, spellIds: readonly number[]): void {
    const held = this.armed.get(guid);
    if (held === undefined) {
      return;
    }
    for (const spellId of spellIds) {
      held.delete(spellId);
    }
    if (held.size === 0) {
      this.armed.delete(guid);
    }
  }

  /**
   * Forget a unit entirely -- it left the world.
   *
   * The instances themselves are torn down by `SpellKitEffects#update`'s own `ownerGone` sweep, so
   * this drops only the bookkeeping. Without it a guid that streams back in would look already-armed
   * and its buffs would never re-spawn -- the same stale-row failure the reference closes with
   * `armed.retain(...)`.
   */
  forget(guid: string): void {
    this.armed.delete(guid);
  }

  /**
   * Everything, for a worldport, a teardown, or the spell data arriving.
   *
   * The MEMO goes with the armed sets, and that is the load-bearing half: every `null` cached before
   * `Spell.dbc` landed is an answer about a table that was not there, and keeping those would make
   * the DBC race permanent. The refusal counters reset with it so they keep meaning "distinct spells
   * in this hole" rather than accumulating the pre-load nulls as well.
   */
  clear(): void {
    this.armed.clear();
    this.resolved.clear();
    this.stats.noStateKit = 0;
    this.stats.charProcOnly = 0;
  }

  /** How many units carry an armed state kit -- the population half of a cost measurement. */
  get trackedUnits(): number {
    return this.armed.size;
  }
}
