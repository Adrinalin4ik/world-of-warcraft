/**
 * THE LOOT GLOBALS -- the engine half of `LootFrame`, which is the client's own XML and Lua.
 *
 * Nothing is drawn here. `LootFrame.xml` declares the panel and four `LootButton`s and
 * `LootFrame.lua` fills and pages them; the whole deliverable is the answers plus the four events its
 * `LootFrame_OnLoad` registers for (`lootframe.lua:6-11`).
 *
 * ## The two slot numberings, and confusing them loses a player his drop
 *
 * The **wire** slot is 0-based and is the server's own index into its loot list;
 * `CMSG_AUTOSTORE_LOOT_ITEM` carries it and `SMSG_LOOT_REMOVED` names it, and a removal does NOT
 * renumber the survivors (`network/game/object/loot.ts`' header).
 *
 * The **display** index is 1-based and is what FrameXML passes: `LootFrame_UpdateButton` computes
 * `slot = numLootToShow * (page - 1) + index` and hands that to `LootSlotIsItem`, `LootSlotIsCoin`,
 * `GetLootSlotInfo` and `LootSlot` (`lootframe.lua:88-95`). **The COIN occupies display index 1
 * whenever there is money**, and the item rows follow it -- so display index and wire slot differ by
 * one when there is gold and are still not equal after a removal. `rowAt` below is the single mapping,
 * exactly as `benilla/src/ui_loot.rs:258`'s `action_at` is for the reference.
 *
 * ## `GetNumLootItems` counts ROWS, not items
 *
 * `LootFrame_Show` stores it as `self.numLootItems` and `LootFrame_Update` pages on it
 * (`lootframe.lua:141-151`), and the coin is a row the player clicks. Answering the item count alone
 * would make the last item unreachable on any corpse that also dropped money.
 *
 * ## What is NOT here
 *
 * The whole GROUP loot family -- `GetLootRollItemInfo`, `GetLootRollTimeLeft`, `GetMasterLootCandidate`
 * and the roll frames. Those need `SMSG_LOOT_START_ROLL`/`SMSG_LOOT_ROLL`/`SMSG_LOOT_ROLL_WON`, none of
 * which is decoded, and none of which a solo looter can produce. Declared, not stubbed.
 */
import type World from '../world';
import { LuaVM } from './framexml/lua/vm';
import { notImplemented } from './framexml/lua/methods/region';
import { fireEvent } from './framexml/lua/events';
import { GlueArt } from './art';
import { getItemTooltipSource, setItemTooltipSource, ItemTooltipInfo } from './framexml/lua/api/items';
import { itemData } from '../pipeline/dbc/item-data';
import type { LootHandler, LootRow } from '../../network/game/object/loot';
import { LOOT_TYPE_FISHING } from '../../network/game/object/loot';
import type { ItemHandler } from '../../network/game/object/items';

/**
 * The coin row's texture.
 *
 * `Interface\Icons\INV_Misc_Coin_01` -- the stem is the client's own and its BLP is confirmed present
 * on the asset host. The real client picks between several coin icons by denomination; this one is the
 * gold coin and is used for every pile, which is a stated simplification rather than a claim.
 */
const COIN_TEXTURE = 'Interface\\Icons\\INV_Misc_Coin_01';

/** What one display row resolves to: the coin, or an item row. */
type Row = { kind: 'money' } | { kind: 'item'; row: LootRow };

