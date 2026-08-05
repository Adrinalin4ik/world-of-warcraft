/**
 * The `RealmList` screen, transcribed from `interface/gluexml/realmlist.xml` and `realmlist.lua`.
 *
 * Coordinates are the client's own: a full-screen BACKGROUND texture in solid black at alpha 0.75
 * (realmlist.xml:258-264); `RealmListBackground` 640x512 at `CENTER` x=24 y=0, built from six stamped
 * `HelpFrame-*` quadrants (realmlist.xml:282-337 -- the two right-hand ones are 128 wide, not 256);
 * `RealmListHeader` 256x64 at `TOP` x=-12 y=12 with its `SERVER_SELECTION` title at `TOP` y=-14; four
 * `RealmSortButtonTemplate` headers (223, 80, 100 and 138 wide by 19 tall) chained `LEFT`-to-`RIGHT`
 * from `BOTTOMLEFT`-to-the-panel's-`TOPLEFT` x=21 y=-50; 18 `RealmListRealmButtonTemplate` rows of
 * 512x16, the first at `TOPLEFT` x=22 y=-56 and each next one `TOP`-to-the-previous-`BOTTOM` y=-4;
 * `RealmListHighlight` 557x16 on ADD over the selected row; a 32x32 `GlueCloseButton` at `TOPRIGHT`
 * x=-42 y=-3; and `RealmListCancelButton`/`RealmListOkButton` at an overridden 125x35, the first at
 * `BOTTOMRIGHT` x=-46 y=13 and Okay at `RIGHT`-to-its-`LEFT` x=8.
 *
 * Deliberately NOT ported, each for a reason:
 *  - **The category tabs** (`RealmListTab1`, `RealmList.selectedCategory`, `RealmList_UpdateTabs`).
 *    The 3.3.5 realmd realm list has no category field -- `decodeRealmList`
 *    (network/protocol/wotlk/logon-wire.ts) is the whole of what a server tells us -- so there is
 *    nothing to tab between.
 *  - **`RealmHelpFrame`, the hover tooltips and the sounds.** They do not serve picking a realm, the
 *    same cut the login screen made for Credits and the TOS. There is no sound layer in this repo yet.
 *  - **`GlueScrollFrameTemplate`.** The client lays out 18 rows and scrolls past them; this lays out
 *    the same 18 and shows the first 18 of the sorted list. A realmd list longer than 18 is not
 *    something the private servers this client targets produce, and a scroll frame is a widget-layer
 *    feature rather than part of this screen -- see `ROW_COUNT`.
 *  - **`REALM_IS_FULL` and `REALM_LOCALE_WARNING`** (realmlist.lua:261-264, 281-283). Both are
 *    `GlueDialog` types, and the dialog belongs to the login screen; neither can be reached from what
 *    our wire decodes anyway (no full flag, no locale category).
 *
 * One visible difference from the real client, and it is structural rather than a layout slip: there,
 * `RealmList` is a DIALOG-strata frame drawn OVER a still-mounted `AccountLogin`, so the login screen's
 * edit boxes show faintly through the dim. `GlueApp` mounts one screen per state, so those widgets are
 * not there to show through. The 3D main-menu stage behind the dim IS kept (see `mount`), which is what
 * the dim is for.
 */
import { Anchor } from '../layout';
import { GlueContext, GlueScreen } from '../screens';
import { FontSpec, Widget } from '../widget';
import { RealmInfo } from '../../../network/protocol/types';
import {
  DEFAULT_REALM_SORT,
  HIGHLIGHT_FONT_COLOR,
  RealmSort,
  RealmSortColumn,
  nextRealmSort,
  realmDisplay,
  realmHighlightColor,
  realmLoadLabel,
  realmNameColor,
  realmPlayersText,
  realmRowName,
  realmTypeLabel,
  sortRealms,
} from './realm-list-state';
import { REALMS_ART, SORT_ARROW_FLIPPED_TC, SORT_ARROW_TC } from './realms-art';
import { wantsTrialScene } from './login-state';

/**
 * `GlueFontNormal`: FRIZQT, outlined, r=1.0 g=0.78 b=0 -> `#ffc700` (gluefontstyles.xml:14-22). The
 * client also draws a 1,-1 black shadow under it, which `FontSpec` has no channel for.
 */
