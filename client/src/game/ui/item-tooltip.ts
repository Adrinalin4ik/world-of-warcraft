/**
 * AN ITEM TOOLTIP'S BODY -- the lines under the name.
 *
 * The owner's report was precise and it is what scoped this file: "Описание предметов должно
 * показываться не по щелчку, а на hover и это уже работает, показывается название предмета, но нет его
 * описания." The hover fires, the tooltip appears, the NAME renders -- everything below it was missing.
 * Both the bag and the loot window were affected, because both bridges had their own two-line body;
 * one shared builder is why this is a module and not a third copy.
 *
 * ## In 3.3.5a an item tooltip is built ENGINE-SIDE, which is why this is TypeScript
 *
 * Nothing in the 264 loaded FrameXML files composes these lines. `ContainerFrameItemButton_OnEnter`
 * (`containerframe.lua:774`) and `LootItem_OnEnter` (`lootframe.lua:243`) each call `SetOwner` and then
 * one `GameTooltip:Set<Thing>Item`, and that setter is the engine's. So this is engine work by the
 * project's own rule, not a hand-built frame.
 *
 * ## EVERY STRING IS THE CLIENT'S OWN, read out of the live VM
 *
 * Not one label here is written in English by us. `ITEM_LEVEL`, `ITEM_BIND_ON_EQUIP`, `ARMOR_TEMPLATE`,
 * `DAMAGE_TEMPLATE`, `DPS_TEMPLATE`, `SPEED`, `DURABILITY_TEMPLATE`, `ITEM_MIN_LEVEL`, `SELL_PRICE`,
 * `ITEM_MOD_*`, `ITEM_RESIST_SINGLE`, `INVTYPE_*`, `ITEM_SPELL_TRIGGER_*`, `ITEM_STARTS_QUEST`,
 * `RESISTANCE<n>_NAME` and `SPELL_SCHOOL<n>_CAP` are all `GlobalStrings.lua` entries, already loaded
 * into the VM by the manifest, and they are formatted by the VM's own `string.format`. So a localised
 * build's tooltip localises itself, and no format specifier is reimplemented here.
 *
 * `formatGlobal` splices only NUMBERS and GLOBAL NAMES into the chunk it runs -- never text from the
 * wire. `vm.ts:133` warns about exactly that: an apostrophe in spliced text stops the chunk parsing.
 * The item's own name and description are passed through untouched and never enter a chunk.
 *
 * ## The one thing that is transcribed, and the check on it
 *
 * `ITEM_MOD_KEYS` maps a wire stat id to its `ITEM_MOD_*` key. The NUMBERING is transcribed from a
 * server implementation (TrinityCore 3.3.5's `ItemModType`), labelled here the way
 * `SMSG_LOOT_RESPONSE`'s layout is labelled in the loot decoder. **The check is that the two sets
 * coincide exactly**: the enum has 45 populated values (0, 1, 3-7 and 12-48) and `GlobalStrings.lua`
 * ships exactly 45 non-`_SHORT` `ITEM_MOD_*` keys, one per name, with no key left over and no id
 * unmapped. A wrong id would therefore have to be a PERMUTATION of the right ones, not an invention.
 *
 * ## WHAT IS NOT SOURCED, said plainly
 *
 * **The ORDER of the lines is not in any file this project has.** It is the engine's, and the engine is
 * a 2010 binary. The order below is transcribed from the real client's appearance and is OURS in the
 * sense that nothing here can prove it: item level, binding, slot, damage/speed, dps, armour, block,
 * stats, resistances, blank, required level, durability, effects, flavour text, sell price. If the
 * owner says a line sits in the wrong place, the file is right and this comment is wrong.
 *
 * **The blank separator is the least certain part of it.** The real client puts blank lines around
 * groups; exactly which groups, and whether a blank collapses when its neighbours are empty, is not
 * established. Exactly one is emitted here, and only when there is something on both sides of it.
 *
 * ## Declared gaps
 *
 * - **The right column of the slot line** -- the armour type or weapon type ("Mail", "Sword"). It is
 *   `itemClass`/`subClass` through `ItemSubClass.dbc`, which IS served (22,190 B) and has no reader in
 *   `pipeline/dbc/`. Named rather than transcribed: a hard-coded subclass table is twenty lines of
 *   invented English when a real table is one fetch away.
 * - **A spell effect's TEXT.** `Use:`/`Equip:`/`Chance on hit:` are labelled and the spell's own name
 *   is shown where the caller can supply it, but the description is not rendered: it needs the
 *   `$`-variable expansion `pipeline/dbc/spell-description.ts` does and a caster to evaluate against,
 *   and an item tooltip has no unit. The label plus the name is honest and incomplete; an invented
 *   effect sentence would not be.
 * - **`Unique` / `Unique-Equipped`.** `ITEM_UNIQUE`/`ITEM_UNIQUE_EQUIPPABLE` exist, but which `flags`
 *   bit means which is not established from anything this project has, and a wrong bit prints "Unique"
 *   on an ordinary item. Left out rather than guessed.
 * - **The real DURABILITY -- CLOSED, and this entry is kept to record that it was open.** The line read
 *   `max / max` because the builder saw only the template; `ItemTooltipContext.durability` is how the
 *   caller passes the instance's own `ITEM_FIELD_DURABILITY`, which the bag seam now does. A loot row
 *   and a vendor row still show `max / max` and that is correct for them: they are describing a
 *   template, not an object.
 */