export function attachLootBridge(vm: LuaVM, world: World, art: GlueArt): () => void {
  const loot: LootHandler = world.game.objectHandler.lootHandler;
  const items: ItemHandler = world.game.objectHandler.itemHandler;

  /** Display index (1-based) -> the row it addresses. The ONE place the two numberings meet. */
  const rowAt = (index: number): Row | null => {
    if (!Number.isFinite(index) || index < 1) {
      return null;
    }
    const hasMoney = loot.gold > 0;
    if (hasMoney && index === 1) {
      return { kind: 'money' };
    }
    const itemIndex = (hasMoney ? index - 2 : index - 1);
    const row = loot.rows[itemIndex];
    return row === undefined ? null : { kind: 'item', row };
  };

  const numRows = (): number => loot.rows.length + (loot.gold > 0 ? 1 : 0);

  /**
   * An item row's icon, WITHOUT a query round trip.
   *
   * `SMSG_LOOT_RESPONSE` carries each row's own `displayInfoId`, so the loot window can draw its icons
   * from `ItemDisplayInfo.dbc` the instant it opens -- it never has to wait for
   * `SMSG_ITEM_QUERY_SINGLE_RESPONSE` the way a bag slot does. The NAME still needs the query, which is
   * why `LOOT_UPDATE` re-fires when a template lands.
   */
  const iconFor = (row: LootRow): string | null => itemData.iconForDisplayId(row.displayInfoId)
    ?? itemData.iconForEntry(row.itemId);

  // -- The globals --------------------------------------------------------------------------------

  vm.registerFunction('GetNumLootItems', () => [numRows()]);

  vm.registerFunction('LootSlotIsItem', (args) => [rowAt(Number(args[0]))?.kind === 'item']);
  vm.registerFunction('LootSlotIsCoin', (args) => [rowAt(Number(args[0]))?.kind === 'money']);

  /**
   * `GetLootSlotInfo(slot)` -> `texture, item, quantity, quality, locked`.
   *
   * FIVE returns, read straight off the client's own call site
   * (`lootframe.lua:95`: `local texture, item, quantity, quality, locked = GetLootSlotInfo(slot)`).
   *
   * The COIN row's `item` string is the client's own formatted money text and its quality is 1 --
   * `LootFrame_UpdateButton` colours the label with `ITEM_QUALITY_COLORS[quality]` and would index nil
   * otherwise. The amount is formatted by the client's own `GetCoinTextureString` so the coin icons and
   * the localisation are the game's, not ours.
   *
   * `locked` is `slotType == 3` (`LOOT_SLOT_TYPE_LOCKED`), which turns the row's name frame red
   * (`lootframe.lua:97-101`). That is a real wire value, not a guess.
   */
  vm.registerFunction('GetLootSlotInfo', (args) => {
    const row = rowAt(Number(args[0]));
    if (row === null) {
      return [];
    }
    if (row.kind === 'money') {
      const answer = vm.runExpr(
        `return GetCoinTextureString(${Math.floor(loot.gold)})`, 'loot-coin.lua',
      ) as { value?: unknown } | null;
      const text = String(answer?.value ?? '');
      return [COIN_TEXTURE, text === '' || text === 'nil' ? String(loot.gold) : text, 0, 1, false];
    }
    const template = items.template(row.row.itemId);
    return [
      iconFor(row.row),
      // Null, not a placeholder name, while the query is in flight: `text:SetText(nil)` leaves the
      // label empty and the row still draws, whereas inventing "Unknown" would be a claim.
      template?.name ?? null,
      row.row.count,
      template?.quality ?? 1,
      row.row.slotType === 3,
    ];
  });

  vm.registerFunction('GetLootSlotLink', (args) => {
    const row = rowAt(Number(args[0]));
    if (row === null || row.kind !== 'item') {
      return [null];
    }
    const template = items.template(row.row.itemId);
    if (template === null) {
      return [null];
    }
    const colour = vm.runExpr(
      `local _,_,_,hex = GetItemQualityColor(${template.quality}) return hex`, 'loot-link.lua',
    ) as { value?: unknown } | null;
    const hex = String(colour?.value ?? '|cffffffff');
    return [`${hex}|Hitem:${row.row.itemId}:0:0:0:0:0:0:0:0:0:0|h[${template.name}]|h|r`];
  });

  /**
   * `LootSlot(slot)` -- take it.
   *
   * The coin row sends `CMSG_LOOT_MONEY` and an item row sends `CMSG_AUTOSTORE_LOOT_ITEM` with the
   * row's own WIRE slot, never the display index. Nothing is removed locally: `SMSG_LOOT_REMOVED` and
   * `SMSG_LOOT_CLEAR_MONEY` are what empty the window, so there is one source of truth -- the same law
   * `CMSG_ATTACKSTOP` follows in leaving the bar to the server's reply.
   */
  vm.registerFunction('LootSlot', (args) => {
    const row = rowAt(Number(args[0]));
    if (row === null) {
      return [];
    }
    if (row.kind === 'money') {
      loot.takeMoney();
    } else {
      loot.take(row.row.slot);
    }
    return [];
  });

  /**
   * `CloseLoot([noRelease])` -- `LootFrame_OnHide` calls it with no argument (`lootframe.lua:207`),
   * and `LootFrame_OnEvent` calls it with `autoLoot == 0` when the frame could not be shown
   * (`lootframe.lua:21`).
   *
   * A truthy argument means "do not tell the server", which is the second call site's meaning exactly:
   * the UI failed to open, so the loot must stay open server-side. Otherwise `CMSG_LOOT_RELEASE` goes
   * out and `SMSG_LOOT_RELEASE_RESPONSE` closes the window.
   */
  vm.registerFunction('CloseLoot', (args) => {
    const noRelease = args[0] !== undefined && args[0] !== null && args[0] !== false;
    if (noRelease) {
      return [];
    }
    loot.release();
    return [];
  });

  /** `IsFishingLoot()` -- `loot_type == 3`, straight off the wire (`loot.rs:58-63`). */
  vm.registerFunction('IsFishingLoot', () => [loot.lootType === LOOT_TYPE_FISHING]);

  // -- The events ---------------------------------------------------------------------------------

  /**
   * Register the row art, then raise the event.
   *
   * `LOOT_OPENED`'s first argument is `autoLoot` (`lootframe.lua:16`), and **0 is the honest value**:
   * this client decodes no `autoLootDefault` CVar state from the server and never auto-loots, so
   * saying 1 would make `LootFrame_OnEvent` pass `CloseLoot(false)` down a path meant for a client that
   * had already taken everything.
   */
  const onOpened = (): void => {
    const paths = loot.rows.map((row) => iconFor(row)).filter((p): p is string => p !== null);
    paths.push(COIN_TEXTURE);
    for (const path of paths) {
      art.register(path, { path });
    }
    void art.load();
    // Ask for every row's template up front. `items.template` is what ISSUES the query, and the answer
    // re-enters through `templatesChanged` below -- so the window opens with icons and counts and the
    // names fill in a moment later rather than the whole window waiting on a round trip.
    for (const row of loot.rows) {
      items.template(row.itemId);
    }
    fireEvent(vm, 'LOOT_OPENED', [0]);
  };

  /**
   * A row went away. `LOOT_SLOT_CLEARED` carries the DISPLAY index, not the wire slot.
   *
   * `LootFrame_OnEvent`'s handler subtracts the page offset from it and hides `LootButton<n>`
   * (`lootframe.lua:23-52`), so a wire slot passed here would hide the wrong button -- or none, once
   * a coin row has shifted everything by one. The display index is computed BEFORE the row is dropped,
   * which is why the handler emits the wire slot and this closure resolves it against the list as it
   * was: `LootHandler` fires `lootRemoved` after filtering, so the index is recomputed from what
   * remains plus one. See the caveat below.
   */
  const onRemoved = (): void => {
    // A FULL RE-READ rather than a per-button clear. `LOOT_SLOT_CLEARED` needs the display index the
    // row HAD, and by the time this runs the row is already gone -- reconstructing it would mean
    // keeping a shadow copy of the list purely to name an index. `LootFrame_Update` re-reads every
    // button from `GetLootSlotInfo`, so raising `LOOT_SLOT_CHANGED` for each surviving row and letting
    // the client's own updater rebuild is both simpler and self-correcting. The reference makes the
    // same choice and says so (`benilla/src/ui_loot.rs:586-624`: Blizzard's per-button
    // `LOOT_SLOT_CLEARED` is "deliberately not emitted -- replaced by a full re-snapshot").
    const rows = numRows();
    if (rows === 0) {
      // The last row went. The real client closes the window itself -- the server never initiates a
      // creature-loot release (`ui_loot.rs:143-147`) -- so the release is ours to send.
      loot.release();
      return;
    }
    for (let index = 1; index <= rows; ++index) {
      fireEvent(vm, 'LOOT_SLOT_CHANGED', [index]);
    }
  };

  const onClosed = (): void => { fireEvent(vm, 'LOOT_CLOSED'); };

  /** A name arriving for a row already on screen. Same re-read as a removal. */
  const onTemplates = (): void => {
    if (loot.source === null) {
      return;
    }
    for (let index = 1; index <= numRows(); ++index) {
      fireEvent(vm, 'LOOT_SLOT_CHANGED', [index]);
    }
  };

  loot.on('lootOpened', onOpened);
  loot.on('lootRemoved', onRemoved);
  loot.on('lootClosed', onClosed);
  items.on('templatesChanged', onTemplates);

  /**
   * `GameTooltip:SetLootItem(slot)` -- CHAINED onto whatever the container bridge installed.
   *
   * Chained, not replaced: both bridges want the same hook and this one attaches second, so replacing
   * it outright would silently take every bag tooltip away. Anything that is not a loot row falls
   * through to the previous source. That is the same shape as any other decorator and it is the reason
   * `world-ui.ts` attaches the loot bridge AFTER the container bridge.
   */
  const previous = getItemTooltipSource(vm);
  const lootTooltip = (kind: string, a: number | string, b?: number): ItemTooltipInfo | null => {
    if (kind !== 'loot') {
      return previous === null ? null : previous(kind as never, a as never, b);
    }
    const row = rowAt(Number(a));
    if (row === null || row.kind !== 'item') {
      return null;
    }
    const template = items.template(row.row.itemId);
    if (template === null) {
      return null;
    }
    const lines: string[] = [];
    if (template.itemLevel > 0) {
      lines.push(`Item Level ${template.itemLevel}`);
    }
    if (row.row.count > 1) {
      lines.push(`Stack: ${row.row.count}`);
    }
    return { name: template.name, quality: template.quality, lines };
  };
  setItemTooltipSource(vm, lootTooltip as never);

  // -- The declared gaps --------------------------------------------------------------------------

  // THE GROUP-LOOT FAMILY IS NOT HERE. `GroupLootDropDown`'s OnLoad calls `GetMasterLootCandidate`
  // during the manifest load, and this bridge attaches after the tree is built -- so declaring it here
  // still left a nil in the load report. It lives in `api/items.ts`, which installs before the
  // manifest; see the rule stated there.
  const gaps: Array<[string, string, unknown[]]> = [
    ['LootSlotHasItem', 'superseded in 3.3.5a by LootSlotIsItem, which is what lootframe.lua calls; '
      + 'declared so an addon written against the older name is told rather than misled', [false]],
  ];
  for (const [name, reason, results] of gaps) {
    const stub = notImplemented(name, reason, results);
    vm.registerFunction(name, () => stub(null as never, 0, []));
  }

  (window as unknown as Record<string, unknown>).lootBridge = () => ({
    source: loot.source,
    gold: loot.gold,
    lootType: loot.lootType,
    rows: loot.rows,
    displayRows: numRows(),
  });

  return () => {
    setItemTooltipSource(vm, previous);
    loot.removeListener('lootOpened', onOpened);
    loot.removeListener('lootRemoved', onRemoved);
    loot.removeListener('lootClosed', onClosed);
    items.removeListener('templatesChanged', onTemplates);
    delete (window as unknown as Record<string, unknown>).lootBridge;
  };
}

export default attachLootBridge;
