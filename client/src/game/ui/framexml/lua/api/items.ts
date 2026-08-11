/**
 * `GetItemQualityColor` -- ONE global, and its absence was killing the whole UI panel system.
 *
 * ## What it broke, and how that was found
 *
 * Measured on the live load report, not reasoned about. `UIParent.xml`'s file report carried:
 *
 *     <Script file="UIParent.lua">: [string "UIParent.lua"]:102:
 *         attempt to call a nil value (global 'GetItemQualityColor')
 *
 * and line 102 is at **FILE SCOPE**, inside the loop that builds `ITEM_QUALITY_COLORS`:
 *
 *     ITEM_QUALITY_COLORS = { };
 *     for i = -1, 6 do
 *         ITEM_QUALITY_COLORS[i] = { };
 *         ITEM_QUALITY_COLORS[i].r, ..., ITEM_QUALITY_COLORS[i].hex = GetItemQualityColor(i);
 *     end                                                    -- uiparent.lua:95-103
 *
 * `uiparent.lua` is roughly 2000 lines long and that loop is 102 lines in, so **nothing below it was
 * ever defined**. Confirmed by asking the live VM (`/game?offline=1&ui=lua`):
 *
 *     UIParent                          = table   (the FRAME, from the XML -- so it looked fine)
 *     ShowUIPanel                       = nil
 *     HideUIPanel                       = nil
 *     GetUIPanelWindowInfo              = nil
 *     ToggleFrame                       = nil
 *     UIParent_OnLoad                   = nil
 *     UIPARENT_MANAGED_FRAME_POSITIONS  = nil
 *
 * That single nil is therefore the cause of at least three separate reported symptoms:
 *
 *  1. **Every `UIPanel` "correctly hidden".** `ToggleSpellBook` and `ToggleCharacter` both EXIST as
 *     functions -- checked -- and both call `ShowUIPanel`, which does not. So the spellbook could never
 *     open, and neither could the character sheet, the quest log or any other panel.
 *  2. **The cast bar sitting too low.** `CastingBarFrame`'s XML anchor is `BOTTOM, y = 55`
 *     (`castingbarframe.xml:101-112`) and that is only the fallback; its real position is managed, at
 *     `menuBarTop` (55, `uiparent.lua:1164`) `+ yOffset 40` = **95** (`uiparent.lua:1186`). With the
 *     table nil the managed pass cannot run and the bar keeps the authored 55 -- measured 40 units low,
 *     which is exactly the owner's report. Fifteen other frames read the same table.
 *  3. **`UIParent_OnLoad` never running**, which is a second error line in the same file report.
 *
 * This is the same class of defect as the round that found a missing `ceil` killing all of
 * `SpellBookFrame.lua`: one absent global, at file scope, in a long file. The lesson recorded there was
 * to count alias use across the manifest; the lesson here is that a missing ENGINE global does the same
 * damage and is not found by counting Lua library aliases.
 *
 * ## Where the numbers come from
 *
 * Stated plainly per `CLAUDE.md`: **these eight colours are not read from any file this project has.**
 * They live in the 3.3.5a client's binary -- there is no `ItemQuality.dbc` and no `GlobalStrings` entry
 * for them -- so they are transcribed from the client's own well-known quality palette. What IS checked
 * against the game's own code is the SHAPE: four returns (`r, g, b, hex`) and an index range of
 * **-1..6**, both read straight off `uiparent.lua:95-103`, and `hex` being a complete `|cffRRGGBB`
 * escape rather than bare digits -- `lootframe.lua:303` concatenates it directly with a name and closes
 * it with `FONT_COLOR_CODE_CLOSE`, so a bare `9d9d9d` would print as literal text.
 *
 * A wrong SHADE here tints an item name slightly off. A wrong shape, or nothing at all, takes the panel
 * system down -- which is why this exists at all, and why the shape is the part that was verified.
 */
import { LuaVM } from '../vm';

/**
 * Quality -> `[r, g, b]` as 0..1 floats, indexed 0..7.
 *
 * 0 Poor (grey), 1 Common (white), 2 Uncommon (green), 3 Rare (blue), 4 Epic (purple),
 * 5 Legendary (orange), 6 Artifact (light gold), 7 Heirloom (pale blue). 3.3.5a defines 0..7; the loop
 * in `uiparent.lua` only asks for -1..6, and -1 is handled below.
 */
const QUALITY_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [0.62, 0.62, 0.62],
  [1.0, 1.0, 1.0],
  [0.12, 1.0, 0.0],
  [0.0, 0.44, 0.87],
  [0.64, 0.21, 0.93],
  [1.0, 0.5, 0.0],
  [0.9, 0.8, 0.5],
  [0.0, 0.8, 1.0],
];

/** `r, g, b` -> `|cffRRGGBB`, the escape `hex` has to be. See the header on why it is not bare digits. */
function colorCode(r: number, g: number, b: number): string {
  const byte = (v: number): string => Math.max(0, Math.min(255, Math.round(v * 255)))
    .toString(16)
    .padStart(2, '0');
  return `|cff${byte(r)}${byte(g)}${byte(b)}`;
}

export function installItemsApi(vm: LuaVM): void {
  /**
   * `GetItemQualityColor(quality)` -> `r, g, b, hex`.
   *
   * Quality **-1** is asked for by `uiparent.lua`'s loop and is not a real quality; the client answers it
   * with the Poor colour, and answering nothing would leave `ITEM_QUALITY_COLORS[-1]` a table of nils
   * that a later `color.r` would fault on. Anything else out of range takes the same branch for the same
   * reason -- this function must not be able to fail, given what its failure took down.
   */
  vm.registerFunction('GetItemQualityColor', (args) => {
    const quality = Number(args[0]);
    const index = Number.isFinite(quality) && quality >= 0 && quality < QUALITY_COLORS.length
      ? Math.floor(quality)
      : 0;
    const [r, g, b] = QUALITY_COLORS[index];
    return [r, g, b, colorCode(r, g, b)];
  });
}
