/**
 * ONE ITEM'S DURABILITY AND ONE ITEM'S REPAIR COST, in the one place both readers can reach.
 *
 * Two bridges need this and they must not each grow a copy -- that is the drift lesson
 * `container-bridge.ts` already records about the tooltip body, where two private two-line
 * implementations produced two different wrong tooltips:
 *
 *  - `ui/merchant-bridge.ts` sums it over the repair-all set to answer `GetRepairAllCost`;
 *  - `ui/container-bridge.ts` reads it for ONE bag slot to answer `GameTooltip:SetBagItem`'s second
 *    return, and reads the durability beside it so the tooltip line can say `current / max`.
 *
 * It lives in its own module rather than on either bridge because importing one bridge from the other
 * would be a cycle: the container bridge already reaches the merchant handler for the sell arm.
 *
 * The ARITHMETIC is not here -- `pipeline/dbc/durability-data.ts` owns it, along with the accounting
 * for which half is game data and which half is a server implementation. This module is only the
 * descriptor read that feeds it: the instance supplies the damage, the template supplies item level,
 * quality, class and subclass, and neither alone is enough.
 */
import { durabilityData } from '../pipeline/dbc/durability-data';
import { fieldAt } from './container-bridge';
import { ObjectType, ObjectField, ItemField } from '../../network/game/object/enums';
import type { ItemHandler } from '../../network/game/object/items';

/** `ITEM_FIELD_DURABILITY` and `ITEM_FIELD_MAXDURABILITY` for one item guid, or null. */
export function durabilityOf(
  items: ItemHandler, guid: string | null,
): { current: number; max: number } | null {
  if (guid === null) {
    return null;
  }
  const bag = items.object(guid);
  if (bag === null) {
    return null;
  }
  const max = fieldAt(bag, ObjectType.Item, ItemField.item_field_maxdurability);
  if (max === 0) {
    // Not a durability item at all -- a potion, a bag, a ring. Null rather than `{0, 0}`, so the
    // tooltip omits the line entirely instead of printing "0 / 0".
    return null;
  }
  return { current: fieldAt(bag, ObjectType.Item, ItemField.item_field_durability), max };
}

/**
 * What repairing ONE item would cost, in copper. **0 means nothing to pay; null means unknown.**
 *
 * Those two must not collapse -- see `durability-data.ts`' header. 0 is a fact about the item
 * (undamaged, or a subclass with no durability cost); null is a fact about this client (the template
 * has not arrived, or the DBC tables have not landed). A caller that sums these has to stop on a null
 * rather than treat it as free, or the total settles low and creeps upward as templates arrive.
 */
export function repairCostOf(items: ItemHandler, guid: string | null): number | null {
  if (guid === null) {
    return null;
  }
  const durability = durabilityOf(items, guid);
  if (durability === null) {
    // No durability word: zero copper, and a FACT rather than an unknown, so it must not gate a
    // repair-all button that a bagful of rings would otherwise grey out.
    return 0;
  }
  const lost = durability.max - durability.current;
  if (lost <= 0) {
    return 0;
  }
  const bag = items.object(guid);
  const entry = fieldAt(bag, ObjectType.Item, ObjectField.object_field_entry);
  const template = entry === 0 ? null : items.template(entry, guid);
  if (template === null) {
    // The query is still in flight. UNKNOWN, not free.
    return null;
  }
  return durabilityData.repairCost({
    lostDurability: lost,
    itemLevel: template.itemLevel,
    quality: template.quality,
    itemClass: template.itemClass,
    subClass: template.subClass,
  });
}