const LABEL: FontSpec = {
  family: 'FRIZQT',
  size: 14,
  color: '#ffc700',
  outline: true,
  align: 'LEFT',
};

/** `GlueFontNormalSmall`: `SystemFont_Shadow_Outline_Med1` in the same gold (gluefontstyles.xml:65-67). */
const LABEL_SMALL: FontSpec = { ...LABEL, size: 12, align: 'CENTER' };

/** `GlueFontNormal` centred -- what `GlueDialogButtonTemplate`'s `ButtonText` uses. */
const BUTTON_CAPTION: FontSpec = { ...LABEL, align: 'CENTER' };

/**
 * `GlueFontHighlightSmall`: `GlueFontNormalSmall` recoloured white (gluefontstyles.xml:73-75). The
 * column headers' `NormalFont`, and the base font of the three right-hand row columns -- two of which
 * `RealmListUpdate` then recolours per row.
 */
const COLUMN_TEXT: FontSpec = { ...LABEL_SMALL, color: HIGHLIGHT_FONT_COLOR };

/** The header buttons' caption: `GlueFontHighlightSmall`, drawn from the `ButtonText`'s LEFT x=8. */
const SORT_CAPTION: FontSpec = { ...COLUMN_TEXT, align: 'LEFT' };

/** `GlueFontNormalLeft`: `GlueFontNormal`, left-justified (gluefontstyles.xml:23). Recoloured per row. */
const ROW_NAME: FontSpec = { ...LABEL };

/** `MAX_REALMS_DISPLAYED` (realmlist.lua:2), and `REALM_BUTTON_HEIGHT` with the authored 4-unit gap. */
const ROW_COUNT = 18;
const ROW_WIDTH = 512;
const ROW_HEIGHT = 16;
const ROW_GAP = 4;

/** The panel, and the header plate on it (realmlist.xml:266-351). */
const PANEL_WIDTH = 640;
const PANEL_HEIGHT = 512;

/** `RealmListHighlight` is 557x16 and anchors `TOPLEFT` to the selected row (realmlist.xml:485-497). */
const HIGHLIGHT_WIDTH = 557;

/** The four column headers, left to right, with the authored widths and their `SortRealms` keys. */
const COLUMNS: Array<{ id: string; column: RealmSortColumn; width: number; stringKey: string }> = [
  { id: 'realms-sort-name', column: 'name', width: 223, stringKey: 'REALM_NAME' },
  { id: 'realms-sort-type', column: 'mode', width: 80, stringKey: 'REALM_TYPE' },
  { id: 'realms-sort-characters', column: 'characters', width: 100, stringKey: 'REALM_CHARACTERS' },
  { id: 'realms-sort-load', column: 'load', width: 138, stringKey: 'REALM_LOAD' },
];

/** One laid-out row's widgets, so `update()` does not re-find them by id every frame. */
interface RealmRow {
  button: Widget;
  name: Widget;
  pvp: Widget;
  players: Widget;
  load: Widget;
}

export class RealmListScreen implements GlueScreen {
  private ctx: GlueContext | null = null;

  private panel: Widget | null = null;
  private rows: RealmRow[] = [];
  private highlight: Widget | null = null;
  private sortButtons: Array<{ button: Widget; arrow: Widget; glow: Widget; column: RealmSortColumn }> =
    [];
  private okButton: Widget | null = null;
  private okHighlight: Widget | null = null;
  private cancelButton: Widget | null = null;
  private cancelHighlight: Widget | null = null;
  private closeButton: Widget | null = null;
  private closeHighlight: Widget | null = null;

  private sort: RealmSort = DEFAULT_REALM_SORT;
  /**
   * The selected realm, held by NAME rather than by index -- `RealmList.selectedName`
   * (realmlist.lua:143-144) does the same, and for the same reason: the list is re-sorted and
   * refreshed under the selection, so an index would drift onto another realm.
   *
   * Starts null. The client would pre-select the realm the player last played (`currentRealm == 1`,
   * realmlist.lua:179), which nothing in the realmd response tells us, so the Okay button starts
   * disabled exactly as `RealmListUpdate` leaves it before a selection.
   */
  private selectedName: string | null = null;

