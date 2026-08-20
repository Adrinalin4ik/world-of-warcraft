/**
 * THE SKILLS TAB -- `GetNumSkillLines` / `GetSkillLineInfo` and the header collapse state.
 *
 * The owner: "Reputation skills and pet tab are still don't work." This is the SKILLS third, and it was
 * the cheapest of the three because nothing new has to come off the wire: the 384 words are already in
 * our own character's descriptor (`update-object/player-skills.ts`) and `SkillLine.dbc`'s layout was
 * already measured for the spellbook's tabs (`pipeline/dbc/skill-data.ts`). Last round declared
 * `GetNumSkillLines` at 0 so the client would hide its own rows; this replaces that with the data.
 *
 * ## The list is FLAT, and it interleaves headers with skills
 *
 * `GetSkillLineInfo(index)` walks one list in which a category header and a skill row are both entries,
 * and `header` is the second return that tells them apart (`skillframe.lua:26`, `:55-70`). So the shape
 * this file builds is: for each displayable category in the game's own `sortIndex` order, one header
 * row, then -- if that header is expanded -- its skills. A category with no known skills is omitted
 * entirely, which is what the real client does and is why a level-4 warrior sees four headers and not
 * seven.
 *
 * ## `stepCost` AND `rankCost` MUST BE nil, NOT 0
 *
 * The sharpest thing in this file. `SkillFrame_SetStatusBar` branches on
 * `if ( stepCost ) then ... elseif ( rankCost or (numTempPoints > 0) ) then` (`skillframe.lua:120,144`)
 * and **0 is TRUTHY in Lua**. Returning 0 would send every single skill down the "this is a skill you
 * can learn" arm: every row would read `LEARN_SKILL_TEMPLATE` ("Learn Herbalism") with an empty rank,
 * and the whole tab would be wrong in a way that still rendered. This is the same trap `GetXPExhaustion`
 * documents for the rested-XP pool, and the third time this project has hit it.
 *
 * They are nil here for a real reason and not only to dodge the trap: both are TRAINING COSTS, which
 * live in `SkillCosts.dbc` keyed by `SkillLine.skillCostsID`, and that table is not joined. A known
 * skill has no cost to show anyway -- the costs arm is for a trainer's list.
 *
 * ## Cost
 *
 * `GetNumSkillLines` and `GetSkillLineInfo` read a list that is rebuilt only when the descriptor's skill
 * block changes or a header is toggled -- not per call, and `SkillFrame_UpdateSkills` calls
 * `GetSkillLineInfo` once per visible row plus once per skill for its collapse-all check. The rebuild is
 * a walk of at most 128 slots plus a sort of at most 7 categories. `SKILL_LINES_CHANGED` is fired only
 * when the rebuilt list differs, and `SkillFrame_OnEvent` returns immediately when the frame is not
 * shown -- so with the tab closed the whole cost is one event dispatch to one frame.
 */
import type World from '../world';
import { LuaVM } from './framexml/lua/vm';
import { notImplemented } from './framexml/lua/methods/region';
import { fireEvent } from './framexml/lua/events';
import { skillData } from '../pipeline/dbc/skill-data';
import type { SkillSlot } from '../../network/game/object/update-object/player-skills';

/** One row of the flat list the Skills tab walks. */
interface Row {
  header: boolean;
  name: string;
  /** For a header: the category id, so collapse state can be keyed on it. 0 for a skill row. */
  categoryId: number;
  /** For a skill row: the descriptor slot's values. Null for a header. */
  skill: SkillSlot | null;
}

