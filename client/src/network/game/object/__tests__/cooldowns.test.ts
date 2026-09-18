import { SpellHandler } from '../spells';

/**
 * **THE TWO COOLDOWN DEFECTS the owner reported, at the layer that decides them.**
 *
 * 1. "если я жму Каждый сам за себя, у меня не появляется кд, хотя должно быть 2 минуты. При этом
 *    гкд проходит как надо." -- `applyCastCooldowns` opened with the OFF-GCD gate as an early return
 *    over its whole body, so an off-GCD spell reached neither its own cooldown nor its category's.
 * 2. "если мы кастуем и каст прервался ... то гкд сбрасывается" -- nothing gave the global cooldown
 *    back, and giving it back must not refund a REAL cooldown.
 *
 * The rows are the REAL served `spell.dbc` values at the columns `spell-data.ts` measured
 * (49839 records / 234 fields / 936 B): **Every Man for Himself 59752 reads
 * `recoveryTime = 0`, `categoryRecoveryTime = 120000`, `category = 1182`, `startRecoveryCategory = 0`,
 * `startRecoveryTime = 0`** -- so its whole 2 minutes is in the CATEGORY column and it is off-GCD,
 * which is exactly the pair of properties that made it invisible.
 *
 * WHICH LAYER: `SpellHandler`'s cooldown table. No packets are parsed here and no Lua runs -- the
 * engine globals that read this table (`GetActionCooldown`, `GetSpellCooldown`) and the client's own
 * `ActionButton_UpdateCooldown` are a separate half, already wired, and the swirl itself is the
 * owner's to see.
 */

jest.mock('../../../../game/pipeline/dbc/spell-data', () => {
  const rows: Record<number, any> = {
    // Every Man for Himself: off-GCD, no own cooldown, 120 s CATEGORY cooldown.
    59752: {
      category: 1182, recoveryTimeMs: 0, categoryRecoveryTimeMs: 120000,
      startRecoveryCategory: 0, startRecoveryTimeMs: 0,
    },
    // ITS REAL CATEGORY-MATE, measured rather than assumed: scanning the served file for
    // `category == 1182` returns exactly TWO spells -- 59752 and 72757 "Will of the Forsaken
    // Cooldown Trigger (WOTF)" (own category cooldown 45000). A first draft of this fixture used
    // 42292 PvP Trinket as the mate and that was WRONG -- 42292 reads category 0 on the served file,
    // so it shares nothing.
    72757: {
      category: 1182, recoveryTimeMs: 0, categoryRecoveryTimeMs: 45000,
      startRecoveryCategory: 0, startRecoveryTimeMs: 0,
    },
    // Fireball: on-GCD, 1.5 s, no cooldown of its own.
    133: {
      category: 0, recoveryTimeMs: 0, categoryRecoveryTimeMs: 0,
      startRecoveryCategory: 133, startRecoveryTimeMs: 1500,
    },
    // Raptor Strike 2973: ON-NEXT-SWING, off-GCD, and its whole 6 s lives in the CATEGORY column.
    // The owner's test spell.
    2973: {
      category: 40, recoveryTimeMs: 0, categoryRecoveryTimeMs: 6000,
      startRecoveryCategory: 0, startRecoveryTimeMs: 0,
    },
    // Blood Fury: off-GCD with a 120 s cooldown of its OWN -- the other half of the same gate.
    20572: {
      category: 0, recoveryTimeMs: 120000, categoryRecoveryTimeMs: 0,
      startRecoveryCategory: 0, startRecoveryTimeMs: 0,
    },
  };
  return { spellData: { spell: (id: number) => rows[id] ?? null } };
});

/** A handler with no socket: only the cooldown table and the known set are exercised. */
function handler(known: number[]): SpellHandler {
  const h = Object.create(SpellHandler.prototype) as SpellHandler;
  const anyH = h as unknown as Record<string, unknown>;
  anyH.cooldowns = new Map();
  anyH.known = new Set(known);
  anyH.castStarted = new Set();
  anyH.emit = () => true;
  return h;
}