  mount(ctx: GlueContext): void {
    this.ctx = ctx;
    ctx.art.registerAll(REALMS_ART);
    void ctx.art.load();

    // The same stage the login screen mounts: `RealmList` is a dimmed panel OVER the main menu, so
    // without this the 0.75 black lands over nothing and the screen reads as solid black.
    ctx.setScene({ kind: 'mainmenu', streamingTrial: wantsTrialScene(window.location.search) });

    const root = ctx.root.root;

    // `RealmList` itself: `setAllPoints` with one BACKGROUND texture, `<Color a="0.75" r="0" g="0"
    // b="0"/>` (realmlist.xml:258-264). A `Texture` with a Color and no file is a flat colour quad,
    // which is what `Widget#solid` draws -- introduced for the edit-box caret, but this one IS
    // authored art rather than ours.
    const dim = root.add(new Widget('texture', 'realms-dim'));
    dim.layer = 'BACKGROUND';
    dim.solid = true;
    dim.vertexColor = '#000000';
    dim.alpha = 0.75;
    // `enableMouse="true"` on the frame, and it matters beyond fidelity: this quad covers the whole
    // screen, so it is what stops a click landing on the 3D stage behind it.
    dim.mouseEnabled = true;
    dim.focusable = true;
    dim.setAnchors({ point: 'TOPLEFT', x: 0, y: 0 }, { point: 'BOTTOMRIGHT', x: 0, y: 0 });
    // `RealmList_OnKeyDown` (realmlist.lua:248-256) is a FRAME-level handler: ESCAPE cancels, ENTER
    // okays. Our router dispatches keys to the FOCUSED widget, so every focusable widget on this
    // screen carries the same pair -- see `wireKeys`. This one is the focus on mount.
    this.wireKeys(dim);

    this.panel = root.add(new Widget('frame', 'realms-panel'));
    this.panel.layer = 'BACKGROUND';
    this.panel.setSize(PANEL_WIDTH, PANEL_HEIGHT).setAnchors({ point: 'CENTER', x: 24, y: 0 });

    // The six quadrants, in the file's own order and with the file's own anchors -- three of them
    // measure from the panel's BOTTOM, and the two right-hand files are 128 wide (realmlist.xml:
    // 282-337). Added after `dim` on the same layer, so they draw over it.
    this.quadrant('realms-panel-topleft', 'panel-topleft', 256, 'TOPLEFT', 0);
    this.quadrant('realms-panel-top', 'panel-top', 256, 'TOPLEFT', 256);
    this.quadrant('realms-panel-topright', 'panel-topright', 128, 'TOPRIGHT', 0);
    this.quadrant('realms-panel-botleft', 'panel-botleft', 256, 'BOTTOMLEFT', 0);
    this.quadrant('realms-panel-bottom', 'panel-bottom', 256, 'BOTTOMLEFT', 256);
    this.quadrant('realms-panel-botright', 'panel-botright', 128, 'BOTTOMRIGHT', 0);

    // `RealmListHeader`: 256x64 on ARTWORK at TOP x=-12 y=12, so it overhangs the panel's top edge.
    const header = this.panel.add(new Widget('texture', 'realms-header'));
    header.layer = 'ARTWORK';
    header.sprite = 'header';
    header.setSize(256, 64).setAnchors({
      point: 'TOP',
      relativeTo: 'realms-panel',
      relativePoint: 'TOP',
      x: -12,
      y: 12,
    });

    // The title: `GlueFontNormalSmall`, `SERVER_SELECTION`, TOP of the header y=-14. The authored
    // FontString sizes itself to its text; a widget needs a rect, and a rect one line tall put at
    // that offset centres the text where the client's top edge plus half a line lands.
    const title = this.panel.add(new Widget('fontstring', 'realms-title'));
    title.layer = 'ARTWORK';
    title.font = LABEL_SMALL;
    title.text = ctx.strings.get('SERVER_SELECTION');
    title.setSize(256, LABEL_SMALL.size).setAnchors({
      point: 'TOP',
      relativeTo: 'realms-header',
      relativePoint: 'TOP',
      x: 0,
      y: -14,
    });

    COLUMNS.forEach((column, index) => {
      this.sortButtons.push(
        this.sortHeader(column, index === 0 ? null : COLUMNS[index - 1].id),
      );
    });

    // `RealmListHighlight` before the rows: on ADD UNDER the row text, which is what the client's
    // frame ordering gives it (the highlight is a sibling frame declared ahead of the row buttons,
    // realmlist.xml:485-497). Its width is 557, wider than the 512 row, and it is recoloured per row.
    this.highlight = this.panel.add(new Widget('texture', 'realms-highlight'));
    this.highlight.layer = 'ARTWORK';
    this.highlight.sprite = 'row-highlight';
    this.highlight.blend = 'ADD';
    this.highlight.setSize(HIGHLIGHT_WIDTH, ROW_HEIGHT).setAnchors({
      point: 'TOPLEFT',
      relativeTo: 'realms-row-0',
      relativePoint: 'TOPLEFT',
      x: 0,
      y: 0,
    });
    this.highlight.hide();

    for (let index = 0; index < ROW_COUNT; ++index) {
      this.rows.push(this.row(index));
    }

    // `RealmListCloseButton`, from `GlueCloseButton` (gluetemplates.xml:4-16): 32x32 at TOPRIGHT
    // x=-42 y=-3. Its `OnClick` is `RealmList:Hide()`, which is what Cancel leads to as well.
    this.closeButton = this.panel.add(new Widget('button', 'realms-close'));
    this.closeButton.layer = 'ARTWORK';
    this.closeButton.sprite = 'close-up';
    this.closeButton.mouseEnabled = true;
    this.closeButton.focusable = true;
    this.closeButton.setSize(32, 32).setAnchors({
      point: 'TOPRIGHT',
      relativeTo: 'realms-panel',
      relativePoint: 'TOPRIGHT',
      x: -42,
      y: -3,
    });
    this.closeButton.onClick = () => this.cancel();
    this.wireKeys(this.closeButton);
    this.closeHighlight = this.overlay(
      this.closeButton,
      'realms-close-highlight',
      'close-highlight',
      32,
      32,
      'ADD',
    );

    // Cancel first, because Okay anchors to it (realmlist.xml:732-767).
    this.cancelButton = this.actionButton('realms-cancel', 'CANCEL', {
      point: 'BOTTOMRIGHT',
      relativeTo: 'realms-panel',
      relativePoint: 'BOTTOMRIGHT',
      x: -46,
      y: 13,
    });
    this.cancelButton.onClick = () => this.cancel();
    this.cancelHighlight = this.buttonHighlight(this.cancelButton);

    this.okButton = this.actionButton('realms-ok', 'OKAY', {
      point: 'RIGHT',
      relativeTo: 'realms-cancel',
      relativePoint: 'LEFT',
      x: 8,
      y: 0,
    });
    this.okButton.onClick = () => this.join();
    this.okHighlight = this.buttonHighlight(this.okButton);
    // `RealmListOkButton:Disable()` at the top of every `RealmListUpdate` (realmlist.lua:39), until
    // a realm is selected.
    this.okButton.state = 'disabled';

    ctx.input.setFocus(dim);
  }

