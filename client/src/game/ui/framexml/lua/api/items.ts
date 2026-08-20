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
import { notImplemented } from '../methods/region';
import type { ItemTooltipLine } from '../../../item-tooltip';

/**
 * THE PURSE, in copper, per VM.
 *
 * `WeakMap<LuaVM, ...>` and not a module-level number, mirroring `api/casting.ts:59-67`: the state
 * belongs to one VM and must not survive into the next one a relog builds.
 *
 * IT LIVES HERE, INSTALLED BEFORE THE MANIFEST, AND THAT PLACEMENT IS THE WHOLE POINT.
 * `GetMoney` was first written as a real global on `ui/container-bridge.ts`, which attaches AFTER the
 * tree is built -- and `MoneyFrame.lua:19` calls it from `MoneyFrame_OnLoad`, i.e. DURING the load. The
 * result was measured: thirteen `attempt to call a nil value (global 'GetMoney')` errors, one per
 * `ContainerFrame<n>MoneyFrame`, and no bag could show a coin. An engine global a document calls at
 * OnLoad has to exist before the document does; only its DATA may arrive late.
 */
const coinageByVm = new WeakMap<LuaVM, number>();

/** The container bridge pushes the live `PLAYER_FIELD_COINAGE` here on every descriptor flush. */
export function setCoinage(vm: LuaVM, copper: number): void {
  coinageByVm.set(vm, copper);
}

/** What a bag slot or a loot row resolves to for a tooltip. */
export interface ItemTooltipInfo {
  name: string;
  /** 0..7; the name line is drawn in `ITEM_QUALITY_COLORS[quality]`. */
  quality: number;
  /**
   * Body lines under the name, already ordered and already coloured. Empty is legal.
   *
   * **Was `string[]`, and every line drew white in one column.** `ui/item-tooltip.ts` builds these now:
   * a requirement the player cannot meet has to be RED and an effect GREEN, and damage/speed is one
   * line with two columns, so the shape the two bridges hand over had to carry colour and a right
   * column. `appendLine` already took both -- nothing new was needed at the drawing end.
   */
  lines: ItemTooltipLine[];
}

/**
 * Resolve `GameTooltip:SetBagItem(bag, slot)` / `:SetLootItem(slot)` / `:SetHyperlink(link)`.
 *
 * A VM-KEYED HOOK rather than a direct import, and for the reason the method tables already follow with
 * `getSpellbook`/`getAction`: `methods/gametooltip.ts` is a method table with no world and no session,
 * and it must not grow one. The container and loot bridges install this; before they do, the
 * `Set<Thing>Item` family answers false exactly as it did when it did not exist.
 */
export type ItemTooltipSource = (
  kind: 'bag' | 'loot' | 'link' | 'inventory',
  a: number | string,
  b?: number,
) => ItemTooltipInfo | null;

const tooltipSourceByVm = new WeakMap<LuaVM, ItemTooltipSource>();

export function setItemTooltipSource(vm: LuaVM, source: ItemTooltipSource | null): void {
  if (source === null) {
    tooltipSourceByVm.delete(vm);
  } else {
    tooltipSourceByVm.set(vm, source);
  }
}

