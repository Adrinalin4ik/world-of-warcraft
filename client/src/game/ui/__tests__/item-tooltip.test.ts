import { itemTooltipLines } from '../item-tooltip';
import type { LuaVM } from '../framexml/lua/vm';
import type { ItemTemplate } from '../../../network/game/object/items';

/**
 * A stand-in VM that answers the two chunks `item-tooltip.ts` runs.
 *
 * Not a real `LuaVM`: booting fengari and the whole 264-file manifest to read four global strings would
 * make this an integration test of the loader. What IS exercised is the part that can be wrong -- which
 * globals are asked for, with what arguments, and in what order the lines come out -- so the fake
 * implements `GlobalStrings` as a table and `string.format` for the specifiers the real strings use.
 *
 * The eleven format strings below are VERBATIM from the served `globalstrings.lua`. That is the point of
 * copying them rather than inventing shapes: `%c%d` really is how a primary stat is written, which is
 * the discriminator `statLine` keys its arity and its colour off.
 */
const GLOBALS: Record<string, string> = {
  ITEM_LEVEL: 'Item Level %d',
  ITEM_BIND_ON_EQUIP: 'Binds when equipped',
  INVTYPE_HEAD: 'Head',
  ARMOR_TEMPLATE: '%d Armor',
  ITEM_MOD_STAMINA: '%c%d Stamina',
  ITEM_MOD_DODGE_RATING: 'Increases your dodge rating by %d.',
  ITEM_MIN_LEVEL: 'Requires Level %d',
  DURABILITY_TEMPLATE: 'Durability %d / %d',
  SELL_PRICE: 'Sell Price',
  SILVER_AMOUNT: '%d Silver',
  COPPER_AMOUNT: '%d Copper',
};

/** `string.format` for the three specifiers the real strings above use: `%d`, `%c` and `%s`. */
function luaFormat(format: string, args: string[]): string {
  let index = 0;
  return format.replace(/%[dcs]/g, (spec) => {
    const arg = args[index];
    index += 1;
    if (spec === '%c') {
      return String.fromCharCode(Number(arg));
    }
    return arg === undefined ? '' : arg;
  });
}

const vm = {
  runExpr(source: string) {
    // `return <KEY>` -- the raw read.
    const raw = /return ([A-Za-z_][A-Za-z0-9_]*)$/.exec(source);
    if (raw !== null) {
      return { value: GLOBALS[raw[1]] };
    }
    // `return string.format(KEY, a, b, ...)` -- arguments are numbers or further global names.
    const call = /return string\.format\(([^)]*)\)$/.exec(source);
    if (call === null) {
      return { value: undefined };
    }
    const parts = call[1].split(',').map((part) => part.trim());
    const format = GLOBALS[parts[0]];
    if (format === undefined) {
      return { value: undefined };
    }
    const args = parts.slice(1).map((part) => GLOBALS[part] ?? part);
    return { value: luaFormat(format, args) };
  },
} as unknown as LuaVM;

/** A plate-armour helm: the shape that exercises every group of lines at once. */
const HELM: ItemTemplate = {
  entry: 1234,
  itemClass: 4,
  subClass: 4,
  name: 'Sturdy Helm',
  displayInfoId: 1,
  quality: 2,
  flags: 0,
  buyPrice: 0,
  sellPrice: 305,
  inventoryType: 1,
  itemLevel: 25,
  requiredLevel: 20,
  stackable: 1,
  containerSlots: 0,
  bonding: 2,
  description: 'Dented, but yours.',
  maxDurability: 60,
  startQuest: 0,
  damage: [],
  armor: 143,
  resistances: [0, 0, 0, 0, 0, 0],
  delay: 0,
  block: 0,
  stats: [{ type: 7, value: 12 }, { type: 13, value: 8 }],
  spells: [],
};

describe('itemTooltipLines', () => {
  it('builds the body in order, from the client own strings, with the unmet level in red', () => {
    const lines = itemTooltipLines(vm, HELM, { playerLevel: 15 });

    expect(lines.map((line) => line.left)).toEqual([
      'Item Level 25',
      'Binds when equipped',
      'Head',
      '143 Armor',
      '+12 Stamina',
      'Increases your dodge rating by 8.',
      ' ',
      'Requires Level 20',
      'Durability 60 / 60',
      '"Dented, but yours."',
      // NO SELL-PRICE LINE, and its absence is the assertion: the price is a money FRAME the client
      // builds from `OnTooltipAddMoney` (`methods/gametooltip.ts#fillFromSource`), not text this
      // builder pastes. It used to read "Sell Price: 3 Silver 5 Copper" in the wrong font, with the
      // word "Copper" where the real client draws a coin.
    ]);

    // A primary stat is white and a rating sentence green -- the `%c` split. And the requirement is RED
    // because level 15 cannot equip a level-20 item.
    expect(lines[4].colour).toEqual([1.0, 1.0, 1.0]);
    expect(lines[5].colour).toEqual([0.1, 1.0, 0.1]);
    expect(lines[7].colour).toEqual([1.0, 0.1, 0.1]);
  });

  it('leaves a met requirement white, and an unknown level is not a failed requirement', () => {
    const met = itemTooltipLines(vm, HELM, { playerLevel: 40 });
    const unknown = itemTooltipLines(vm, HELM, { playerLevel: 0 });

    const requirement = (lines: ReturnType<typeof itemTooltipLines>) =>
      lines.find((line) => line.left === 'Requires Level 20');

    expect(requirement(met)?.colour).toEqual([1.0, 1.0, 1.0]);
    expect(requirement(unknown)?.colour).toEqual([1.0, 1.0, 1.0]);
  });
});