import { LuaVM } from './framexml/lua/vm';
import type { ItemTemplate } from '../../network/game/object/items';

/** One tooltip line, in the shape `GameTooltip`'s `appendLine` already takes. */
export interface ItemTooltipLine {
  left: string;
  /** The right column, anchored by its right edge. Absent for an ordinary single-column line. */
  right?: string;
  /** 0..1 rgb. Absent means white. */
  colour?: readonly [number, number, number];
  /** Wrapped to the tooltip's width. Only long prose wants this. */
  wrap?: boolean;
}

/**
 * The four tooltip colours, from `constants.lua:20-23` -- the client's own values, not a palette.
 *
 * `NORMAL_FONT_COLOR` is the gold a description is drawn in, `GREEN_FONT_COLOR` the green of an effect
 * line, `RED_FONT_COLOR` the red of a requirement the player does not meet, and white is
 * `HIGHLIGHT_FONT_COLOR`. Constants here rather than reads of the live globals because a read per line
 * would be a `runExpr` per line for a value the client never changes at runtime.
 */
const WHITE = [1.0, 1.0, 1.0] as const; // HIGHLIGHT_FONT_COLOR, constants.lua:21
const RED = [1.0, 0.1, 0.1] as const; // RED_FONT_COLOR, constants.lua:22
const GREEN = [0.1, 1.0, 0.1] as const; // GREEN_FONT_COLOR, constants.lua:23
const GOLD = [1.0, 0.82, 0.0] as const; // NORMAL_FONT_COLOR, constants.lua:20

/**
 * Wire stat id -> `GlobalStrings.lua` key. See the header for the source and the coincidence check.
 *
 * The gaps are real gaps in the enum (2, and 8-11), not omissions.
 */
