/**
 * Which glue background scene a screen shows.
 *
 * The mapping is the client's own (`glueparent.lua:376` `SetBackgroundModel`, plus
 * `accountlogin.lua:34-36` for the main menu's expansion variant). An enum rather than a fake race
 * id, because the login scene is not a race and the fog law forks on the kind.
 */
export type GlueScene =
  | { kind: 'mainmenu'; northrend: boolean }
  | { kind: 'race'; race: number };

/** ChrRaces ids to the scene each race's stage uses. */
const RACE_TOKENS: Record<number, string> = {
  1: 'Human',
  2: 'Orc',
  3: 'Dwarf',
  4: 'NightElf',
  5: 'Scourge',
  6: 'Tauren',
  7: 'Dwarf', // Gnome shares the Dwarf stage
  8: 'Orc',   // Troll shares the Orc stage
  10: 'BloodElf',
  11: 'Draenei',
};

/** The `UI_<token>` part of the model path, and the key into the fog/light tables. */
export function sceneToken(scene: GlueScene): string {
  if (scene.kind === 'mainmenu') {
    return scene.northrend ? 'MainMenu_Northrend' : 'MainMenu';
  }
  return RACE_TOKENS[scene.race] ?? 'Human';
}

/** `Interface\Glues\Models\UI_<token>\UI_<token>.m2` -- the client's own path construction. */
export function scenePath(scene: GlueScene): string {
  const token = sceneToken(scene);
  return `Interface\\Glues\\Models\\UI_${token}\\UI_${token}.m2`;
}

/** The upper-case key `CharModelFogInfo` and `RaceLights` are indexed by. */
export function raceKey(race: number): string {
  return (RACE_TOKENS[race] ?? 'Human').toUpperCase();
}
