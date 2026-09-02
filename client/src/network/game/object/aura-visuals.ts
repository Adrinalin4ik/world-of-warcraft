import { AuraStateKits } from '../../../game/classes/aura-visual';
import { spellData } from '../../../game/pipeline/dbc/spell-data';
import { AuraHandler } from './auras';
import { GameHandler } from '../handler';

/**
 * **THE DOOR BETWEEN THE AURA FEED AND THE WORLD** -- the buff visual's driver.
 *
 * `AuraHandler` already holds the only aura truth this client has (`auras.ts`: guid -> slot -> entry,
 * fed by `SMSG_AURA_UPDATE` / `SMSG_AURA_UPDATE_ALL`), and it already announces every change as
 * `'auras'` with the guid. `AuraStateKits` already knows how to turn one unit's live spell ids into an
 * arm/reap decision, and `World#playSpellKit` / `SpellKitEffects#reap` already know how to spawn and
 * tear down a PERSISTENT kit instance keyed by `(guid, spellId)`. **Nothing in the chain was
 * missing except this subscription**, which is why this file is small and why it adds no state of its
 * own beyond the diff's.
 *
 * Hung off the existing feed rather than a second one, deliberately: the buff FRAMES on the owner's UI
 * are driven from the same handler through `ui/aura-bridge.ts`, so an icon on the bar and a model on
 * the body can never disagree about whether an aura is live.
 *
 * ## Why an event and not a frame
 *
 * The reference has to poll, and pays for it: `arm_aura_state_fx` gates on `Changed<ObjectStore>`
 * because an ungated version re-walked ~800 aura slot sets per frame at its LBRS pin
 * (`benilla-app/src/creature_anim/spell_visual.rs:1132`). Auras arrive on packets here, so the change
 * signal is exact and free -- this costs nothing on a frame that has no aura packet, which is nearly
 * all of them. See `game/classes/aura-visual.ts` for the full cost note.
 *
 * ## The one thing the reference does that this cannot
 *
 * The reference re-sweeps every unit once when its DBC resources land, because a unit that streamed in
 * before `SpellVisuals`/`Spells` arrived carries standing auras that no later store write will
 * re-announce. The same race exists here -- `spellData.stateKit` answers null until
 * `spellData.ensureLoaded()` has resolved -- and it is closed the same way: `resweep()` re-diffs every
 * tracked unit, called once when the spell data lands. Without it, logging in already buffed would
 * show nothing until the buff was reapplied.
 */
export class AuraVisualHandler {
  private game: GameHandler;

  private auras: AuraHandler;

  /** The pure diff. `stats` on it is the instrument; see its docstring. */
  public kits = new AuraStateKits();

  /** Kit instances this handler has asked the world to begin, for a probe to read. */
  public applied = { begun: 0, reaped: 0, unitMissing: 0, resweeps: 0 };

  constructor(gameHandler: GameHandler, auras: AuraHandler) {
    this.game = gameHandler;
    this.auras = auras;
    this.auras.on('auras', (guid: string) => this.apply(guid));
    // THE DBC RACE, closed the way every other bridge in this codebase closes it -- the
    // `void x.ensureLoaded().then(push)` idiom (`ui/aura-bridge.ts:675`, `ui/action-bridge.ts:595`).
    // `Spell.dbc` is 49 MB, so on any real login the aura packets win the race and `stateKit`
    // answers null for all of them; without this sweep a character who logs in already buffed shows
    // nothing until the buff is reapplied. It is also what makes the buffs of units that streamed in
    // during the wait appear -- the reference needs the same one-shot full sweep and says so
    // (`spell_visual.rs:1132`, "the unfiltered twin runs exactly once per DBC-resource arrival").
    void spellData.ensureLoaded().then(() => this.resweep());
  }

  /**
   * One unit's aura set changed: diff it and move the models.
   *
   * REAP BEFORE BEGIN, which is the reference's own order (`arm_aura_state_fx` walks `prev` for
   * removals before it walks `cur` for additions). It matters for a re-apply that flickers
   * remove -> add inside one packet: reaping first lets `SpellKitEffects#play`'s own
   * replace-on-persistent-begin collapse the pair to one instance instead of leaving an orphan.
   */
  private apply(guid: string): void {
    const world = this.game.world;
    if (!world) {
      return;
    }

    const spellIds = this.auras.forUnit(guid).map((aura) => aura.spellId);
    const diff = this.kits.diff(guid, spellIds);
    if (diff.begin.length === 0 && diff.reap.length === 0) {
      return;
    }

    for (const spellId of diff.reap) {
      world.spellKitEffects.reap(guid, spellId);
      this.applied.reaped += 1;
    }

    if (diff.begin.length === 0) {
      return;
    }

    const unit = world.entities.get(guid);
    if (!unit) {
      // The aura feed is not gated on the object feed: the server sends a unit's auras whether or not
      // its create block has reached us, and `AuraHandler` keeps them either way (which is right --
      // the buff frames need them). There is no body to hang a model on yet.
      //
      // COUNTED, not warned: this is a normal race on world entry rather than a defect, and
      // `resweep` is what closes it once the unit exists. A warning here would fire on every login.
      //
      // The armed set is dropped rather than partially kept, and that is SAFE rather than lossy: any
      // spell it was holding gets re-decided on the next diff, and `SpellKitEffects#play` reaps this
      // unit's live persistent instances of the same spell before beginning, so a re-arm replaces
      // instead of stacking. Keeping a partial set would be the lossy choice -- it would leave this
      // watcher claiming ownership of instances while the reap edge for them had already passed.
      this.applied.unitMissing += diff.begin.length;
      this.kits.forget(guid);
      return;
    }

    for (const { spellId, kitId } of diff.begin) {
      // `persistent: true` -- the state stage's lifetime is the aura's, so the instance lives until a
      // spell-id-keyed reap rather than self-terminating after one sequence
      // (`spell-kit-effects.ts`' own account of the two stages).
      world.playSpellKit(unit, spellId, kitId, true);
      this.applied.begun += 1;
    }
  }

  /**
   * Re-diff every unit whose auras we hold -- the DBC-arrival and world-entry sweep.
   *
   * The armed bookkeeping is dropped first, so a unit already carrying models is re-armed from
   * scratch; `SpellKitEffects#play` reaps this unit's live persistent instances of the same spell
   * before it begins, so a re-arm replaces rather than stacks.
   */
  resweep(): void {
    this.applied.resweeps += 1;
    this.kits.clear();
    for (const guid of this.auras.trackedGuids()) {
      this.apply(guid);
    }
  }

  /**
   * A unit left the world: drop its bookkeeping. See `AuraStateKits#forget`.
   *
   * **Nothing calls this yet, and that is stated rather than hidden.** `AuraHandler#forget` has no
   * caller either -- this client does not currently drop a despawned unit's auras -- so there is no
   * destroy edge to hang it on without widening into the object-update handler, which is another
   * agent's area this round. The consequence is bounded and not a leak of anything drawn: the MODELS
   * are torn down by `SpellKitEffects#update`'s own `ownerGone` sweep, so what survives is one `Set`
   * of spell ids per guid that left the world. A guid that streams back in is re-driven by the
   * `SMSG_AURA_UPDATE_ALL` the server sends for it, and `play`'s replace-on-begin keeps that single
   * -instanced. Named here so the round that adds a destroy edge knows to call it.
   */
  forget(guid: string): void {
    this.kits.forget(guid);
  }
}
