import * as THREE from 'three';

import SpellMissiles from '../spell-missile';

/**
 * WHICH LAYER THIS COVERS: the flight law and the arrival hand-off, over a stub `spellData` and no
 * models. It is authoritative for "is the deadline fixed at launch", "is the direction re-resolved
 * every frame", "does a running target still get hit on the original schedule" and "does arrival hand
 * off to the impact kit".
 *
 * It is authoritative for NOTHING visual. Whether a fireball appears, is the right model or faces the
 * camera is the owner's check.
 *
 * The two spells are real: Fireball 133 has `Speed` 24.0 (measured at `Spell.dbc` column 47) and a
 * visual that names a missile model; Heroic Strike 78 has no Speed at all, which is the whole gate.
 */
const mockSpells: Record<number, { speed: number; visualID: number }> = {
  133: { speed: 24, visualID: 67 },
  78: { speed: 0, visualID: 39 },
};

jest.mock('../../pipeline/dbc/spell-data', () => ({
  spellData: {
    spellSpeed: (id: number) => (mockSpells[id]?.speed ?? 0),
    spell: (id: number) => (mockSpells[id] ?? null),
    // Null so nothing tries to load a model: the flight law is what is under test, and the reference
    // is explicit that a modelless missile "flies invisible and still impacts on schedule".
    missileModelPath: () => null,
    // No motion row: this test is about the straight arrive-on-time law, and `spell-motion.ts` has
    // its own instrument. Null is also the ordinary answer -- only 1051 of 9406 visuals name one.
    missileMotionScript: () => null,
  },
}));

const caster = { position: new THREE.Vector3(0, 0, 0) } as never;

describe('SpellMissiles flight', () => {
  it('fixes the deadline at launch and still lands on time when the target runs', () => {
    const fx = new SpellMissiles(new THREE.Scene());
    // 48 units away at Speed 24 -> a 2.0 s deadline, fixed now and never recomputed.
    const target = new THREE.Vector3(48, 0, 0);
    const unitAt = () => target;

    const impacts: Array<{ guid: string; spellId: number }> = [];
    const onImpact = (guid: string, spellId: number) => impacts.push({ guid, spellId });

    fx.launch(caster, 133, ['0xT'], [], null, null, unitAt);
    expect(fx.liveCount).toBe(1);
    expect(fx.stats.launched).toBe(1);
    // No model resolved, so it flies invisible -- named, counted, and still a real flight.
    expect(fx.stats.modelless).toBe(1);

    // THE TARGET RUNS, doubling the distance a second into the flight. Under a constant-speed lerp
    // this would arrive late or fall short; under arrive-on-time the step grows instead.
    fx.update(1000, unitAt, onImpact);
    expect(fx.liveCount).toBe(1);
    target.set(96, 0, 0);

    // 0.9 s more: still in flight, because the DEADLINE did not move when the target did.
    fx.update(900, unitAt, onImpact);
    expect(fx.liveCount).toBe(1);
    expect(impacts).toEqual([]);

    // The last 0.1 s of the original 2.0 s window: it arrives, on the schedule launch set.
    fx.update(150, unitAt, onImpact);
    expect(fx.liveCount).toBe(0);
    expect(impacts).toEqual([{ guid: '0xT', spellId: 133 }]);
  });

  it('refuses a spell with no Speed, and impacts at once at melee range', () => {
    const fx = new SpellMissiles(new THREE.Scene());
    const impacts: string[] = [];
    const onImpact = (guid: string) => impacts.push(guid);

    // SPEED IS THE WHOLE GATE. Heroic Strike is not a projectile and must launch nothing.
    fx.launch(caster, 78, ['0xT'], [], null, null, () => new THREE.Vector3(5, 0, 0));
    expect(fx.liveCount).toBe(0);
    expect(fx.stats.launched).toBe(0);
    expect(fx.stats.speedless).toBe(1);

    // MELEE RANGE. A target standing ON the caster gives a zero deadline, so the first frame is
    // already past it -- the reference's own case, "no visible flight or trail at all, just the
    // impact". Both ends get the same body lift, so the aim collapses onto the launch point.
    const onTop = () => new THREE.Vector3(0, 0, 0);
    fx.launch(caster, 133, ['0xM'], [], null, null, onTop);
    expect(fx.liveCount).toBe(1);
    fx.update(16, onTop, onImpact);
    expect(fx.liveCount).toBe(0);
    expect(impacts).toEqual(['0xM']);

    // A MISSED target flies and lands but hands off NO impact kit.
    impacts.length = 0;
    fx.launch(caster, 133, [], ['0xX'], null, null, () => new THREE.Vector3(1, 0, 0));
    fx.update(5000, () => new THREE.Vector3(1, 0, 0), onImpact);
    expect(fx.liveCount).toBe(0);
    expect(impacts).toEqual([]);
  });
});