export function getItemTooltipSource(vm: LuaVM): ItemTooltipSource | null {
  return tooltipSourceByVm.get(vm) ?? null;
}

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

  /**
   * `GetMoney()` -- the purse in COPPER, from `PLAYER_FIELD_COINAGE` (`enums.ts:464`).
   *
   * 0 until the container bridge pushes our own character's descriptor words, which is correct rather
   * than a stub: before the create block lands this client genuinely does not know the purse. This was
   * a DECLARED GAP in `api/units.ts` reading "PLAYER_FIELD_COINAGE is not read yet"; the field is read
   * now, so the declaration is gone rather than left describing a gap that has closed.
   */
  vm.registerFunction('GetMoney', () => [coinageByVm.get(vm) ?? 0]);

  /**
   * `GetPlayerTradeMoney()` -- 0, and a TRUE answer rather than a stub: no trade window is decoded, so
   * no money can be staked in one.
   *
   * `MoneyFrame.lua:18` displays `GetMoney() - GetCursorMoney() - GetPlayerTradeMoney()`. All three are
   * on ONE expression evaluated at `MoneyFrame_OnLoad`, so a single missing one takes the whole line
   * down -- which is how this was found: closing `GetCursorMoney` surfaced this, and closing this
   * surfaced `GetMoney`. Fixing them one at a time is what named all three.
   */
  vm.registerFunction('GetPlayerTradeMoney', () => [0]);

  /**
   * `InRepairMode()` -- false, a TRUE answer rather than a stub: repair mode is a MERCHANT state
   * (the hammer cursor at an armourer), and no merchant window exists in this client to enter it from.
   *
   * `ContainerFrameItemButton_OnEnter` (`containerframe.lua:775`) tests it immediately after
   * `GameTooltip:SetBagItem` to decide whether to append a repair-cost line, so with it nil every bag
   * tooltip threw one call AFTER the tooltip had already been filled -- the tooltip was built and then
   * the handler died before anything else it does could run.
   */
  vm.registerFunction('InRepairMode', () => [false]);

  /**
   * THE GROUP-LOOT GAPS, declared HERE rather than on `ui/loot-bridge.ts` -- and the placement is the
   * point, not an accident of tidying.
   *
   * `GroupLootDropDown`'s `OnLoad` calls `GetMasterLootCandidate` (`lootframe.lua:286`), i.e. DURING
   * the manifest load, and a bridge attaches after the tree is built. **This is the third time this
   * round that an OnLoad-time global put a nil in the load report** -- `GetMoney`, then
   * `GetInventorySlotInfo`, then this -- so the rule is worth stating where the next person will hit
   * it: a global FrameXML calls at OnLoad must be installed before the manifest runs. Only its DATA
   * may arrive late, through a VM-keyed state slot like `coinageByVm` above.
   *
   * Every one of these needs `SMSG_LOOT_START_ROLL` / `SMSG_LOOT_ROLL` / `SMSG_LOOT_ROLL_WON` /
   * `SMSG_LOOT_MASTER_LIST`, none of which is decoded -- and none of which a SOLO looter can provoke,
   * so nothing in this client can currently exercise them. Declared, so the load report names them.
   */
  const groupLootGaps: Array<[string, string, unknown[]]> = [
    ['GetMasterLootCandidate', 'SMSG_LOOT_MASTER_LIST is not decoded and master loot needs a party',
      []],
    ['GiveMasterLoot', 'as GetMasterLootCandidate', []],
    ['GetLootRollItemInfo', 'SMSG_LOOT_START_ROLL / SMSG_LOOT_ROLL are not decoded: group loot has no '
      + 'feed in this client and a solo looter never rolls', []],
    ['GetLootRollTimeLeft', 'as GetLootRollItemInfo -- the countdown rides SMSG_LOOT_START_ROLL', [0]],
    ['RollOnLoot', 'CMSG_LOOT_ROLL is not sent: there is no roll to answer', []],
    ['ConfirmLootSlot', 'the bind-on-pickup confirmation needs the LOOT_BIND popup path, which is not '
      + 'fed', []],
  ];
  for (const [name, reason, results] of groupLootGaps) {
    const stub = notImplemented(name, reason, results);
    vm.registerFunction(name, () => stub(null as never, 0, []));
  }

  /**
   * `GetInventorySlotInfo(slotName)` -> `slotID, textureName, checkRelic`.
   *
   * ANOTHER OnLoad-TIME GLOBAL, which is why it is installed here rather than on the container bridge:
   * `PaperDollFrame.lua:1130-1136` calls it from `PaperDollItemSlotButton_OnLoad` and immediately
   * `self:SetID(id)`. With it nil, `CharacterBag0Slot..Bag3Slot` never got an id -- measured, four
   * errors in the world load report -- and the bag bar's own arithmetic
   * (`containerframe.lua:804`, `bagButton:GetID() - CharacterBag0Slot:GetID() + 1`) reduces to
   * nonsense. The caller passes `strsub(slotName, 10)`, i.e. `"CharacterBag0Slot"` -> `"Bag0Slot"`.
   *
   * **The IDS are 1-based inventory slots and are the same numbering `GetInventoryItemTexture` reads**
   * -- `PLAYER_FIELD_INV_SLOT_HEAD + (id - 1) * 2` -- so head is 1, the four bags are 20..23, and ammo
   * is 0. That self-consistency with this client's own field table is the check on them; the ORDER
   * itself is engine-side and is transcribed, said plainly.
   *
   * **The TEXTURE stems were VERIFIED against the asset host rather than transcribed on trust**: every
   * `interface/paperdoll/ui-paperdoll-slot-<stem>.blp` below answers 200, and `-back` answers **404**,
   * which is why `BackSlot` takes the Chest art. That 404 is the only reason to believe the Back entry
   * rather than guess it.
   *
   * `checkRelic` is nil for every slot: it marks the ranged slot of a class whose "ranged" is a relic
   * (paladin/druid/shaman), and this client decodes no such class rule. Named rather than faked -- the
   * only effect is which empty-slot art the ranged button shows.
   */
  // DOUBLE backslashes, and the single-backslash version of this line was a real shipped defect.
  // This is a TS string literal, so `'Interface\PaperDoll\UI-...'` is read by JS as `\P` and `\U` --
  // neither is a valid escape, so JS DROPS both backslashes and the path becomes
  // `InterfacePaperDollUI-PaperDoll-Slot-`. That is the owner's
  // `glue art missing: InterfacePaperDollUI-PaperDoll-Slot-Ammo`, and the `Failed to decode texture`
  // that follows it is a 404's HTML error page being handed to the BLP decoder -- the fetch failed,
  // the decode never had a chance, and the message named the wrong layer.
  //
  // NOT a general separator bug: `pipeline/dbc/item-data.ts:37`'s `ICON_DIR` is correctly escaped, so
  // this does not explain the missing BAG icons, which remain a separate open question.
  const PAPERDOLL = 'Interface\\PaperDoll\\UI-PaperDoll-Slot-';
  const SLOTS: ReadonlyArray<readonly [string, number, string]> = [
    ['AmmoSlot', 0, 'Ammo'],
    ['HeadSlot', 1, 'Head'],
    ['NeckSlot', 2, 'Neck'],
    ['ShoulderSlot', 3, 'Shoulder'],
    ['ShirtSlot', 4, 'Shirt'],
    ['ChestSlot', 5, 'Chest'],
    ['WaistSlot', 6, 'Waist'],
    ['LegsSlot', 7, 'Legs'],
    ['FeetSlot', 8, 'Feet'],
    ['WristSlot', 9, 'Wrists'],
    ['HandsSlot', 10, 'Hands'],
    ['Finger0Slot', 11, 'Finger'],
    ['Finger1Slot', 12, 'Finger'],
    ['Trinket0Slot', 13, 'Trinket'],
    ['Trinket1Slot', 14, 'Trinket'],
    // `-back` is a 404 on the asset host; the client's back slot uses the Chest art.
    ['BackSlot', 15, 'Chest'],
    ['MainHandSlot', 16, 'MainHand'],
    ['SecondaryHandSlot', 17, 'SecondaryHand'],
    ['RangedSlot', 18, 'Ranged'],
    ['TabardSlot', 19, 'Tabard'],
    ['Bag0Slot', 20, 'Bag'],
    ['Bag1Slot', 21, 'Bag'],
    ['Bag2Slot', 22, 'Bag'],
    ['Bag3Slot', 23, 'Bag'],
  ];
  const slotsByName = new Map(SLOTS.map(([name, id, stem]) => [
    name.toLowerCase(), [id, `${PAPERDOLL}${stem}`] as const,
  ]));
  vm.registerFunction('GetInventorySlotInfo', (args) => {
    const row = slotsByName.get(String(args[0] ?? '').toLowerCase());
    if (row === undefined) {
      return [];
    }
    return [row[0], row[1], null];
  });
}