const apply = (h: SpellHandler, spellId: number, legs: 'gcd' | 'recovery' | 'all' = 'all'): boolean => (
  h as unknown as { applyCastCooldowns: (id: number, legs?: string) => boolean }
).applyCastCooldowns(spellId, legs);

it('an OFF-GCD spell gets its category cooldown -- Every Man for Himself is 120 s', () => {
  const h = handler([59752, 72757, 133]);

  expect(apply(h, 59752)).toBe(true);
  // 120000 ms -> 120 s, the owner's "должно быть 2 минуты". Under the early return this was null.
  expect(h.cooldownOf(59752)?.duration).toBe(120);
  // The CATEGORY is a separate mechanism and it reaches the family, not just the spell pressed. The
  // duration applied is the CAST spell's 120 s, not the mate's own 45 s -- casting one member puts
  // that member's category cooldown on the family.
  expect(h.cooldownOf(72757)?.duration).toBe(120);
  // And it did NOT put a global cooldown on anything: this spell is off-GCD.
  expect(h.cooldownOf(133)).toBeNull();

  // The other half of the same gate: off-GCD with its own cooldown rather than a category one.
  const blood = handler([20572]);
  expect(apply(blood, 20572)).toBe(true);
  expect(blood.cooldownOf(20572)?.duration).toBe(120);
});

it('a cancelled cast gives back the GCD and never refunds a real cooldown', () => {
  const h = handler([59752, 72757, 133]);

  // The racial's real 2 minutes is running...
  apply(h, 59752);
  // ...and then an on-GCD cast stamps 1.5 s across the GCD category.
  apply(h, 133);
  expect(h.cooldownOf(133)?.duration).toBe(1.5);

  // The cast is interrupted. The GCD goes back; the racial's cooldown does not.
  expect(h.clearGlobalCooldown()).toBe(true);
  expect(h.cooldownOf(133)).toBeNull();
  expect(h.cooldownOf(59752)?.duration).toBe(120);
  expect(h.cooldownOf(72757)?.duration).toBe(120);

  // Nothing left to give back, so a second cancel reports no change -- the return is the caller's
  // gate on announcing, which is the discarded-return defect class this project records.
  expect(h.clearGlobalCooldown()).toBe(false);
});

it('own and category cooldowns land at GO, never at START', () => {
  // THE OWNER'S DEFECT: "Все еще гкд начинается сразу, даже если нажал способность в середине
  // свинга. Тестирую на raptor strike." Raptor Strike's 6 s was stamped by the START handler, which
  // arrives at the PRESS -- so it began at once and pressing mid-swing changed nothing.
  //
  // The reference byte-verifies the boundary from both sides: the recovery legs land at
  // `HandleSpellGo`'s self-insert with "start = the GO receive-time"
  // (`net/apply/spells.rs:407-415`), and a failed cast needs no revert because "the spell's own
  // recovery was never started pre-launch" (`:99-103`). Only the GCD is armed early.
  const h = handler([2973]);

  // START's arm: the GCD leg alone. Raptor Strike is off-GCD, so this must write NOTHING.
  expect(apply(h, 2973, 'gcd')).toBe(false);
  expect(h.cooldownOf(2973)).toBeNull();

  // GO's arm: the recovery legs. NOW the 6 s starts, and it came from the category column.
  expect(apply(h, 2973, 'recovery')).toBe(true);
  expect(h.cooldownOf(2973)?.duration).toBe(6);

  // And a TIMED cast's GCD is still stamped at START -- the leg split must not cost that, which is
  // the behaviour a live measurement established (the sweep belongs during the cast, not after it).
  const fireball = handler([133]);
  expect(apply(fireball, 133, 'gcd')).toBe(true);
  expect(fireball.cooldownOf(133)?.duration).toBe(1.5);
});
