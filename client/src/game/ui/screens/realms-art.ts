/**
 * The realm-list screen's art, keyed by name, with the tex-coords the client authors.
 *
 * Paths stay extensionless because `GlueArt` appends `.blp`, the way the client's own UI paths do.
 * Every `size` here was confirmed by decoding the BLP -- which is how the panel's two RIGHT-hand
 * quadrants turned out to be 128x256 and not 256x256 like the other four.
 */
import { SpriteDef } from '../art';

/** The blue button sheet's used region, as `login-art.ts` documents it (gluebuttons.xml). */
const BUTTON_TC = { u0: 0, v0: 0, u1: 0.578125, v1: 0.75 };
const BUTTON_HIGHLIGHT_TC = { u0: 0, v0: 0, u1: 0.625, v1: 0.6875 };

/**
 * `UI-SortArrow` is a 16x8 sheet whose arrow occupies `0..0.5625` (9 of its 16 columns), authored by
 * `RealmSortButtonTemplate`'s `$parentArrow` (realmlist.xml:146-158).
 */
export const SORT_ARROW_TC = { u0: 0, v0: 0, u1: 0.5625, v1: 1 };
/**
 * The same region with `v` swapped, which points the arrow the other way. OURS: FrameXML flips this
 * one sheet vertically for the opposite sort direction, but the flip for THESE buttons happens in
 * `SortRealms`, an engine function, so nothing in the fetched data spells it out.
 */
export const SORT_ARROW_FLIPPED_TC = { u0: 0, v0: 1, u1: 0.5625, v1: 0 };

export const REALMS_ART: Record<string, SpriteDef> = {
  // `RealmListBackground`'s six stamped quadrants (realmlist.xml:282-337). NOT a 9-slice `Backdrop`:
  // the client lays out six whole textures, and the two right-hand ones are half-width files.
  'panel-topleft': { path: 'Interface\\HelpFrame\\HelpFrame-TopLeft', size: [256, 256] },
  'panel-top': { path: 'Interface\\HelpFrame\\HelpFrame-Top', size: [256, 256] },
  'panel-topright': { path: 'Interface\\HelpFrame\\HelpFrame-TopRight', size: [128, 256] },
  'panel-botleft': { path: 'Interface\\HelpFrame\\HelpFrame-BotLeft', size: [256, 256] },
  'panel-bottom': { path: 'Interface\\HelpFrame\\HelpFrame-Bottom', size: [256, 256] },
  'panel-botright': { path: 'Interface\\HelpFrame\\HelpFrame-BotRight', size: [128, 256] },

  // `RealmListHeader` (realmlist.xml:340-351) -- the same 256x64 title plate the dialog frames use.
  header: { path: 'Interface\\DialogFrame\\UI-DialogBox-Header', size: [256, 64] },

  // `RealmSortButtonTemplate`'s three stretched pieces (realmlist.xml:106-133). The sheet is 64x32,
  // so the authored fractions come out at exactly 5, 55 and 4 columns by 19 rows.
  'sort-left': {
    path: 'Interface\\FriendsFrame\\WhoFrame-ColumnTabs',
    texCoords: { u0: 0, v0: 0, u1: 0.078125, v1: 0.59375 },
    size: [5, 19],
  },
  'sort-middle': {
    path: 'Interface\\FriendsFrame\\WhoFrame-ColumnTabs',
    texCoords: { u0: 0.078125, v0: 0, u1: 0.90625, v1: 0.59375 },
    size: [10, 19],
  },
  'sort-right': {
    path: 'Interface\\FriendsFrame\\WhoFrame-ColumnTabs',
    texCoords: { u0: 0.90625, v0: 0, u1: 0.96875, v1: 0.59375 },
    size: [4, 19],
  },
  'sort-arrow': {
    path: 'Interface\\Buttons\\UI-SortArrow',
    texCoords: SORT_ARROW_TC,
    size: [9, 8],
  },
  // The column header's `HighlightTexture`, on ADD (realmlist.xml:159-175).
  'sort-highlight': {
    path: 'Interface\\PaperDollInfoFrame\\UI-Character-Tab-Highlight',
    size: [5, 24],
  },

  // `RealmListHighlightTexture`, on ADD, recoloured per row (realmlist.xml:494).
  'row-highlight': { path: 'Interface\\QuestFrame\\UI-QuestLogTitleHighlight', size: [128, 16] },

  // `GlueCloseButton` (gluetemplates.xml:4-16): 32x32, and its art is the round MINIMIZE button
  // sheet -- that is what the template names, whatever the small red glyph on it reads as.
  'close-up': { path: 'Interface\\Buttons\\UI-Panel-MinimizeButton-Up', size: [32, 32] },
  'close-down': { path: 'Interface\\Buttons\\UI-Panel-MinimizeButton-Down', size: [32, 32] },
  'close-highlight': {
    path: 'Interface\\Buttons\\UI-Panel-MinimizeButton-Highlight',
    size: [32, 32],
  },

  // `GlueDialogButtonTemplate`'s four states, and these stay the template's own NON-blue sheets.
  //
  // `GlueDialog_OnUpdate` does swap in the `-Blue` art on the login screen (gluedialog.lua:651-659),
  // but it iterates `GlueDialogButton1..3` by NAME -- the GlueDialog's own three buttons. `RealmList`
  // has its own `RealmListOkButton`/`RealmListCancelButton`, which that loop never touches, so they
  // keep `Glue-Panel-Button-Up` and its siblings. A reference screenshot agrees: Okay draws neutral
  // dark, and hovered Cancel draws the non-blue highlight's red rather than a blue glow.
  // Sized 125x35 after their override (realmlist.xml:732-767).
  'button-up': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Up',
    texCoords: BUTTON_TC,
    size: [125, 35],
  },
  'button-down': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Down',
    texCoords: BUTTON_TC,
    size: [125, 35],
  },
  'button-highlight': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Highlight',
    texCoords: BUTTON_HIGHLIGHT_TC,
    size: [125, 35],
  },
  'button-disabled': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Disabled',
    texCoords: BUTTON_TC,
    size: [125, 35],
  },
};