const ITEM_MOD_KEYS: Record<number, string> = {
  0: 'ITEM_MOD_MANA',
  1: 'ITEM_MOD_HEALTH',
  3: 'ITEM_MOD_AGILITY',
  4: 'ITEM_MOD_STRENGTH',
  5: 'ITEM_MOD_INTELLECT',
  6: 'ITEM_MOD_SPIRIT',
  7: 'ITEM_MOD_STAMINA',
  12: 'ITEM_MOD_DEFENSE_SKILL_RATING',
  13: 'ITEM_MOD_DODGE_RATING',
  14: 'ITEM_MOD_PARRY_RATING',
  15: 'ITEM_MOD_BLOCK_RATING',
  16: 'ITEM_MOD_HIT_MELEE_RATING',
  17: 'ITEM_MOD_HIT_RANGED_RATING',
  18: 'ITEM_MOD_HIT_SPELL_RATING',
  19: 'ITEM_MOD_CRIT_MELEE_RATING',
  20: 'ITEM_MOD_CRIT_RANGED_RATING',
  21: 'ITEM_MOD_CRIT_SPELL_RATING',
  22: 'ITEM_MOD_HIT_TAKEN_MELEE_RATING',
  23: 'ITEM_MOD_HIT_TAKEN_RANGED_RATING',
  24: 'ITEM_MOD_HIT_TAKEN_SPELL_RATING',
  25: 'ITEM_MOD_CRIT_TAKEN_MELEE_RATING',
  26: 'ITEM_MOD_CRIT_TAKEN_RANGED_RATING',
  27: 'ITEM_MOD_CRIT_TAKEN_SPELL_RATING',
  28: 'ITEM_MOD_HASTE_MELEE_RATING',
  29: 'ITEM_MOD_HASTE_RANGED_RATING',
  30: 'ITEM_MOD_HASTE_SPELL_RATING',
  31: 'ITEM_MOD_HIT_RATING',
  32: 'ITEM_MOD_CRIT_RATING',
  33: 'ITEM_MOD_HIT_TAKEN_RATING',
  34: 'ITEM_MOD_CRIT_TAKEN_RATING',
  35: 'ITEM_MOD_RESILIENCE_RATING',
  36: 'ITEM_MOD_HASTE_RATING',
  37: 'ITEM_MOD_EXPERTISE_RATING',
  38: 'ITEM_MOD_ATTACK_POWER',
  39: 'ITEM_MOD_RANGED_ATTACK_POWER',
  40: 'ITEM_MOD_FERAL_ATTACK_POWER',
  41: 'ITEM_MOD_SPELL_HEALING_DONE',
  42: 'ITEM_MOD_SPELL_DAMAGE_DONE',
  43: 'ITEM_MOD_MANA_REGENERATION',
  44: 'ITEM_MOD_ARMOR_PENETRATION_RATING',
  45: 'ITEM_MOD_SPELL_POWER',
  46: 'ITEM_MOD_HEALTH_REGEN',
  47: 'ITEM_MOD_SPELL_PENETRATION',
  48: 'ITEM_MOD_BLOCK_VALUE',
};

/**
 * `inventoryType` -> the `INVTYPE_*` key naming the slot.
 *
 * Same provenance as `ITEM_MOD_KEYS` -- ids from a server implementation, names validated against the
 * 29 `INVTYPE_*` keys `GlobalStrings.lua` ships. Two ids map to no line on purpose: 0 (non-equippable,
 * which has no slot) and 18 (a bag, whose own container-size line already says so).
 */
const INVTYPE_KEYS: Record<number, string> = {
  1: 'INVTYPE_HEAD',
  2: 'INVTYPE_NECK',
  3: 'INVTYPE_SHOULDER',
  4: 'INVTYPE_BODY',
  5: 'INVTYPE_CHEST',
  6: 'INVTYPE_WAIST',
  7: 'INVTYPE_LEGS',
  8: 'INVTYPE_FEET',
  9: 'INVTYPE_WRIST',
  10: 'INVTYPE_HAND',
  11: 'INVTYPE_FINGER',
  12: 'INVTYPE_TRINKET',
  13: 'INVTYPE_WEAPON',
  14: 'INVTYPE_SHIELD',
  15: 'INVTYPE_RANGED',
  16: 'INVTYPE_CLOAK',
  17: 'INVTYPE_2HWEAPON',
  19: 'INVTYPE_TABARD',
  20: 'INVTYPE_ROBE',
  21: 'INVTYPE_WEAPONMAINHAND',
  22: 'INVTYPE_WEAPONOFFHAND',
  23: 'INVTYPE_HOLDABLE',
  24: 'INVTYPE_AMMO',
  25: 'INVTYPE_THROWN',
  26: 'INVTYPE_RANGEDRIGHT',
  27: 'INVTYPE_QUIVER',
  28: 'INVTYPE_RELIC',
};

/** `spellTrigger` -> its label key. 0 use, 1 on equip, 2 chance on hit; the rest have no label. */
const SPELL_TRIGGER_KEYS: Record<number, string> = {
  0: 'ITEM_SPELL_TRIGGER_ONUSE',
  1: 'ITEM_SPELL_TRIGGER_ONEQUIP',
  2: 'ITEM_SPELL_TRIGGER_ONPROC',
};

/** `bonding` -> its label key. 0 means no binding and gets no line. */
const BONDING_KEYS: Record<number, string> = {
  1: 'ITEM_BIND_ON_PICKUP',
  2: 'ITEM_BIND_ON_EQUIP',
  3: 'ITEM_BIND_ON_USE',
  4: 'ITEM_BIND_QUEST',
};