  /** One of the panel's six background quadrants. */
  private quadrant(
    id: string,
    sprite: string,
    width: number,
    point: 'TOPLEFT' | 'TOPRIGHT' | 'BOTTOMLEFT' | 'BOTTOMRIGHT',
    x: number,
  ): void {
    const texture = this.panel!.add(new Widget('texture', id));
    texture.layer = 'BACKGROUND';
    texture.sprite = sprite;
    texture.setSize(width, 256).setAnchors({
      point,
      relativeTo: 'realms-panel',
      relativePoint: point,
      x,
      y: 0,
    });
  }

  /**
   * One column header, from `RealmSortButtonTemplate` (realmlist.xml:103-176): a 5-wide left cap, a
   * 4-wide right cap and a middle piece stretched between them, all from one 64x32 sheet; the caption
   * at the button's LEFT x=8; the sort arrow at the caption's RIGHT x=3 y=-2; and a `HighlightTexture`
   * on ADD stretched from the button's LEFT to 4 past its RIGHT, 24 tall.
   */
  private sortHeader(
    column: { id: string; column: RealmSortColumn; width: number; stringKey: string },
    previousId: string | null,
  ): { button: Widget; arrow: Widget; glow: Widget; column: RealmSortColumn } {
    const button = this.panel!.add(new Widget('button', column.id));
    button.layer = 'BORDER';
    button.mouseEnabled = true;
    button.focusable = true;
    button.setSize(column.width, 19).setAnchors(
      previousId
        ? { point: 'LEFT', relativeTo: previousId, relativePoint: 'RIGHT', x: 0, y: 0 }
        : // The first header measures from the panel's TOPLEFT with its own BOTTOMLEFT, so the
          // authored y=-50 puts its BOTTOM edge 50 units below the panel's top.
          { point: 'BOTTOMLEFT', relativeTo: 'realms-panel', relativePoint: 'TOPLEFT', x: 21, y: -50 },
    );
    button.onClick = () => {
      this.sort = nextRealmSort(this.sort, column.column);
    };
    this.wireKeys(button);

    const left = button.add(new Widget('texture', `${column.id}-left`));
    left.layer = 'BORDER';
    left.sprite = 'sort-left';
    left.setSize(5, 19).setAnchors({
      point: 'TOPLEFT',
      relativeTo: column.id,
      relativePoint: 'TOPLEFT',
      x: 0,
      y: 0,
    });

    const right = button.add(new Widget('texture', `${column.id}-right`));
    right.layer = 'BORDER';
    right.sprite = 'sort-right';
    right.setSize(4, 19).setAnchors({
      point: 'TOPRIGHT',
      relativeTo: column.id,
      relativePoint: 'TOPRIGHT',
      x: 0,
      y: 0,
    });

    // Two opposing anchors, so `resolveAnchors` sizes the middle piece rather than this code
    // restating the arithmetic -- which is also how the client authors it.
    const middle = button.add(new Widget('texture', `${column.id}-middle`));
    middle.layer = 'BORDER';
    middle.sprite = 'sort-middle';
    middle.setSize(0, 19).setAnchors(
      { point: 'LEFT', relativeTo: `${column.id}-left`, relativePoint: 'RIGHT', x: 0, y: 0 },
      { point: 'RIGHT', relativeTo: `${column.id}-right`, relativePoint: 'LEFT', x: 0, y: 0 },
    );

    const caption = button.add(new Widget('fontstring', `${column.id}-text`));
    caption.layer = 'ARTWORK';
    caption.font = SORT_CAPTION;
    caption.text = this.ctx!.strings.get(column.stringKey);
    caption.setSize(column.width - 8, SORT_CAPTION.size).setAnchors({
      point: 'LEFT',
      relativeTo: column.id,
      relativePoint: 'LEFT',
      x: 8,
      y: 0,
    });

    // The arrow is the template's `NormalTexture`, so the client draws it on every header. Showing it
    // only on the ACTIVE column, and flipped for a descending sort, is OURS -- `SortRealms` is an
    // engine function and nothing in the fetched data says what it does to the arrow.
    const arrow = button.add(new Widget('texture', `${column.id}-arrow`));
    arrow.layer = 'ARTWORK';
    arrow.sprite = 'sort-arrow';
    arrow.setSize(9, 8).setAnchors({
      point: 'LEFT',
      relativeTo: `${column.id}-text`,
      relativePoint: 'RIGHT',
      x: 3,
      y: -2,
    });
    arrow.hide();

    const glow = button.add(new Widget('texture', `${column.id}-highlight`));
    glow.layer = 'ARTWORK';
    glow.sprite = 'sort-highlight';
    glow.blend = 'ADD';
    glow.setSize(0, 24).setAnchors(
      { point: 'LEFT', relativeTo: column.id, relativePoint: 'LEFT', x: 0, y: 0 },
      { point: 'RIGHT', relativeTo: column.id, relativePoint: 'RIGHT', x: 4, y: 0 },
    );
    glow.hide();

    return { button, arrow, glow, column: column.column };
  }

