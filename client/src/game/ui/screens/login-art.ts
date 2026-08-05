/**
 * The login screen's art, keyed by name, with the tex-coords the client authors.
 *
 * The tex-coords are not decoration: `Glue-Panel-Button-Up-Blue` is a 256x64 sheet whose button
 * occupies `0..0.578125` by `0..0.75`, and the probe screen that drew the whole sheet looked like a
 * blue strip. The values come from `GluePanelButtonUpTextureBlue` and its siblings in
 * `interface/gluexml/gluebuttons.xml`.
 *
 * Paths stay extensionless because `GlueArt` appends `.blp`, the way the client's own UI paths do.
 */
import { SpriteDef } from '../art';

/** The button sheet's used region, shared by up/down/disabled. */
const BUTTON_TC = { u0: 0, v0: 0, u1: 0.578125, v1: 0.75 };
/** The highlight sheet's used region differs -- it is a slightly larger glow. */
const BUTTON_HIGHLIGHT_TC = { u0: 0, v0: 0, u1: 0.625, v1: 0.6875 };

export const LOGIN_ART: Record<string, SpriteDef> = {
  logo: { path: 'Interface\\Glues\\Common\\Glues-WoW-WotLKLogo', size: [256, 128] },
  'input-border': { path: 'Interface\\Common\\Common-Input-Border' },
  'button-up': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Up-Blue',
    texCoords: BUTTON_TC,
    size: [170, 45],
  },
  'button-down': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Down-Blue',
    texCoords: BUTTON_TC,
    size: [170, 45],
  },
  'button-highlight': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Highlight-Blue',
    texCoords: BUTTON_HIGHLIGHT_TC,
    size: [170, 45],
  },
  'button-disabled': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Disabled',
    texCoords: BUTTON_TC,
    size: [170, 45],
  },
  // `GlueButtonSmallTemplateBlue` (gluebuttons.xml) reuses these exact four textures and tex-coords
  // at 150x38 instead of 170x45 -- same paths, same regions, only the authored size differs. Kept as
  // separate entries (rather than reusing `button-*`) so the table's `size` field stays truthful for
  // whichever button it names; the screen still sets its own widget size explicitly either way.
  'button-small-up': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Up-Blue',
    texCoords: BUTTON_TC,
    size: [150, 38],
  },
  'button-small-down': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Down-Blue',
    texCoords: BUTTON_TC,
    size: [150, 38],
  },
  'button-small-highlight': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Highlight-Blue',
    texCoords: BUTTON_HIGHLIGHT_TC,
    size: [150, 38],
  },
  'button-small-disabled': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Disabled',
    texCoords: BUTTON_TC,
    size: [150, 38],
  },
  'check-up': { path: 'Interface\\Buttons\\UI-CheckBox-Up', size: [20, 20] },
  'check-down': { path: 'Interface\\Buttons\\UI-CheckBox-Down', size: [20, 20] },
  'check-highlight': { path: 'Interface\\Buttons\\UI-CheckBox-Highlight', size: [20, 20] },
  'check-mark': { path: 'Interface\\Buttons\\UI-CheckBox-Check', size: [20, 20] },
  'blizzard-logo': { path: 'Interface\\Glues\\Mainmenu\\Glues-BlizzardLogo' },
  'dialog-background': { path: 'Interface\\DialogFrame\\UI-DialogBox-Background' },
};