/** Anything this file is willing to splice into a Lua chunk: a bare identifier. */
const SAFE_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `string.format(<key>, ...args)` run in the VM, or null if the global is absent or the call fails.
 *
 * The VM's own `string.format` and the VM's own `GlobalStrings` -- see the header. `args` are numbers or
 * GLOBAL NAMES; a name is checked against `SAFE_TOKEN` first, so nothing from the wire can reach the
 * chunk even by accident.
 */
function formatGlobal(vm: LuaVM, key: string, args: Array<number | string> = []): string | null {
  if (!SAFE_TOKEN.test(key)) {
    return null;
  }
  const rendered = args.map((arg) => {
    if (typeof arg === 'number') {
      return Number.isFinite(arg) ? String(arg) : '0';
    }
    return SAFE_TOKEN.test(arg) ? arg : 'nil';
  });
  const answer = vm.runExpr(
    `if type(${key}) ~= "string" then return nil end `
    + `return string.format(${[key, ...rendered].join(', ')})`,
    'item-tooltip-format.lua',
  ) as { value?: unknown } | null;
  const value = answer === null ? null : (answer as { value?: unknown }).value;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A global string's raw value, unformatted. Null when absent. */
function globalString(vm: LuaVM, key: string): string | null {
  if (!SAFE_TOKEN.test(key)) {
    return null;
  }
  const answer = vm.runExpr(
    `if type(${key}) ~= "string" then return nil end return ${key}`,
    'item-tooltip-global.lua',
  ) as { value?: unknown } | null;
  const value = answer === null ? null : (answer as { value?: unknown }).value;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** What the caller knows beyond the template, for the lines that depend on it. */
export interface ItemTooltipContext {
  /** The player's level, so an unmet `Requires Level` can go red. 0 means "unknown -- do not judge". */
  playerLevel?: number;
  /** A spell id -> name lookup for the effect labels. Absent means the labels stand alone. */
  spellName?: (id: number) => string | null;
  /**
   * This INSTANCE's `ITEM_FIELD_DURABILITY`, so the line can read `current / max` instead of
   * `max / max`.
   *
   * The header used to list the real durability as a gap and end "the caller has the instance and
   * could pass it". It does now, from the bag and paperdoll seams, which are the two that have a guid.
   * Absent still means the template-only reading -- a loot row and a vendor row genuinely have no
   * instance, and for those `max / max` is the right answer rather than a fallback.
   */
  durability?: number;
}

/**
 * The body lines for one item template, in draw order.
 *
 * Never throws, and never emits a line it could not build from the client's own strings: a missing
 * global drops its line rather than substituting English.
 */
export function itemTooltipLines(
  vm: LuaVM,
  template: ItemTemplate,
  context: ItemTooltipContext = {},
): ItemTooltipLine[] {
  const lines: ItemTooltipLine[] = [];
  const push = (
    left: string | null,
    colour: readonly [number, number, number] = WHITE,
    right?: string,
    wrap = false,
  ): void => {
    if (left !== null && left !== '') {
      lines.push({ left, right, colour, wrap });
    }
  };

  // Item level, and only for something equippable: a reagent has an itemLevel and no line for it.
  if (template.itemLevel > 0 && INVTYPE_KEYS[template.inventoryType] !== undefined) {
    push(formatGlobal(vm, 'ITEM_LEVEL', [template.itemLevel]));
  }

  // Binding, then the quest marker. Both are plain labels with no arguments.
  push(globalString(vm, BONDING_KEYS[template.bonding] ?? ''));
  if (template.startQuest > 0) {
    push(globalString(vm, 'ITEM_STARTS_QUEST'));
  }

  // The slot. Its RIGHT column -- the armour or weapon type -- is the declared `ItemSubClass.dbc` gap.
  push(globalString(vm, INVTYPE_KEYS[template.inventoryType] ?? ''));

  // Damage and speed on one line, dps under it. `delay` is MILLISECONDS on the wire, and both the
  // `Speed` figure and the dps divisor are that over 1000.
  const swing = template.delay > 0 ? template.delay / 1000 : 0;
  const speedLabel = globalString(vm, 'SPEED');
  for (const block of template.damage) {
    const min = Math.floor(block.min);
    const max = Math.floor(block.max);
    // `DAMAGE_TEMPLATE_WITH_SCHOOL` for anything that is not physical (school 0) -- which is the split
    // the two global strings themselves imply by existing as a pair.
    const school = block.school > 0 ? globalString(vm, `SPELL_SCHOOL${block.school}_CAP`) : null;
    const damage = school === null
      ? formatGlobal(vm, 'DAMAGE_TEMPLATE', [min, max])
      : formatGlobal(vm, 'DAMAGE_TEMPLATE_WITH_SCHOOL', [min, max, `SPELL_SCHOOL${block.school}_CAP`]);
    const right = swing > 0 && speedLabel !== null ? `${speedLabel} ${swing.toFixed(2)}` : undefined;
    push(damage, WHITE, right);
  }
  if (swing > 0 && template.damage.length > 0) {
    const total = template.damage.reduce((sum, block) => sum + (block.min + block.max) / 2, 0);
    push(formatGlobal(vm, 'DPS_TEMPLATE', [Number((total / swing).toFixed(1))]));
  }

  // Armour, and a shield's block value.
  if (template.armor !== 0) {
    push(formatGlobal(vm, 'ARMOR_TEMPLATE', [template.armor]));
  }
  if (template.block > 0) {
    push(formatGlobal(vm, 'ITEM_MOD_BLOCK_VALUE', [template.block]));
  }

  // The stats, in WIRE order, deliberately not sorted: that order is the server's own and imposing one
  // would be an ordering nothing states.
  for (const stat of template.stats) {
    const [text, colour] = statLine(vm, stat.type, stat.value);
    push(text, colour);
  }

  // The six resistances, wire order: holy, fire, nature, frost, shadow, arcane. `RESISTANCE<n>_NAME` is
  // on the same scale shifted by one -- `RESISTANCE0_NAME` is "Armor" -- so index i is RESISTANCE(i+1).
  template.resistances.forEach((value, index) => {
    if (value !== 0) {
      push(formatGlobal(
        vm,
        'ITEM_RESIST_SINGLE',
        [value < 0 ? 45 : 43, Math.abs(value), `RESISTANCE${index + 1}_NAME`],
      ));
    }
  });

  // Where the blank separator goes if it goes anywhere. See the header: this is the least sourced thing
  // in the file, so it is emitted only when there is something above AND below it.
  const beforeRequirements = lines.length;

  // The requirement, RED when the player cannot meet it. An UNKNOWN level must not paint a met
  // requirement red, which is why 0 is treated as "do not judge" rather than as level zero.
  if (template.requiredLevel > 1) {
    const level = context.playerLevel ?? 0;
    const unmet = level > 0 && level < template.requiredLevel;
    push(formatGlobal(vm, 'ITEM_MIN_LEVEL', [template.requiredLevel]), unmet ? RED : WHITE);
  }
  // `current / max` where the caller had the instance, `max / max` where it genuinely has none -- a
  // loot row and a vendor row are looking at a template, not at an object. See `context.durability`.
  if (template.maxDurability > 0) {
    const current = context.durability ?? template.maxDurability;
    push(formatGlobal(vm, 'DURABILITY_TEMPLATE', [current, template.maxDurability]));
  }

  // The spell effects: the client's own label, then the spell's name where the caller has one. The
  // effect TEXT is a declared gap -- see the header.
  for (const spell of template.spells) {
    const label = globalString(vm, SPELL_TRIGGER_KEYS[spell.trigger] ?? '');
    if (label !== null) {
      const name = context.spellName?.(spell.id) ?? null;
      push(name === null ? label : `${label} ${name}`, GREEN, undefined, true);
    }
  }

  if (beforeRequirements > 0 && lines.length > beforeRequirements) {
    lines.splice(beforeRequirements, 0, { left: ' ', colour: WHITE });
  }

  // The flavour text, gold and quoted. The quotes are the real client's and are the only punctuation in
  // this file that does not come from a global string.
  if (template.description !== '') {
    push(`"${template.description}"`, GOLD, undefined, true);
  }

  // Sell price last. `SELL_PRICE` is the bare label ("Sell Price"), so the colon is ours; the money
  // words are the client's own three amount strings.
  if (template.sellPrice > 0) {
    const label = globalString(vm, 'SELL_PRICE');
    const money = moneyText(vm, template.sellPrice);
    if (label !== null && money !== null) {
      push(`${label}: ${money}`);
    }
  }

  return lines;
}

/**
 * One stat line, plus its colour.
 *
 * **`%c` decides the arity, and that rule is read off the strings rather than tabulated.** The primary
 * stats are `"%c%d Strength"` -- a sign character then a magnitude -- and the secondary ratings are
 * `"Increases your dodge rating by %d."`, a magnitude alone. Rather than record which key is which in a
 * table that would drift, this asks the format string whether it contains `%c`.
 *
 * The colours follow the same split: a primary stat is white and a rating sentence is green. That is
 * the real client's appearance and is stated here as transcribed, not sourced.
 */
function statLine(
  vm: LuaVM,
  type: number,
  value: number,
): [string | null, readonly [number, number, number]] {
  const key = ITEM_MOD_KEYS[type];
  if (key === undefined) {
    return [null, WHITE];
  }
  const format = globalString(vm, key);
  if (format === null) {
    return [null, WHITE];
  }
  if (format.includes('%c')) {
    // 43 is '+' and 45 is '-': Lua's `%c` takes a character CODE.
    return [formatGlobal(vm, key, [value < 0 ? 45 : 43, Math.abs(value)]), WHITE];
  }
  return [formatGlobal(vm, key, [value]), GREEN];
}

/**
 * A copper amount as the client's own words -- `GOLD_AMOUNT` / `SILVER_AMOUNT` / `COPPER_AMOUNT`.
 *
 * **Not `GetCoinTextureString`, deliberately.** That returns `|T...|t` texture escapes, and `|T` is a
 * declared gap in `ui/markup.ts` which is left VISIBLE rather than stripped -- so a coin string would
 * print its own markup into the tooltip. Words are the honest fallback and the strings are the game's.
 *
 * 10000 copper to the gold and 100 to the silver: this client's own `moneyframe.lua` arithmetic, which
 * divides by 10000 then by 100 in `MoneyFrame_Update`.
 *
 * **EXPORTED because the loot window needs the same string, and the owner's "when looting it shows gold
 * when it should show copper" was exactly what happened without it.** `ui/loot-bridge.ts` asked the VM
 * for `GetCoinTextureString(copper)` -- a global that exists in the real engine and is called by
 * NOTHING in the 268 loaded manifest files, so it was never registered here -- and fell back to
 * `String(copper)`. A five-copper pile therefore read as a bare "5" beside the gold coin icon. One
 * formatter, one place, so the loot row, the tooltip's sell price and anything later cannot drift.
 */
/**
 * An item HYPERLINK, coloured by the client's own `GetItemQualityColor`.
 *
 * SHARED because two bridges need the identical string and a second copy would drift: the merchant rows
 * answer it from `GetMerchantItemLink`, and a quest panel's item rows from `GetQuestItemLink`, which
 * `QuestProgressItem_OnClick` shift-clicks into chat. The colour escape comes from the client's own
 * global rather than from a table here, so a document that overrides `GetItemQualityColor` is obeyed.
 */
export function itemLink(vm: LuaVM, template: { entry: number; name: string; quality: number } | null):
string | null {
  if (template === null) {
    return null;
  }
  const colour = vm.runExpr(
    `local _,_,_,hex = GetItemQualityColor(${template.quality}) return hex`, 'item-link.lua',
  ) as { value?: unknown } | null;
  const hex = String(colour?.value ?? '|cffffffff');
  return `${hex}|Hitem:${template.entry}:0:0:0:0:0:0:0:0:0:0|h[${template.name}]|h|r`;
}

export function copperAsWords(vm: LuaVM, copper: number): string | null {
  return moneyText(vm, copper);
}

function moneyText(vm: LuaVM, copper: number): string | null {
  const gold = Math.floor(copper / 10000);
  const silver = Math.floor((copper % 10000) / 100);
  const rest = copper % 100;
  const parts: string[] = [];
  const add = (key: string, amount: number): void => {
    const text = formatGlobal(vm, key, [amount]);
    if (text !== null) {
      parts.push(text);
    }
  };
  if (gold > 0) {
    add('GOLD_AMOUNT', gold);
  }
  if (silver > 0) {
    add('SILVER_AMOUNT', silver);
  }
  // The copper part shows when it is non-zero, and also when nothing else did -- a 0-copper price never
  // reaches here (the caller guards on `sellPrice > 0`), so an empty result would mean a missing global.
  if (rest > 0 || parts.length === 0) {
    add('COPPER_AMOUNT', rest);
  }
  return parts.length === 0 ? null : parts.join(' ');
}