export function attachSkillsBridge(vm: LuaVM, world: World): () => void {
  /**
   * Which category headers are COLLAPSED. Engine state -- nothing in the manifest stores it, and
   * `CollapseSkillHeader`/`ExpandSkillHeader` are the only writers (`skillframe.xml:70-76`).
   *
   * Collapsed rather than expanded is the set held because expanded is the default: a character logging
   * in sees every header open, which is the real client's behaviour.
   */
  const collapsed = new Set<number>();

  /** The selected row, for `GetSelectedSkill`/`SetSelectedSkill`. 0 is "nothing selected". */
  let selected = 0;

  let rows: Row[] = [];

  /**
   * Rebuild the flat list. Returns whether it changed, so the caller can skip a pointless event.
   *
   * Sorted WITHIN a category by descending rank then name, which is OURS and is stated: nothing in
   * `SkillLine.dbc` orders the lines inside a category (its header records the same gap for the
   * spellbook's tabs), and the descriptor's slot order is the order the server happened to write them,
   * which is not stable across a relog. A stable, legible order is better than an arbitrary one; it is
   * not claimed to be the real client's.
   */
  const rebuild = (): boolean => {
    const byCategory = new Map<number, SkillSlot[]>();
    for (const slot of world.player.skills.values()) {
      const line = skillData.line(slot.id);
      if (line === null) {
        // The DBC has not landed, or the server sent a skill id this build's table does not have. Not
        // shown: the row's whole content is its name, and there is nothing honest to put there.
        continue;
      }
      const list = byCategory.get(line.categoryID);
      if (list === undefined) {
        byCategory.set(line.categoryID, [slot]);
      } else {
        list.push(slot);
      }
    }

    const next: Row[] = [];
    for (const category of skillData.displayCategories()) {
      const skills = byCategory.get(category.id);
      if (skills === undefined || skills.length === 0) {
        // A category the character has no skills in is not a header. The real client shows no empty
        // headers, and a level-4 warrior genuinely has no Professions.
        continue;
      }
      next.push({ header: true, name: category.name, categoryId: category.id, skill: null });
      if (collapsed.has(category.id)) {
        continue;
      }
      skills.sort((a, b) => (b.value - a.value)
        || (skillData.line(a.id)?.name ?? '').localeCompare(skillData.line(b.id)?.name ?? ''));
      for (const skill of skills) {
        next.push({
          header: false,
          name: skillData.line(skill.id)?.name ?? '',
          categoryId: category.id,
          skill,
        });
      }
    }

    const same = next.length === rows.length
      && next.every((row, i) => row.name === rows[i].name
        && row.header === rows[i].header
        && row.skill?.value === rows[i].skill?.value
        && row.skill?.max === rows[i].skill?.max
        && row.skill?.tempBonus === rows[i].skill?.tempBonus
        && row.skill?.permBonus === rows[i].skill?.permBonus);
    rows = next;
    return !same;
  };

  const fn = (name: string, body: (args: unknown[]) => unknown[]): void => {
    vm.registerFunction(name, body);
  };

  fn('GetNumSkillLines', () => [rows.length]);

  /**
   * `GetSkillLineInfo(index)` -> `skillName, header, isExpanded, skillRank, numTempPoints,
   * skillModifier, skillMaxRank, isAbandonable, stepCost, rankCost, minLevel, skillCostType`.
   *
   * THIRTEEN returns. The row painter destructures twelve (`skillframe.lua:26`); the DETAIL pane takes
   * a thirteenth, `skillDescription` (`:192`), and prints it with
   * `SkillDetailDescriptionText:SetFormattedText(SKILL_DESCRIPTION, skillType, skillDescription)`
   * (`:261`).
   *
   * **THAT THIRTEENTH VALUE WAS MISSING, and it is the whole of "при выборе скила нету подписи снизу".**
   * The owner sent the real client's Skills tab: selecting a row reproduces it in the lower pane with a
   * paragraph beneath. Ours printed nothing -- so the pane was never an artifact to remove, it was
   * working with an empty body. `SkillLine.dbc` field 20 carries the text and the entity had always
   * decoded it; `skill-data.ts` was dropping it on the floor.
   *
   * An out-of-range index answers `""` for the name, which is what makes `SkillFrame_SetStatusBar` hide
   * its bar and return (`:68-73`) rather than raise on a nil.
   *
   * See the header on why `stepCost` and `rankCost` are nil rather than 0.
   *
   * **`isAbandonable` IS `nil`, NOT `0`, AND GETTING THAT WRONG IS THE OWNER'S "unlearn is offered for
   * skills that cannot be unlearned".** This comment used to end "`isAbandonable` is 0 for every row
   * ... a truthy value here would put an unlearn button on a skill this client cannot unlearn" -- the
   * intent was exactly right and the code did the opposite, because **`0` IS TRUTHY IN LUA.**
   * `SkillDetailFrame_SetStatusBar` is `if ( isAbandonable ) then statusBarUnlearnButton:Show()`
   * (`skillframe.lua:221-223`), so a `0` showed the button on EVERY row.
   *
   * That is the third time this project has hit this trap, and the second time in this file -- the same
   * round that wrote this line got `stepCost`/`rankCost` right two lines below it. An engine global that
   * means "no" must answer nil.
   *
   * Only a profession can be abandoned and `AbandonSkill` is a declared gap, so nil is also the honest
   * answer rather than a placeholder.
   */
  fn('GetSkillLineInfo', (args) => {
    const row = rows[Number(args[0]) - 1];
    if (row === undefined) {
      return [''];
    }
    if (row.header) {
      // Slot 8 is `isAbandonable` -- nil, not 0. A header is never abandonable either. Slot 13 is the
      // description: a CATEGORY has none, and the detail pane never asks about a header anyway (its own
      // guard hides the bar for a row it cannot rank).
      return [row.name, 1, collapsed.has(row.categoryId) ? nil() : 1, 0, 0, 0, 0, nil(),
        null, null, 0, 0, ''];
    }
    const skill = row.skill!;
    return [
      row.name,
      nil(),
      1,
      skill.value,
      skill.tempBonus,
      skill.permBonus,
      skill.max,
      // `isAbandonable` -- nil, NOT 0. See the note above: 0 is truthy in Lua and showed the unlearn
      // button on every skill.
      nil(),
      null,
      null,
      0,
      0,
      // THIRTEEN: `skillDescription`, from `SkillLine.dbc` field 20. Not every line has one -- a
      // spell-tab line often does not -- so `''` is a real answer, and it is what the client's own
      // `SKILL_DESCRIPTION` format string prints as an empty body rather than "nil".
      skillData.line(skill.id)?.description ?? '',
    ];
  });

  /**
   * Lua `false`/`nil` for the two boolean-ish returns.
   *
   * `null` rather than `false`, because the client tests them for TRUTH (`if ( header ) then`,
   * `if ( isExpanded )`) and both work -- but `header` is compared to nothing else, so nil is the value
   * the real engine answers and the one that cannot be confused with a 0.
   */
  function nil(): null {
    return null;
  }

  fn('GetSelectedSkill', () => [selected]);
  fn('SetSelectedSkill', (args) => {
    const index = Number(args[0]);
    selected = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
    return [];
  });

  /**
   * `CollapseSkillHeader(index)` / `ExpandSkillHeader(index)`.
   *
   * **Index -1 means ALL of them**, which is not a guess: `SkillFrameCollapseAllButton`'s own handler is
   * `if ( SkillFrameCollapseAllButton.isExpanded ) then CollapseSkillHeader(-1) else
   * ExpandSkillHeader(-1) end` (`skillframe.xml:70-76`). Without that arm the collapse-all button would
   * silently do nothing.
   *
   * Each fires `SKILL_LINES_CHANGED`, which `SkillFrame` registers (`skillframe.lua:14`) and answers
   * with `SkillFrame_Update` -- so the tab repaints through the client's own path rather than a second
   * one invented here.
   */
  const setCollapsed = (index: number, wantCollapsed: boolean): void => {
    if (index === -1) {
      collapsed.clear();
      if (wantCollapsed) {
        for (const category of skillData.displayCategories()) {
          collapsed.add(category.id);
        }
      }
    } else {
      const row = rows[index - 1];
      if (row === undefined || !row.header) {
        return;
      }
      if (wantCollapsed) {
        collapsed.add(row.categoryId);
      } else {
        collapsed.delete(row.categoryId);
      }
    }
    rebuild();
    fireEvent(vm, 'SKILL_LINES_CHANGED');
  };
  fn('CollapseSkillHeader', (args) => { setCollapsed(Number(args[0]), true); return []; });
  fn('ExpandSkillHeader', (args) => { setCollapsed(Number(args[0]), false); return []; });

  /**
   * `UnitCharacterPoints(unit)` -> `talentPoints, ...` -- and it is REAL now rather than declared.
   *
   * `player_character_points1`/`2` (`enums.ts:441-442`) are the two pools, and 3.3.5a's first is talent
   * points. `SkillFrame_UpdateSkills` destructures two (`skillframe.lua:436`), which is why both are
   * returned even though only the first has a meaning this client can name.
   */
  fn('UnitCharacterPoints', (args) => {
    if (String(args[0] ?? '').toLowerCase() !== 'player') {
      return [0, 0];
    }
    return [world.player.fields.talentPoints ?? 0, 0];
  });

  /**
   * A DECLARED GAP that has to keep its shape: `GetAdjustedSkillPoints` is `SkillFrame_UpdateSkills`'
   * SECOND line (`skillframe.lua:404`), so it has to answer something or the whole tab raises before its
   * row loop. It is the "skill points spent" figure a trainer's list needs and there is no feed for it.
   */
  const stub = notImplemented(
    'GetAdjustedSkillPoints',
    'no skill-point pool is decoded; the tab reads it only to pass to SkillDetailFrame_SetStatusBar',
    [0],
  );
  fn('GetAdjustedSkillPoints', () => stub(null as never, 0, []));

  /**
   * Rebuild and announce, on the same `unit:fields` edge `unit-bridge.ts` and `paperdoll-stats.ts`
   * already use. Only when the list actually differs -- a health tick must not repaint the tab.
   */
  const onFields = (unit: unknown): void => {
    if (unit !== world.player) {
      return;
    }
    if (rebuild()) {
      fireEvent(vm, 'SKILL_LINES_CHANGED');
    }
  };
  world.on('unit:fields', onFields);

  // The DBC is what turns a skill id into a name, so the first list that is worth anything is the one
  // built after it lands. `ensureLoaded` is idempotent and the spellbook already asks for it.
  void skillData.ensureLoaded().then(() => {
    if (rebuild()) {
      fireEvent(vm, 'SKILL_LINES_CHANGED');
    }
  });
  rebuild();

  return () => {
    world.removeListener('unit:fields', onFields);
  };
}
