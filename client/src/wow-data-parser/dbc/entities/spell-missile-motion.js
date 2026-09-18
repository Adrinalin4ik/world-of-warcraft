import * as r from 'restructure';

import Entity from '../entity';
import StringRef from '../string-ref';

/**
 * `SpellMissileMotion.dbc` -- THE PROJECTILE FLIGHT LAWS, and column 2 is LUA SOURCE rather than a
 * set of coefficients.
 *
 * The served 3.3.5a file measures `recordCount = 204`, `fieldCount = 5`, `recordSize = 20` and a
 * **`stringBlock` of 57,509 bytes** -- which is the tell: 204 rows do not need 57 KB of strings for a
 * name column alone. Read back, column 2 holds a script. Row 13 `Parabola`, verbatim:
 *
 *     local angle = 0
 *     local maxMagnitude = startDistance * .15
 *     transAngle = angle
 *     transMag = (progress * 2) - 1
 *     transMag = (1 - (transMag * transMag)) * maxMagnitude
 *
 * so the contract the engine evaluates is: inputs `progress`, `time`, `startDistance`,
 * `missileIndex`, `missileCount`, `rand1`, `rand2`; outputs `transAngle`, `transMag`, `transFront`,
 * `transRight`, `transUp`, `speedScalar`. Row 19 `Spiral Vortex` and row 20 `Drunken Missiles` use the
 * whole input set including `sin`/`cos` and both random seeds.
 *
 * **The reference has nothing to say about this table**: `SpellMissileMotion` (and `SpellMissile`)
 * appear NOWHERE in `samples/benilla` -- zero matches across every crate -- and `entities/missile.rs`
 * names the consequence for itself, "a lobbed shot reads as a straight glide here". So this file is
 * measured from the game's own data with no reference to port, which is the one case `CLAUDE.md` says
 * makes the served files the only oracle.
 *
 * Nothing evaluates the script yet. `world/spell-missile.ts` carries the reason (a per-missile
 * per-frame fengari evaluation needs its own measured round) and `spell-data.ts#missileMotionScript`
 * is the door.
 *
 * The two trailing columns are read as unsigned words and NOT named: column 3 is 0 on every row
 * sampled and column 4 takes small values (1 for `Parabola`, 7 for `Spiral Vortex`, 5 for `Drunken
 * Missiles`) that no measurement here explains. An unnamed unread column is correct; a guessed name
 * would be a defect.
 */
export default Entity({
  id: r.uint32le,
  /** The designer-facing label -- `Parabola`, `Spiral Vortex`, `Drunken Missiles`. */
  name: StringRef,
  /** LUA SOURCE. See the header for the input/output contract. */
  script: StringRef,
  unknown1: new r.Reserved(r.uint32le),
  unknown2: new r.Reserved(r.uint32le)
});