  /**
   * One realm row, from `RealmListRealmButtonTemplate` (realmlist.xml:179-256): a 512x16 button whose
   * own text is the realm name at LEFT x=5, then the type, character count and population columns
   * chained off it. `$parentPVP`'s XML anchor is the button's LEFT, but the template's `OnLoad`
   * repoints it to the name's RIGHT x=10 (realmlist.xml:220-222), and that is the one that governs.
   */
  private row(index: number): RealmRow {
    const id = `realms-row-${index}`;
    const button = this.panel!.add(new Widget('button', id));
    button.layer = 'ARTWORK';
    button.mouseEnabled = true;
    button.focusable = true;
    button.setSize(ROW_WIDTH, ROW_HEIGHT).setAnchors(
      index === 0
        ? { point: 'TOPLEFT', relativeTo: 'realms-panel', relativePoint: 'TOPLEFT', x: 22, y: -56 }
        : {
            point: 'TOP',
            relativeTo: `realms-row-${index - 1}`,
            relativePoint: 'BOTTOM',
            x: 0,
            y: -ROW_GAP,
          },
    );
    // `RealmSelectButton_OnClick` selects; `RealmSelectButton_OnDoubleClick` selects and okays.
    button.onClick = () => {
      const realm = this.visibleRealms()[index];
      if (realm) {
        this.selectedName = realm.name;
      }
    };
    button.onDoubleClick = () => {
      const realm = this.visibleRealms()[index];
      if (realm) {
        this.selectedName = realm.name;
        this.join();
      }
    };
    this.wireKeys(button);
    button.hide();

    const name = button.add(new Widget('fontstring', `${id}-name`));
    name.layer = 'OVERLAY';
    name.font = ROW_NAME;
    name.setSize(220, 12).setAnchors({
      point: 'LEFT',
      relativeTo: id,
      relativePoint: 'LEFT',
      x: 5,
      y: 0,
    });

    const pvp = button.add(new Widget('fontstring', `${id}-pvp`));
    pvp.layer = 'OVERLAY';
    // `GlueFontRedSmall` is the inherited font, but `RealmListUpdate` sets the colour on every row
    // before it is ever seen, so the base colour never shows -- `update()` owns it.
    pvp.font = COLUMN_TEXT;
    pvp.setSize(60, 12).setAnchors({
      point: 'LEFT',
      relativeTo: `${id}-name`,
      relativePoint: 'RIGHT',
      x: 10,
      y: 0,
    });

    const players = button.add(new Widget('fontstring', `${id}-players`));
    players.layer = 'OVERLAY';
    players.font = COLUMN_TEXT;
    players.setSize(32, 12).setAnchors({
      point: 'LEFT',
      relativeTo: `${id}-pvp`,
      relativePoint: 'RIGHT',
      x: 40,
      y: 0,
    });

    const load = button.add(new Widget('fontstring', `${id}-load`));
    load.layer = 'OVERLAY';
    load.font = COLUMN_TEXT;
    load.setSize(110, 12).setAnchors({
      point: 'LEFT',
      relativeTo: `${id}-players`,
      relativePoint: 'RIGHT',
      x: 45,
      y: 0,
    });

    return { button, name, pvp, players, load };
  }

