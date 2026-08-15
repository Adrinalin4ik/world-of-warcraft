import * as r from 'restructure';

import Entity from '../entity';
import LocalizedStringRef from '../localized-string-ref';
import StringRef from '../string-ref';

export default Entity({
  id: r.uint32le,
  flags: r.uint32le,

  factionID: r.uint32le,
  explorationSoundID: r.uint32le,
  maleDisplayID: r.uint32le,
  femaleDisplayID: r.uint32le,

  clientPrefix: StringRef,

  skip: new r.Reserved(r.uint32le),

  baseLanguage: r.uint32le,
  resSicknessSpellID: r.uint32le,
  splashSoundID: r.uint32le,
  clientFileString: StringRef,
  cinematicSequenceID: r.uint32le,

  /**
   * ONE UNACCOUNTED-FOR COLUMN, and the count is measured rather than guessed.
   *
   * The served `ChrRaces.dbc` header says **69 fields** (21 records, recordSize 276 = 69 * 4). This
   * schema summed to **68**: 13 scalars + three `LocalizedStringRef`s at 17 slots each (51) + four
   * trailing scalars. One short, so every field from here on was read one slot early -- which is why
   * `name` came back empty and `UnitRace` answered nil while `UnitClass` worked. `ChrClasses.dbc`
   * sums to exactly 60 against a header that says 60, which is the control that makes the arithmetic
   * trustworthy rather than a coincidence.
   *
   * IT GOES HERE, AFTER `clientFileString`, and that placement is evidence-backed rather than
   * arbitrary: `clientPrefix` (slot 6) and `clientFileString` (slot 11) are what
   * `scene/character-look.ts` dresses every character from, and dressing is owner-confirmed working
   * -- so every slot up to and including 11 must already be correct, and the missing column can only
   * be after it.
   *
   * NAMED `unknown` DELIBERATELY. 3.3.5a's own data does not say what it holds, and inventing a name
   * for a column read purely to advance the cursor would be exactly the invented source this project
   * treats as a defect.
   */
  unknown: new r.Reserved(r.uint32le),

  name: LocalizedStringRef,
  nameFemale: LocalizedStringRef,
  nameMale: LocalizedStringRef,

  facialHairCustomization: StringRef,
  facialHairCustomization2: StringRef,
  hairCustomization: StringRef,

  expansionID: r.uint32le
});
