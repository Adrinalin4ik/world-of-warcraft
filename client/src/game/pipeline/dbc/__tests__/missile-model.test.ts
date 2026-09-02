import { missileModelFrom } from '../spell-data';

/**
 * WHICH LAYER THIS COVERS: the three-way fork and nothing else. Whether the served files actually
 * carry these values is `spell-visual.test.ts`'s (real record bytes) and the measurement recorded on
 * `missileModelPath`; whether the emitted path FETCHES is `M2Blueprint`'s and `Loader`'s, and was
 * measured against the host rather than asserted here -- 1936 of 2042 distinct paths answer 200 once
 * the extension is rewritten to `.m2`.
 *
 * The middle case is the one worth a test. Both of the outer two are easy to get right and the
 * boundary between them is where reading the column unsigned would turn 2 ErrorCube visuals into 92.
 */
describe('missileModelFrom', () => {
  const pathOf = (id: number) => (id === 365 ? 'Spells\\Fireball_Missile_Low.mdx' : null);

  it('forks three ways: no missile, the real path, and the client ErrorCube', () => {
    // Fireball's visual 67 carries 365, which resolves.
    expect(missileModelFrom(365, pathOf)).toBe('Spells\\Fireball_Missile_Low.mdx');

    // A visual whose column is zero never reaches the map at all.
    expect(missileModelFrom(undefined, pathOf)).toBeNull();

    // BELOW THE GATE IS NOT THE ERROR CASE. 0 and every negative value mean "this visual names no
    // missile" -- 90 rows on the served file are negative, and the reference's gate is `>= 1`
    // (`creature_anim/spell_visual.rs:952-957`). ErrorCube here would be the 46-fold inflation.
    expect(missileModelFrom(0, pathOf)).toBeNull();
    expect(missileModelFrom(-1, pathOf)).toBeNull();
    expect(missileModelFrom(-2147483648, pathOf)).toBeNull();

    // Nonzero and unresolvable IS the error case: visual 20 names effect 52 and visual 9240 names
    // 3343, and neither row exists in the served table.
    expect(missileModelFrom(52, pathOf)).toBe('Spells\\ErrorCube.mdx');
    expect(missileModelFrom(3343, pathOf)).toBe('Spells\\ErrorCube.mdx');
  });
});