  /** One of the two `GlueDialogButtonTemplate` buttons, at the authored 125x35 override. */
  private actionButton(id: string, stringKey: string, anchor: Anchor): Widget {
    const button = this.panel!.add(new Widget('button', id));
    button.layer = 'ARTWORK';
    button.sprite = 'button-up';
    button.mouseEnabled = true;
    button.focusable = true;
    button.setSize(125, 35).setAnchors(anchor);
    this.wireKeys(button);

    const caption = button.add(new Widget('fontstring', `${id}-text`));
    caption.layer = 'OVERLAY';
    caption.font = BUTTON_CAPTION;
    caption.text = this.ctx!.strings.get(stringKey);
    caption.setSize(125, 16).setAnchors({
      point: 'CENTER',
      relativeTo: id,
      relativePoint: 'CENTER',
      x: 0,
      y: 2, // `GlueDialogButtonTemplate`'s ButtonText offset (gluedialog.xml)
    });

    return button;
  }

  private buttonHighlight(button: Widget): Widget {
    return this.overlay(button, `${button.id}-highlight`, 'button-highlight', 125, 35, 'ADD');
  }

  /** A texture the client authors ON TOP of a control's normal art -- a `HighlightTexture` on ADD. */
  private overlay(
    parent: Widget,
    id: string,
    sprite: string,
    width: number,
    height: number,
    blend: 'ALPHA' | 'ADD' = 'ALPHA',
  ): Widget {
    const texture = parent.add(new Widget('texture', id));
    texture.layer = parent.layer;
    texture.sprite = sprite;
    texture.blend = blend;
    texture.setSize(width, height).setAnchors({
      point: 'CENTER',
      relativeTo: parent.id,
      relativePoint: 'CENTER',
      x: 0,
      y: 0,
    });
    texture.hide();
    return texture;
  }

