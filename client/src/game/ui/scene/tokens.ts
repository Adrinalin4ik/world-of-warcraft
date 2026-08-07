/**
 * Which glue background scene a screen shows.
 *
 * The mapping is the client's own (`glueparent.lua:376` `SetBackgroundModel`, plus
 * `accountlogin.lua:34-36` for the main menu's expansion variant). An enum rather than a fake race
 * id, because the login scene is not a race and the fog law forks on the kind.
 */
export type GlueScene =
  /**
   * The login screen's stage. Which model shows is NOT an expansion check, however much it looks
   * like one: `accountlogin.lua:32-37` forks on `IsStreamingTrial()` — a trial account gets the
   * vanilla `UI_MainMenu` gate, and every other account gets `UI_MainMenu_Northrend`. So the normal
   * 3.3.5 login screen is the Wrath causeway, and the stone arch is the trial variant.
   */
  | { kind: 'mainmenu'; streamingTrial: boolean }
  /**
   * A stage the client's own Lua named. `SetBackgroundModel(model, name)` (glueparent.lua:374-386)
   * takes a NAME, builds `UI_<name>` out of it and hands the whole path to
   * `SetCharSelectBackground` / `SetCharCustomizeBackground`; `sceneFromPath` below reads the token
   * back out of that path, so this carries the client's word rather than a re-derivation of it.
   *
   * A TOKEN, not a race id, and that is not pedantry: `GetSelectBackgroundModel` answers
   * `"DEATHKNIGHT"` for a death knight of any race (characterselect.lua:538), which no race id can
   * express. It is also the `strupper(name)` key `SetLighting` looks `CharModelFogInfo`,
   * `CharModelGlowInfo` and `RaceLights` up by, which is why `lightingKey` is just its upper case.
   */
  | { kind: 'model'; token: string };

/**
 * ChrRaces ids to the scene each race's stage uses -- our `GetSelectBackgroundModel`
 * (`framexml/lua/api/characters.ts`), which is the only thing that turns a race id into a name.
 *
 * Gnome shares the Dwarf stage and Troll the Orc stage, and the client's own tables are the witness:
 * `CharModelFogInfo`, `GlueAmbienceTracks` and `RaceLights` (glueparent.lua:20-67) have no GNOME and
 * no TROLL key at all.
 */
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

/** The `UI_<token>` part of the model path. */
export function sceneToken(scene: GlueScene): string {
  if (scene.kind === 'mainmenu') {
    return scene.streamingTrial ? 'MainMenu' : 'MainMenu_Northrend';
  }
  return scene.token;
}

/**
 * The upper-case key the fog, glow and light tables are indexed by -- `SetLighting`'s `race`
 * argument, which `SetBackgroundModel` computes as `strupper(name)` (glueparent.lua:375,385).
 *
 * The main menu has no such key, and that is the whole of `buildRig`'s fork: `SetLighting` is only
 * ever reached through `SetBackgroundModel`, which only character select and create call.
 */
export function lightingKey(scene: GlueScene): string | null {
  return scene.kind === 'mainmenu' ? null : scene.token.toUpperCase();
}

/** `Interface\Glues\Models\UI_<token>\UI_<token>.m2` -- the client's own path construction. */
export function scenePath(scene: GlueScene): string {
  const token = sceneToken(scene);
  return `Interface\\Glues\\Models\\UI_${token}\\UI_${token}.m2`;
}

/**
 * The inverse of `scenePath`: recover the scene from the path the client's Lua built.
 *
 * This is the door `SetCharSelectBackground(path)` comes through. It is a PATH and not a name
 * because that is what `SetBackgroundModel` hands the engine, and reading the token back out is
 * what lets the client's own two lines (characterselect.lua:430-431) drive the stage without this
 * host guessing a race from a roster it would have to re-read.
 *
 * Returns null for anything that is not a `UI_<token>.m2`, so a caller reports the miss instead of
 * loading a path that will 404.
 */
export function sceneFromPath(path: string): GlueScene | null {
  const match = /(?:^|[\\/])UI_([^\\/]+)\.m2\s*$/i.exec(path.trim());
  if (!match) {
    return null;
  }
  return { kind: 'model', token: match[1] };
}

/** The name `GetSelectBackgroundModel` answers for a race id: the upper-case stage token. */
export function raceKey(race: number): string {
  return (RACE_TOKENS[race] ?? 'Human').toUpperCase();
}
