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
  /**
   * Display index (1-based) -> the row it addresses. The ONE place the two numberings meet.
   *
   * **POSITIONAL AND STABLE.** The coin owns display index 1 whenever the loot EVER had money
   * (`hadMoney`, not `gold > 0`), and item rows follow it in array order including rows already taken.
   * Indices therefore never move while a window is open, which is exactly what
   * `LootFrame_UpdateButton`'s `button index -> slot index` mapping assumes
   * (`lootframe.lua:83-96`). A previous version dropped taken rows from the list, which renumbered
   * everything below and left an unnamed, never-hidden button behind -- the owner's ghost row.
   */
  const rowAt = (index: number): Row | null => {
    if (!Number.isFinite(index) || index < 1) {
      return null;
    }
    if (loot.hadMoney && index === 1) {
      return { kind: 'money' };
    }
    const itemIndex = (loot.hadMoney ? index - 2 : index - 1);
    const row = loot.rows[itemIndex];
    return row === undefined ? null : { kind: 'item', row };
  };

  /**
   * `GetNumLootItems`' answer: the number of SLOTS, taken ones included.
   *
   * Not the number of things still there. `LootFrame_UpdateButton` hides a button whose
   * `slot > numLootItems` (`lootframe.lua:94`), so shrinking this as items are taken would put a
   * surviving row's slot outside the count and hide the wrong button -- while an emptied slot is
   * already hidden by the `LootSlotIsItem`/`LootSlotIsCoin` test one line below it. The count is the
   * list's length; emptiness is per slot.
   */
  const numRows = (): number => loot.rows.length + (loot.hadMoney ? 1 : 0);

  /** Nothing left to take -- every item row taken and the coin gone. */
  const isEmpty = (): boolean => loot.gold === 0 && loot.rows.every((row) => row.taken);

  /** The 1-based DISPLAY index of an item row, by its wire slot. 0 when it is not in the list. */
  const displayIndexOfWireSlot = (wireSlot: number): number => {
    const at = loot.rows.findIndex((row) => row.slot === wireSlot);
    return at < 0 ? 0 : at + 1 + (loot.hadMoney ? 1 : 0);
  };

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

  /**
   * A TAKEN row is neither an item nor a coin, and that is what hides its button.
   *
   * `LootFrame_UpdateButton`'s show/hide decision is exactly
   * `if ( (LootSlotIsItem(slot) or LootSlotIsCoin(slot)) and index <= numLootToShow )` else
   * `button:Hide()` (`lootframe.lua:95-124`). So answering false for an emptied slot IS the hide --
   * no engine-side hiding is involved and none should be.
   */
  vm.registerFunction('LootSlotIsItem', (args) => {
    const row = rowAt(Number(args[0]));
    return [row !== null && row.kind === 'item' && !row.row.taken];
  });
  vm.registerFunction('LootSlotIsCoin', (args) => {
    const row = rowAt(Number(args[0]));
    return [row !== null && row.kind === 'money' && loot.gold > 0];
  });

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
    if (row === null || (row.kind === 'item' && row.row.taken)
      || (row.kind === 'money' && loot.gold === 0)) {
      // An emptied slot answers NOTHING, which is what makes the client's own `if ( texture )`-style
      // branches treat it as absent rather than as a row with blank fields.
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
    if (row === null || row.kind !== 'item' || row.row.taken) {
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
    if (row === null || (row.kind === 'item' && row.row.taken)
      || (row.kind === 'money' && loot.gold === 0)) {
      // An emptied slot is inert. The button over it is hidden, so this is only reachable from a
      // script, but answering it would send a second CMSG_AUTOSTORE_LOOT_ITEM for an item already in
      // the bag.
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
   * A row went away -- **`LOOT_SLOT_CLEARED`, with the DISPLAY index, which is what actually hides the
   * button.**
   *
   * THIS IS THE OWNER'S GHOST-ROW BUG AND THE COMMENT THAT USED TO BE HERE WAS WRONG. The previous
   * version raised `LOOT_SLOT_CHANGED` for indices 1..newCount and claimed that let "the client's own
   * updater rebuild". It does not: `LOOT_SLOT_CHANGED` runs `LootFrame_UpdateButton(slot)` for the ONE
   * index named (`lootframe.lua:53-69`), never `LootFrame_Update()`. With two items and one taken, the
   * new count was 1, only button 1 was ever named, and **nothing called `Hide()` on button 2** -- so it
   * kept drawing the row it had. The button was genuinely still shown; this was never a widget-layer
   * or draw-list problem, and `Hide()` works fine.
   *
   * `LOOT_SLOT_CLEARED` is the client's own answer and it hides exactly that button
   * (`lootframe.lua:23-41`). It takes the DISPLAY index -- its handler subtracts the page offset from
   * the argument and indexes `LootButton<n>` with the result -- so the wire slot must be converted
   * first. With rows no longer compacted, that conversion is now stable for the life of the window.
   *
   * The reference's note that Blizzard's per-button `LOOT_SLOT_CLEARED` is "deliberately not emitted --
   * replaced by a full re-snapshot" (`benilla/src/ui_loot.rs:586-624`) describes benilla's OWN authored
   * UI, which does not run `LootFrame.lua` at all. This client does, so the client's event is the one
   * to raise. Citing it for the opposite conclusion was the mistake.
   */
  const onRemoved = (wireSlot: number): void => {
    const index = displayIndexOfWireSlot(wireSlot);
    if (index > 0) {
      fireEvent(vm, 'LOOT_SLOT_CLEARED', [index]);
    }
    closeIfEmpty();
  };

  /** The coin row emptying. Same event, and its display index is always 1. */
  const onMoneyCleared = (): void => {
    fireEvent(vm, 'LOOT_SLOT_CLEARED', [1]);
    closeIfEmpty();
  };

  /**
   * Nothing left to take -> release.
   *
   * The server never initiates a creature-loot release (`benilla/src/ui_loot.rs:143-147`), so the
   * release is ours to send. Gated on `isEmpty()` rather than on the list being short, because the list
   * no longer shrinks -- a taken row stays in it.
   */
  const closeIfEmpty = (): void => {
    if (isEmpty()) {
      loot.release();
    }
  };

  const onClosed = (): void => { fireEvent(vm, 'LOOT_CLOSED'); };

  /** A name arriving for a row already on screen. Same re-read as a removal. */
  const onTemplates = (): void => {
    if (loot.source === null) {
      return;
    }
    // Every slot, taken ones included: `LootFrame_UpdateButton` is what decides shown-versus-hidden
    // per index, so naming an index is always safe and never naming one is what leaves a stale button.
    for (let index = 1; index <= numRows(); ++index) {
      fireEvent(vm, 'LOOT_SLOT_CHANGED', [index]);
    }
  };

  loot.on('lootOpened', onOpened);
  loot.on('lootRemoved', onRemoved);
  loot.on('lootMoneyCleared', onMoneyCleared);
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
    hadMoney: loot.hadMoney,
    rows: loot.rows,
    displayRows: numRows(),
    empty: isEmpty(),
  });

  return () => {
    setItemTooltipSource(vm, previous);
    loot.removeListener('lootOpened', onOpened);
    loot.removeListener('lootRemoved', onRemoved);
    loot.removeListener('lootMoneyCleared', onMoneyCleared);
    loot.removeListener('lootClosed', onClosed);
    items.removeListener('templatesChanged', onTemplates);
    delete (window as unknown as Record<string, unknown>).lootBridge;
  };
}

export default attachLootBridge;