  /**
   * `RealmList_OnKeyDown` (realmlist.lua:248-256), which the client hangs on the FRAME: ESCAPE
   * cancels, ENTER okays. `input.ts` routes keys to the focused widget, so the pair goes on every
   * focusable widget here rather than on one frame -- otherwise Escape would work only while the
   * focus happened to be on the panel.
   */
  private wireKeys(widget: Widget): void {
    widget.onCancel = () => this.cancel();
    // Not `onClick`: a row's click SELECTS and its Enter okays, and `input.ts` prefers `onSubmit`.
    widget.onSubmit = () => this.join();
  }

  /** The sorted list, clipped to the rows there are -- see `ROW_COUNT`. */
  private visibleRealms(): RealmInfo[] {
    return sortRealms(this.ctx?.protocol.realms ?? [], this.sort).slice(0, ROW_COUNT);
  }

  /**
   * `RealmList_OnOk` (realmlist.lua:258-268): join the selected realm.
   *
   * `chooseRealm` moves the session on by itself, and `GlueApp` mounts the screen for the new stage --
   * this screen does not navigate.
   */
  private join(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const realm = this.visibleRealms().find((candidate) => candidate.name === this.selectedName);
    // The same condition that enables the Okay button, derived from the DATA rather than read back
    // off the button: a double click selects and joins in one event, and the button's state is only
    // recomputed on the next frame, so reading it here swallowed the first double click on the screen.
    if (!realm || realmDisplay(realm).down) {
      return;
    }
    void ctx.protocol.chooseRealm(realm).catch(() => undefined);
  }

  /**
   * `RealmList_OnCancel` (realmlist.lua:270-278) and the close button: leave the realm list.
   *
   * `cancelLogin()` is the session's own way back to the login screen -- it returns the stage to
   * `Offline`, which is the stage `clientStateForStage` maps to `ClientState.Login`. It is NOT an
   * exact match for the client's cancel: the real client keeps its logon connection and can reopen
   * the realm list without re-authenticating, while this drops the session key with the credentials,
   * so the player logs in again. Closing that gap needs a session method this layer does not have --
   * something like `leaveRealmList()`, returning the stage to `Offline` while keeping the session key
   * and credentials so a later `login()`-free return is possible. Inventing a transition from inside
   * a screen would be worse than the extra login, so this uses what exists.
   */
  private cancel(): void {
    this.ctx?.protocol.cancelLogin();
  }

  private setShown(widget: Widget | null, shown: boolean): void {
    if (!widget) {
      return;
    }
    if (shown) {
      widget.show();
    } else {
      widget.hide();
    }
  }

  /** Recolour a font string without allocating a new `FontSpec` every frame. */
  private recolor(widget: Widget, base: FontSpec, color: string): void {
    if (widget.font?.color !== color) {
      widget.font = { ...base, color };
    }
  }

