/**
 * THE AURA TOOLTIP'S DOOR INTO `GameTooltip` -- the one thing `methods/gametooltip.ts` needs from the
 * aura feed and cannot reach on its own.
 *
 * `GameTooltip:SetUnitAura(unit, index, filter)` is a frame METHOD, so it is registered once for the
 * whole class by `registerMethods` and has no way to be handed a bridge. Every other filling method in
 * that file solves this the same way and this is a copy of it: a `WeakMap<LuaVM, source>` the owning
 * bridge writes on attach and the method reads at hover time (`api/items.ts:161-180`, and
 * `api/casting.ts:59-67` for the same shape holding plain state).
 *
 * WHY A WeakMap AND NOT A MODULE-LEVEL FIELD: there are two VMs in a session -- the glue runtime's and
 * the world runtime's -- and the world host can be double-mounted with one copy disposed
 * (`CLAUDE.md`). A module-level source would let a disposed mount's closure answer the live VM's
 * hovers, which is precisely the class of stale-handle defect that has voided four measurement arms
 * here.
 */
import { LuaVM } from '../vm';

/**
 * What one aura's tooltip needs, and no more: it is filled by `fillSpellLines`, the same three-line
 * body `SetSpell` and `SetAction` use, because an aura's tooltip in 3.3.5a IS a spell's tooltip plus a
 * time-remaining line the client itself does not ask the engine for.
 *
 * Null means "there is no aura at that index", which is what makes the method answer false and show
 * nothing -- the same contract every other setter in that family has.
 */
export type AuraTooltipSource = (
  unit: string,
  index: number,
  filter: string,
) => { name: string; rank: string; description: string } | null;

const auraTooltipSourceByVm = new WeakMap<LuaVM, AuraTooltipSource>();

export function setAuraTooltipSource(vm: LuaVM, source: AuraTooltipSource | null): void {
  if (source === null) {
    auraTooltipSourceByVm.delete(vm);
    return;
  }
  auraTooltipSourceByVm.set(vm, source);
}

export function getAuraTooltipSource(vm: LuaVM): AuraTooltipSource | null {
  return auraTooltipSourceByVm.get(vm) ?? null;
}

/**
 * `GameTooltip:SetShapeshift(index)`'s source -- the STANCE button's hover.
 *
 * A separate source rather than a filter on the one above because the argument means something else: a
 * stance-bar POSITION, not an aura index, and the two lists are unrelated. `ShapeshiftButtonTemplate`'s
 * `<OnEnter>` is the only call site in the manifest (`bonusactionbarframe.xml:34`) and it calls this
 * UNGUARDED, so a nil method raises inside the handler and takes the hover with it -- which is why this
 * exists at all rather than being left to the gap list.
 */
export type ShapeshiftTooltipSource = (
  index: number,
) => { name: string; rank: string; description: string } | null;

const shapeshiftTooltipSourceByVm = new WeakMap<LuaVM, ShapeshiftTooltipSource>();

export function setShapeshiftTooltipSource(vm: LuaVM, source: ShapeshiftTooltipSource | null): void {
  if (source === null) {
    shapeshiftTooltipSourceByVm.delete(vm);
    return;
  }
  shapeshiftTooltipSourceByVm.set(vm, source);
}

export function getShapeshiftTooltipSource(vm: LuaVM): ShapeshiftTooltipSource | null {
  return shapeshiftTooltipSourceByVm.get(vm) ?? null;
}