  /** `RealmListUpdate` (realmlist.lua:21-213), run per frame instead of per event. */
  update(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    const realms = this.visibleRealms();
    // The selection survives a re-sort by NAME, but not a realm leaving the list.
    if (this.selectedName && !realms.some((realm) => realm.name === this.selectedName)) {
      this.selectedName = null;
    }

    // The row the highlight sits on, if any: the selected realm, unless it is down -- a down realm
    // shows no highlight and leaves Okay disabled (realmlist.lua:157-159).
    const selectedIndex = realms.findIndex((realm) => realm.name === this.selectedName);
    const selectedDisplay = selectedIndex >= 0 ? realmDisplay(realms[selectedIndex]) : null;
    const highlightedIndex = selectedDisplay && !selectedDisplay.down ? selectedIndex : -1;

    this.rows.forEach((row, index) => {
      const realm = realms[index];
      if (!realm) {
        row.button.hide();
        return;
      }
      row.button.show();

      const display = realmDisplay(realm);
      const selected = realm.name === this.selectedName;

      // `button:Disable()` for a realm that is down (realmlist.lua:137-141) -- and the router then
      // refuses both hover and click, which is what `Disable` means.
      row.button.state = display.down ? 'disabled' : row.button.state === 'down' ? 'down' : 'up';

      const type = realmTypeLabel(display);
      const load = realmLoadLabel(display);

      row.name.text = realmRowName(realm);
      row.players.text = realmPlayersText(display);
      row.pvp.text = ctx.strings.get(type.stringKey);
      row.load.text = ctx.strings.get(load.stringKey);

      // `LockHighlight()` on the selected row (realmlist.lua:146) latches the highlight font, and a
      // hover does the same thing for one row at a time.
      const lit = selected || row.button.hovered;
      this.recolor(row.name, ROW_NAME, realmNameColor(display, lit));
      // The selected row's type and population columns go white too (realmlist.lua:162-163) -- a
      // mere hover does NOT do that, only the selection.
      this.recolor(row.pvp, COLUMN_TEXT, selected ? HIGHLIGHT_FONT_COLOR : type.color);
      this.recolor(row.load, COLUMN_TEXT, selected ? HIGHLIGHT_FONT_COLOR : load.color);
    });

    if (this.highlight) {
      const row = highlightedIndex >= 0 ? this.rows[highlightedIndex] : null;
      if (row && selectedDisplay) {
        this.highlight.anchors[0].relativeTo = row.button.id;
        this.highlight.vertexColor = realmHighlightColor(selectedDisplay);
        this.highlight.show();
      } else {
        this.highlight.hide();
      }
    }

    if (this.okButton) {
      // Enabled exactly when a highlightable realm is selected, which is where `RealmListUpdate`
      // calls `RealmListOkButton:Enable()` (realmlist.lua:147, 164).
      if (highlightedIndex >= 0) {
        if (this.okButton.state === 'disabled') {
          this.okButton.state = 'up';
        }
      } else {
        this.okButton.state = 'disabled';
      }
    }

    this.sortButtons.forEach((header) => {
      const active = header.column === this.sort.column;
      this.setShown(header.arrow, active);
      // A per-WIDGET tex-coord override, which the renderer prefers over the sprite's own.
      header.arrow.texCoords = active && this.sort.descending ? SORT_ARROW_FLIPPED_TC : SORT_ARROW_TC;
      this.setShown(header.glow, header.button.hovered);
    });

    this.buttonArt(this.okButton, this.okHighlight);
    this.buttonArt(this.cancelButton, this.cancelHighlight);

    if (this.closeButton) {
      this.closeButton.sprite = this.closeButton.state === 'down' ? 'close-down' : 'close-up';
      this.setShown(this.closeHighlight, this.closeButton.hovered);
    }
  }

  /** The Normal/Pushed/Disabled swap on the control plus its separate ADD highlight quad. */
  private buttonArt(button: Widget | null, highlight: Widget | null): void {
    if (!button) {
      return;
    }
    button.sprite =
      button.state === 'down'
        ? 'button-down'
        : button.state === 'disabled'
          ? 'button-disabled'
          : 'button-up';
    this.setShown(highlight, button.hovered);
  }

  unmount(): void {
    this.ctx = null;
    this.panel = null;
    this.rows = [];
    this.highlight = null;
    this.sortButtons = [];
    this.okButton = null;
    this.okHighlight = null;
    this.cancelButton = null;
    this.cancelHighlight = null;
    this.closeButton = null;
    this.closeHighlight = null;
    this.sort = DEFAULT_REALM_SORT;
    this.selectedName = null;
  }
}
