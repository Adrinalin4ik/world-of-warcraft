/**
 * THE SPELL-DESCRIPTION EVALUATOR -- `Spell.dbc`'s `Description` is a small expression language, and
 * this turns it into the sentence the real client shows.
 *
 * The owner has reported three times that tooltips show formulas. They show formulas because a 3.3.5a
 * description is not prose: it is prose with substitution tokens, and the engine resolves them from the
 * spell's own effect columns, three small side tables, and the caster's live state.
 *
 * ## The work list is a CENSUS, not a guess
 *
 * Measured over the served `Spell.dbc` (49,839 records; `description` column 170,
 * `descriptionVariablesID` column 232): **31,748 spells carry a description and 22,600 of those carry
 * at least one `$` token.** By family, most-used first, with what this file does about each:
 *
 *     $s<n>  effect value            15137  DONE   $<name> description variable  280  DONE
 *     $d     duration                 8076  DONE   $x<n>   chain targets         249  DONE
 *     $<id><tok> cross-spell          4595  DONE   $AP     attack power          240  DONE
 *     $t<n>  tick period              1589  DONE   $n      stacks                123  DONE
 *     ${...} arithmetic               1094  DONE   $g/$G   male:female;          104  DONE
 *     $a<n>  radius                    747  DONE   $d<n>   effect duration        84  DONE
 *     $m/$M  min/max base points       718  DONE   $RAP    ranged attack power    83  DONE
 *     $o<n>  total over time           706  DONE   $e      (meaning unknown)      77  DECLARED
 *     $/N    divisor                   385  DONE   $u      max targets            74  DONE
 *     $h     proc chance               344  DONE   $SP     spell power            58  DONE
 *     $l/$L  singular:plural;          330  DONE   $b<n>   per level / combo pt   58  DONE
 *                                                  $?      conditional            54  PART
 *                                                  $MWS    weapon speed           14  DONE
 *                                                  $PL     player level            6  DONE
 *
 * **DECLARED, not silently dropped.** An unresolved token is left in the text exactly as authored and
 * recorded in `spellDescriptionGaps` (`window.spellDescriptionGaps`), which is the same standard the
 * `notImplemented` factory holds for a missing Lua global: a visible `$e` says "unfinished", where a
 * blank or a substituted number would read as truth. `notImplemented` itself is not used because it
 * manufactures a Lua *method*; there is no method here to register.
 *
 * Measured over the whole served table with the evaluator running live (probe
 * `scratchpad/t18-tip.js`, `t18c-sweep.js`): of the **22,602** described spells carrying a token,
 * **21,760 render with no `$` left** (96.3%) and **842** do not, with **ZERO exceptions thrown**. The
 * counts here are the FINAL run's -- an earlier draft of this comment carried 21,910/692 from a
 * mid-round measurement, which is the sort of stale number this project treats as a defect. What the
 * 842 are, each with the measurement behind the refusal:
 *
 *  - **`$?(s56810|s25306|!((!a48165)|a66109))[..]?!a66109[..] [..]`** -- the conditional's full BOOLEAN
 *    form: parentheses, `|`, `!`, and a trailing bare `[else]`. The simple `$?s<id>[a][b]` /
 *    `$?a<id>[a][b]` arm IS implemented and is what both of the owner's examples need; the boolean
 *    grammar is not, and it is written down here because `Spell.dbc` **66109 "Ron's Test Buff 4"**
 *    documents it verbatim (see the legend note below).
 *  - **`$?a<id>`** -- the AURA leg. This client decodes no aura feed, so "does the caster have aura N"
 *    is unanswerable and NEITHER branch may be chosen.
 *  - **`$o<n>`/`$t<n>` where `EffectAmplitude` is 0** (93 + 47). Not a gap in the reader: measured, 433
 *    Food and 23256 Deep Wounds carry `amplitude [0,0,0]`, so the row states no tick period and the
 *    total-over-time has no factor. Fireball's `$o2` resolves because its amplitude IS 2000.
 *  - **`$r<n>`** (43) -- see `tokenValue`'s `r` case; `$r` with no index IS implemented.
 *  - **`$e`** (48), **`$q<n>`** (30, and 2006 Resurrection's effect 2 is measured all-zero so the mana
 *    it names is not on the row), **`$z`, `$v`, `$f`, `$bc2`** -- no served file states what these mean.
 *  - **`$mw`/`$MW` (100 uses, the largest remaining), `$mwb`/`$MWB` (44), `$rwb`/`$RWB` (60)** --
 *    WEAPON DAMAGE. `UNIT_FIELD_MINDAMAGE`/`MAXDAMAGE`/`MINOFFHANDDAMAGE`/`MINRANGEDDAMAGE` are all in
 *    `enums.ts` already and none is decoded, so this is four fields and a naming decision (`$mw` vs
 *    `$mwb`), not new research. The obvious next piece of work.
 *  - **`$pa`/`$pfi`/`$pfr`/`$ph`/`$pn`/`$ps`/`$pbh`/`$pbhd`** -- the PERCENT modifier family
 *    (`PLAYER_FIELD_MOD_DAMAGE_DONE_PCT`), 6 uses, all in one developer test spell.
 *  - **`${...}` containing a FUNCTION CALL** -- `$gt`, `$gte`, `$eq`, `$max`, `$cond`, `$FLOOR`, `$CO`.
 *    A call grammar for a handful of rows, and inventing the semantics is the defect the rules name.
 *  - **`$AR`** (armour, one row).
 *
 * ## THE CLIENT SHIPS ITS OWN LEGEND, and it is a better oracle than the census
 *
 * Two developer test spells in the served `Spell.dbc` describe the language in prose beside its own
 * tokens. They are cited by id and column so the next round does not have to re-derive any of this:
 *
 *  - **48165 "Ron's Test Buff 3"**, column 170 -- names the whole spell-power family: `${$sp}` generic,
 *    `${$spa}` arcane, `${$spfi}` fire, `${$spfr}` frost, `${$sph}` holy, `${$spn}` nature, `${$sps}`
 *    shadow, `${$bh}` healing, then the `$p*` percent family. See `SPELL_POWER_SCHOOL`.
 *  - **66109 "Ron's Test Buff 4"**, column 170 -- the conditional's boolean grammar, `$ghe:she;`,
 *    `$lfunny:funnies;`, a cross-spell `$48165s3`, and `$<funny>`/`$<maybe>`/`$<storm>` against
 *    `SpellDescriptionVariables` row 1. It is the specification for the `$?` work that is left.
 *
 * ## What each numeric token is, and what was actually checked
 *
 * `effectRange` in `spell-data.ts` carries the min/max identity and the two-spell verification behind
 * it; everything here is a read of one column or arithmetic over those. The two verified sentences,
 * which are the owner's own examples and the gate for this round:
 *
 *     1752 Sinister Strike r1
 *       "An instant strike that causes $m1 damage in addition to $<percent>% of your normal weapon
 *        damage.  Awards $s2 combo $lpoint:points;."
 *       $m1 -> effect 1 basePoints 2 + 1 = 3;  $s2 -> effect 2 basePoints 0 + dieSides 1 = 1;
 *       $<percent> -> SpellDescriptionVariables row 171, a talent ladder whose base rung is 100;
 *       $lpoint:points; -> 1 is singular -> "point".
 *       => "An instant strike that causes 3 damage in addition to 100% of your normal weapon damage.
 *           Awards 1 combo point."
 *     2098 Eviscerate r1, first line
 *       "1 point: ${$m1+(($b1*1)+$AP*0.03)*$<mult>}-${$M1+(($b1*1)+$AP*0.07)*$<mult>} damage"
 *       $m1 = 1, $M1 = 5, $b1 = EffectPointsPerComboPoint 5.0,
 *       $<mult> -> row 169, talent ladder, base rung 1.0
 *       => at 0 attack power, "1 point: 6-10 damage".
 *
 * ## `$s<n>` PRINTS A RANGE, and the format string is the client's own
 *
 * 317 of the 1,397 descriptions in the first 4,487 records that use `$s1` without `$m1`/`$M1` sit on an
 * effect with `dieSides > 1` (Fireball 13/9, Healing Wave 33/11, Lightning Bolt 12/3), so a single
 * number cannot be what the engine prints for them. **The format is
 * `INT_SPELL_POINTS_SPREAD_TEMPLATE = "%d to %d"` (`globalstrings.lua:4292`)** -- an engine string, not
 * a FrameXML one, whose name is literally the spread of an integer spell's points. Duration is the
 * same family: `INT_SPELL_DURATION_SEC = "%d sec"` / `_MIN = "%d min"` / `_HOURS` / `_DAYS`
 * (`globalstrings.lua:4288-4291`), with `SPELL_DURATION_SEC = "%.2f sec"` (`:6936`) for a duration that
 * is not a whole number of seconds. Nothing here is chosen -- see `renderTokenValue`.
 *
 * Three canonical values reproduce exactly off the served file at level 2, which is the strongest check
 * this file has and none of them was used to fit anything: **Fireball rank 1 "14 to 22 Fire damage"**,
 * **Lightning Bolt rank 1 "13 to 15 Nature damage"**, **Healing Wave rank 1 "34 to 44"**.
 *
 * ## ONE choice that is not sourced, labelled rather than buried
 *
 * **`${...}` truncates toward zero** unless the expression carries an explicit `.N` precision suffix.
 * Both verified sentences above come out exact either way, so nothing distinguishes truncation from
 * rounding here, and an attack-power term can differ by 1 between them: live at 24 attack power,
 * Eviscerate's five-combo-point maximum is `5 + (25 + 24*0.35) * 1.0 = 38.4`, printed **38** by
 * truncation and 38 by rounding, but its one-point maximum is `11.68` -- **11** truncated, 12 rounded.
 */
import { SpellRow, effectRange, spellData } from './spell-data';

/**
 * The caster's live state a description needs. Everything on it is decoded off the wire -- see
 * `network/game/object/update-object/unit-fields.ts` for each field's update-field index and for the
 * client's own `PaperDollFrame` evidence about how the attack-power triple combines.
 */
export interface CasterStats {
  /** `$PL`. */
  level: number;
  /** `$AP` -- already combined, see `unit-fields.ts`. */
  attackPower: number;
  /** `$RAP`. */
  rangedAttackPower: number;
  /** `$sp`/`$sph`/... -- `GetSpellBonusDamage(school)` per school, indexed by school 0..6. */
  spellDamage: number[];
  /** `$bh` -- `GetSpellBonusHealing()`. NaN when the field has not arrived. */
  bonusHealing: number;
  /** `$MWS` -- main-hand weapon speed in SECONDS (the wire carries milliseconds). */
  mainHandSpeedSec: number;
  /** `$g`/`$G`: 0 male, 1 female. From `UNIT_FIELD_BYTES_0`'s gender byte. */
  female: boolean;
  /** `$?s<id>` -- whether the player knows a spell, from `SMSG_INITIAL_SPELLS`. */
  knowsSpell(spellId: number): boolean;
}

/** A caster whose state has not arrived. Every stat token stays a TOKEN rather than resolving to 0. */
export function unknownCaster(): CasterStats {
  return {
    level: 0,
    attackPower: Number.NaN,
    rangedAttackPower: Number.NaN,
    spellDamage: [],
    bonusHealing: Number.NaN,
    mainHandSpeedSec: Number.NaN,
    female: false,
    knowsSpell: () => false,
  };
}

/**
 * Every token form this evaluator met and could not resolve, counted. `window.spellDescriptionGaps`.
 *
 * This is the declaration channel -- see the header. It is a census and not a log: one entry per token
 * FORM (`$e`, `$?a`, ...) with a count and one example spell, so a glance says what is missing and how
 * much of the corpus it costs, which is what picked this round's work list in the first place.
 */
export const spellDescriptionGaps: {
  forms: Map<string, { count: number; reason: string; exampleSpellId: number }>;
} = { forms: new Map() };

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).spellDescriptionGaps = spellDescriptionGaps;
}

function declareGap(form: string, reason: string, spellId: number): void {
  const existing = spellDescriptionGaps.forms.get(form);
  if (existing) {
    existing.count += 1;
    return;
  }
  spellDescriptionGaps.forms.set(form, { count: 1, reason, exampleSpellId: spellId });
  console.warn(`spell description: '${form}' not implemented -- ${reason} (e.g. spell ${spellId})`);
}

/**
 * A number as the client prints it: no trailing `.0`, and a fraction kept only when one survives.
 *
 * `$a1` is a float column (radius 8.0 -> "8") and `$MWS` genuinely is fractional (2.6), so neither
 * blanket rounding nor blanket `toFixed` is right. Three decimals is the cut, which is finer than any
 * value in the tables and coarse enough that binary float noise (`0.1+0.2`) never reaches the screen.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return 'NaN';
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return String(Math.round(value * 1000) / 1000);
}

/**
 * THE PER-SCHOOL SPELL-POWER TOKENS, and the client's own data is what NAMES them.
 *
 * `Spell.dbc` id **48165 "Ron's Test Buff 3"** is a developer test spell whose description (column 170)
 * is a LEGEND for this language -- it enumerates the tokens beside the words for what each one is:
 *
 *     "Test of spell power: ${$sp} arcane: ${$spa} fire: ${$spfi} frost: ${$spfr} holy: ${$sph}
 *      nature: ${$spn} shadow: ${$sps} healing: ${$bh}.
 *      Test of %arcane: ${$pa}.2 %fire: ${$pfi}.2 %frost: ${$pfr}.2 %holy: ${$ph}.2
 *      %nature: ${$pn}.2 %shadow: ${$ps}.2 %heal: ${$pbh}.2 %heal done: ${$pbhd}.2 bc2: ${$bc2}.4"
 *
 * That is a served file naming its own token set, which is a better oracle than any census: it is why
 * `$sph` is holy and not "spell power, high", and it is why the `$p*` family below is declared as
 * PERCENT modifiers rather than guessed at.
 *
 * The school INDEX each maps to is `PLAYER_FIELD_MOD_DAMAGE_DONE_POS`' own word order -- 0 physical,
 * 1 holy, 2 fire, 3 nature, 4 frost, 5 shadow, 6 arcane -- corroborated by the character sheet, whose
 * loop starts at `holySchool = 2`, a 1-based Lua index into the same seven, i.e. holy, skipping
 * physical (`paperdollframe.lua:917-919`).
 *
 * `$sp` with no school suffix takes the SPELL'S OWN school (`schoolOf`), which is what a spell
 * describing its own damage means by it.
 */
const SPELL_POWER_SCHOOL: Record<string, number> = {
  SPH: 1, SPFI: 2, SPN: 3, SPFR: 4, SPS: 5, SPA: 6,
};

/**
 * Every MULTI-LETTER token, i.e. the ones that are a stat and not a per-effect column.
 *
 * Matched against the WHOLE token body, which is the grammar's only disambiguation: `$sp`/`$SP` and
 * `$s1` share their first letter, and so do `$pl`/`$PL` and a hypothetical `$p1`.
 */
const STAT_TOKENS = new Set<string>([
  'AP', 'RAP', 'PL', 'MWS', 'SP', 'BH', ...Object.keys(SPELL_POWER_SCHOOL),
]);

/**
 * `$d`'s value in SECONDS -> the string, using the client's own four duration formats.
 *
 * `INT_SPELL_DURATION_SEC = "%d sec"`, `_MIN = "%d min"`, `_HOURS = "%d |4hour:hrs;"`,
 * `_DAYS = "%d |4day:days;"` (`globalstrings.lua:4288-4291`), with `SPELL_DURATION_SEC = "%.2f sec"`
 * (`:6936`) for a duration that is not whole seconds. `|4singular:plural;` is the globalstring plural
 * escape and is expanded here by reading the two forms out of the format literally.
 *
 * **WHICH UNIT IS OURS.** `globalstrings.lua` supplies the four formats and states no rule for choosing
 * between them, so the ladder below -- seconds under a minute, whole minutes under an hour, whole hours
 * under a day, else days -- is this client's. A 90-second duration prints "90 sec" here where the real
 * client may print "1.5 min". Stated, not hidden.
 *
 * The ladder is not cosmetic: 13 of `SpellDuration.dbc`'s 130 rows carry a `baseDuration` far above
 * their own `maxDuration` (row 2 is 300,000,010 ms against a max of 30,000), and without the hours and
 * days rungs those print as six-digit second counts.
 */
function formatDuration(seconds: number): string {
  if (seconds < 0) {
    // -1 is the engine's "no natural end" -- `SpellDuration.dbc` row 21 -- and this is the client's own
    // string for it (`globalstrings.lua:6937`). Printing the raw number would give "-1 sec", and
    // reading the column unsigned (which it was) gave "4294967.295 sec".
    return 'until cancelled';
  }
  if (seconds >= 86400 && seconds % 86400 === 0) {
    const days = seconds / 86400;
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? 'hour' : 'hrs'}`;
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    return `${seconds / 60} min`;
  }
  if (Number.isInteger(seconds)) {
    return `${seconds} sec`;
  }
  // Neither whole seconds nor a whole larger unit. Two decimals is `SPELL_DURATION_SEC`'s own `%.2f`.
  return `${seconds.toFixed(2)} sec`;
}

/** The lowest school bit set in `Spell.dbc`'s `SchoolMask`; `$sp` reads that school's bonus. */
function schoolOf(row: SpellRow): number {
  for (let school = 0; school < 7; school += 1) {
    if ((row.schoolMask & (1 << school)) !== 0) {
      return school;
    }
  }
  return 0;
}

/**
 * One render's working state. A description can reach other spells' rows (`$66109m2`) and its own
 * variables block, and a variables block can reach itself (`$mult2` reads `$<mult1>`), so the
 * resolution is recursive and needs a cycle guard and a memo.
 */
class Renderer {
  /** Rows already resolved, so a cross-spell token does not re-hit the map per occurrence. */
  private readonly variables = new Map<string, string | null>();

  /** Names currently being evaluated -- a self-referential row would otherwise recurse for ever. */
  private readonly resolving = new Set<string>();

  /**
   * The last NUMBER emitted into the output, which is what `$l`/`$L` pluralise on.
   *
   * The selector carries no operand of its own -- `Awards $s2 combo $lpoint:points;` -- so the
   * antecedent has to come from the text already written. That is what the construction means and it
   * is why this is state rather than an argument.
   */
  private lastNumber: number | null = null;

  constructor(
    private readonly row: SpellRow,
    private readonly stats: CasterStats,
  ) {}

  render(): string {
    return this.expand(this.row.description);
  }

  /** Expand every `$` construction in `text`, leaving whatever cannot be resolved exactly as authored. */
  expand(text: string): string {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const dollar = text.indexOf('$', i);
      if (dollar < 0) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, dollar);
      const parsed = this.parseAt(text, dollar);
      if (parsed === null) {
        // Not a construction we know. The `$` and the character after it go through untouched, which
        // is what leaves an unimplemented token VISIBLE.
        out += text[dollar];
        i = dollar + 1;
      } else {
        out += parsed.text;
        i = parsed.next;
      }
    }
    return out;
  }

  /**
   * Parse the one construction starting at `text[at] === '$'`, or null when there is none.
   *
   * The order of the arms is the grammar's own ambiguity resolution: `$s1` and `$sp` differ only in
   * whether a digit or a letter follows, `$16191m1` starts with a digit where every other form starts
   * with a letter or a punctuator, and `$/1000;s1` prefixes a form that is otherwise complete.
   */
  private parseAt(text: string, at: number): { text: string; next: number } | null {
    const rest = text.slice(at);

    // ${ expression } with an optional `.N` precision suffix.
    let match = /^\$\{/.exec(rest);
    if (match) {
      const close = matchBrace(text, at + 1);
      if (close < 0) {
        return null;
      }
      const body = text.slice(at + 2, close);
      let next = close + 1;
      let precision: number | null = null;
      const suffix = /^\.(\d)/.exec(text.slice(next));
      if (suffix) {
        precision = Number(suffix[1]);
        next += suffix[0].length;
      }
      const value = this.evaluate(body);
      if (value === null) {
        return { text: text.slice(at, next), next };
      }
      // TRUNCATION, and it is the unsourced half of this file -- see the header. `.N` is the authored
      // escape hatch and is honoured exactly.
      const rendered = precision === null
        ? String(Math.trunc(value))
        : value.toFixed(precision);
      this.lastNumber = precision === null ? Math.trunc(value) : value;
      return { text: rendered, next };
    }

    // $?<predicate>[then][else] -- the conditional.
    match = /^\$\?([sa])(\d+)/.exec(rest);
    if (match) {
      let cursor = at + match[0].length;
      const then = readBracket(text, cursor);
      if (then === null) {
        return null;
      }
      cursor = then.next;
      // `$?s56810[${3}]$[${0}]` (variables row 164) puts a stray `$` before the else branch; a
      // conditional with only a `then` branch also occurs. Both are tolerated rather than refused.
      if (text[cursor] === '$') {
        cursor += 1;
      }
      const otherwise = readBracket(text, cursor);
      const elseText = otherwise === null ? '' : otherwise.body;
      const next = otherwise === null ? cursor : otherwise.next;

      if (match[1] === 'a') {
        // THE AURA LEG. No aura feed exists in this client, so neither branch can be chosen -- and
        // picking the else branch would be a guess that reads as truth. The whole construction stays.
        declareGap('$?a', 'no aura feed is decoded, so "does the caster have aura N" is unanswerable', this.row.id);
        return { text: text.slice(at, next), next };
      }
      const known = this.stats.knowsSpell(Number(match[2]));
      return { text: this.expand(known ? then.body : elseText), next };
    }

    // $<name> -- a description variable, resolved through this spell's own variables row.
    match = /^\$<(\w+)>/.exec(rest);
    if (match) {
      const value = this.variable(match[1]);
      const next = at + match[0].length;
      return value === null
        ? { text: text.slice(at, next), next }
        : { text: value, next };
    }

    // $/N;<token> -- divide the token that follows. `$/1000;s1` is milliseconds to seconds.
    match = /^\$\/(\d+(?:\.\d+)?);/.exec(rest);
    if (match) {
      const divisor = Number(match[1]);
      // The token after the `;` is authored WITHOUT its own `$` (`$/1000;s1`), so it is parsed by
      // putting one back and reading from index 0 of that synthetic string; `parsed.next - 1` maps the
      // result's length back onto the real text.
      const tail = `$${text.slice(at + match[0].length)}`;
      const parsedTail = this.parseAt(tail, 0);
      if (parsedTail === null || divisor === 0) {
        return null;
      }
      const next = at + match[0].length + (parsedTail.next - 1);
      const numeric = Number(parsedTail.text);
      if (!Number.isFinite(numeric)) {
        return { text: text.slice(at, next), next };
      }
      this.lastNumber = numeric / divisor;
      return { text: formatNumber(numeric / divisor), next };
    }

    // $<spellid><token> -- the same tokens, read off ANOTHER spell's row.
    match = /^\$(\d+)([a-zA-Z]+\d*)/.exec(rest);
    if (match) {
      const other = spellData.spell(Number(match[1]));
      const next = at + match[0].length;
      if (other === null) {
        // The row is not loaded, or the player's client never sees that spell. Leaving the token is
        // the honest answer; substituting this spell's own effect would be a different spell's number.
        return { text: text.slice(at, next), next };
      }
      const value = new Renderer(other, this.stats).simpleToken(match[2]);
      return value === null
        ? { text: text.slice(at, next), next }
        : { text: value, next };
    }

    // $l<singular>:<plural>; and $g<male>:<female>; -- the two string selectors.
    match = /^\$([lLgG])([^:;]*):([^;]*);/.exec(rest);
    if (match) {
      const next = at + match[0].length;
      const isPlural = match[1] === 'l' || match[1] === 'L';
      const picked = isPlural
        ? (this.lastNumber === 1 ? match[2] : match[3])
        : (this.stats.female ? match[3] : match[2]);
      return { text: picked, next };
    }

    // Everything else is a plain token: a stat name, or a letter with an optional effect index.
    match = /^\$([A-Za-z]+\d*)/.exec(rest);
    if (match) {
      const next = at + match[0].length;
      const value = this.simpleToken(match[1]);
      return value === null
        ? { text: text.slice(at, next), next }
        : { text: value, next };
    }

    return null;
  }

  /**
   * One token body ("s1", "AP", "d", "MWS") to its rendered text, or null when it cannot be resolved.
   *
   * PUBLIC-ish because the cross-spell form builds a second `Renderer` over another row and asks it
   * exactly this: `$66109m2` is "row 66109's `m2`", and every per-effect column comes from that row.
   */
  simpleToken(body: string): string | null {
    const split = this.splitToken(body);
    if (split === null) {
      return null;
    }
    const value = split.stat !== null
      ? this.statValue(split.stat)
      : this.tokenValue(split.kind!, split.index, split.indexed);
    if (value === null || !Number.isFinite(value)) {
      return null;
    }
    this.lastNumber = value;
    return split.stat !== null ? formatNumber(value) : this.renderTokenValue(split.kind!, split.index, value);
  }

  /**
   * The same token as a NUMBER -- what an operand inside `${...}` needs. See `evaluate`'s `$` arm for
   * why the two paths differ for exactly one token (`$s<n>`, whose printed form can be a range).
   */
  private numericToken(body: string): number | null {
    const split = this.splitToken(body);
    if (split === null) {
      return null;
    }
    const value = split.stat !== null
      ? this.statValue(split.stat)
      : this.tokenValue(split.kind!, split.index, split.indexed);
    if (value === null || !Number.isFinite(value)) {
      return null;
    }
    this.lastNumber = value;
    return value;
  }

  /**
   * "s1" / "AP" / "MWS" -> either a STAT name or a (letter, 0-based effect index) pair.
   *
   * The multi-letter stat names are tested against the WHOLE body, which is the grammar's only
   * disambiguation: `$sp`/`$SP` and `$pl`/`$PL` both occur in the corpus, and `$s1`/`$p1` are
   * different tokens that share their first letter.
   */
  private splitToken(
    body: string,
  ): { stat: string | null; kind: string | null; index: number; indexed: boolean } | null {
    const stat = body.toUpperCase();
    if (STAT_TOKENS.has(stat)) {
      return { stat, kind: null, index: 0, indexed: false };
    }
    const parsed = /^([a-zA-Z])(\d*)$/.exec(body);
    if (parsed === null) {
      declareGap(`$${body.toLowerCase()}`, 'not a token form this evaluator knows', this.row.id);
      return null;
    }
    // The effect index is 1-BASED in the description and 0-based in the row. An absent index means
    // effect 1, which is what a bare `$m` means beside `$m1` in the corpus.
    const index = parsed[2] === '' ? 0 : Number(parsed[2]) - 1;

    // CASE IS NOT SIGNIFICANT except for the `m`/`M` pair, and that is measured rather than assumed:
    // `Spell.dbc` 11069 Improved Fireball authors `$/1000;S1` with a CAPITAL S where 1,080 other
    // spells author `$s1`, and there is no second meaning a capital could carry -- `$m1`/`$M1` are the
    // only two letters the corpus uses as a distinguished pair (`$m1 to $M1`, e.g. 49909 Icy Touch).
    // Folding recovered 130 spells the previous draft left showing `$/1000;S1`, plus `$D`, `$A<n>`,
    // `$T<n>` and `$H`.
    const kind = parsed[1] === 'm' || parsed[1] === 'M' ? parsed[1] : parsed[1].toLowerCase();
    return { stat: null, kind, index, indexed: parsed[2] !== '' };
  }

  /**
   * The two tokens that print more than a bare number, both formatted by the client's own strings.
   *
   *  - **`$s<n>`** is a SPREAD when the effect can roll one: `INT_SPELL_POINTS_SPREAD_TEMPLATE`,
   *    `"%d to %d"` (`globalstrings.lua:4292`). Collapsed to one number when min == max, which is what
   *    the same template degenerates to and what 1,080 of the 1,397 sampled `$s1` spells need.
   *  - **`$d`** carries its UNIT: `INT_SPELL_DURATION_SEC = "%d sec"` and `INT_SPELL_DURATION_MIN =
   *    "%d min"` (`globalstrings.lua:4291`, `:4290`), with `SPELL_DURATION_SEC = "%.2f sec"` (`:6936`)
   *    for a duration that is not whole seconds. Fireball's "over $d." becomes "over 4 sec."
   *    **The THRESHOLD between the two units is ours**: whole minutes under an hour print as minutes,
   *    everything else as seconds. `globalstrings.lua` supplies the four formats and states no rule for
   *    choosing between them, so a 90-second duration prints "90 sec" here where the real client may
   *    print "1.5 min". Stated, not hidden.
   *
   * Every other token is its bare value -- `$t<n>` included, because the descriptions that use it
   * supply the word themselves ("every $t2 seconds").
   */
  private renderTokenValue(kind: string, index: number, value: number): string {
    if (kind === 's' || kind === 'm' || kind === 'M') {
      // THE PRINTED VALUE IS THE MAGNITUDE, and the authored prose in the served file is the evidence.
      // A reducing effect stores a NEGATIVE: 11069 Improved Fireball is `basePoints -101, dieSides 1`
      // -> -100, and its own description is "Reduces the casting time of your Fireball spell by
      // $/1000;S1 sec." -- a sentence that reads "by -0.1 sec" unless the token is the magnitude. 1753
      // Cower's "your pet takes $s2% less damage" is the same construction. Two authored sentences that
      // only parse with a positive number, in the same file as the negative columns.
      //
      // Applied at PRINT time only, NOT in `numericToken`: an operand inside `${...}` keeps its sign,
      // because an expression is free to add a negative term and nothing served says otherwise.
      // ORDERING the spread after taking the magnitude (a negative effect's min is the larger
      // magnitude) is OURS -- no negative effect in the corpus has `dieSides > 1`, so it is unexercised.
      const range = effectRange(this.row, index, this.stats.level);
      const lo = Math.min(Math.abs(range.min), Math.abs(range.max));
      const hi = Math.max(Math.abs(range.min), Math.abs(range.max));
      if (kind === 'm') {
        return formatNumber(lo);
      }
      if (kind === 'M') {
        return formatNumber(hi);
      }
      return lo === hi ? formatNumber(lo) : `${formatNumber(lo)} to ${formatNumber(hi)}`;
    }
    if (kind === 'd') {
      return formatDuration(value);
    }
    return formatNumber(value);
  }

  /** A stat token's live value, or null when the caster's state has not arrived. */
  private statValue(stat: string): number | null {
    switch (stat) {
      case 'AP': return this.stats.attackPower;
      case 'RAP': return this.stats.rangedAttackPower;
      case 'PL': return this.stats.level > 0 ? this.stats.level : null;
      case 'MWS': return this.stats.mainHandSpeedSec;
      case 'BH': return this.stats.bonusHealing;
      case 'SP': {
        const value = this.stats.spellDamage[schoolOf(this.row)];
        return typeof value === 'number' ? value : null;
      }
      default: {
        // The per-school family, named by spell 48165 -- see `SPELL_POWER_SCHOOL`.
        const school = SPELL_POWER_SCHOOL[stat];
        if (school === undefined) {
          return null;
        }
        const value = this.stats.spellDamage[school];
        return typeof value === 'number' ? value : null;
      }
    }
  }

  /**
   * The numeric value of a single-letter token on this row's effect `index`.
   *
   * `$s` answers the effect's MINIMUM here so that arithmetic over it is well defined; the range form
   * is applied only when it is printed directly (`renderTokenValue`).
   */
  private tokenValue(kind: string, index: number, indexed: boolean): number | null {
    const row = this.row;
    const range = () => effectRange(row, index, this.stats.level);
    switch (kind) {
      case 's': return range().min;
      case 'm': return range().min;
      case 'M': return range().max;
      case 'b': return row.effectPointsPerComboPoint[index] ?? null;
      case 'h': return row.procChance;
      case 'n': return row.stackAmount;
      case 'u': return row.maxAffectedTargets;
      case 'i':
        // `$i` IS `MaxAffectedTargets`, measured on two spells whose real numbers are in their own
        // prose: 1680 Whirlwind "attack up to $i enemies" reads **4**, and 5484 Howl of Terror
        // "causing $i enemies within $a1 yds to flee" reads **5** -- the values the game is known for.
        // It shares the column with `$u`; nothing served distinguishes the two, and both spells above
        // would be wrong under any other column on the row.
        return row.maxAffectedTargets;
      case 'r': {
        // `$r` -- the SPELL'S range in yards, from `SpellRange.dbc` (already loaded for the action
        // bar's range indicator). Only the UNINDEXED form, which is why `indexed` exists: `$r1` occurs
        // 43 times and a spell-scope token carrying an effect index is ambiguous between range and
        // radius -- 3052 Fire Shield Effect's "$s1 Fire damage to any enemies within $r1 yards" reads
        // as a RADIUS -- and printing a range where the sentence means a radius is exactly the
        // wrong-number-as-truth failure this file exists to avoid. `$r<n>` stays visible.
        if (indexed) {
          declareGap('$r<n>', 'a spell-scope range carrying an effect index is ambiguous with radius', row.id);
          return null;
        }
        return spellData.maxRange(row.id);
      }
      case 'x': return row.effectChainTargets[index] ?? null;
      case 'a': return spellData.radiusYards(row.effectRadiusIndex[index] ?? 0);
      case 't': {
        // `EffectAmplitude` is MILLISECONDS between ticks; `$t<n>` is printed in SECONDS -- Fireball's
        // own tooltip line is "$s2 Fire damage every $t2 seconds" with an amplitude of 2000.
        const ms = row.effectAmplitudeMs[index] ?? 0;
        return ms > 0 ? ms / 1000 : null;
      }
      case 'd': {
        const ms = spellData.durationMs(row.durationIndex);
        return ms === null ? null : ms / 1000;
      }
      case 'o': {
        // TOTAL OVER TIME: the per-tick value times the number of ticks. Both factors come from this
        // row -- duration / amplitude -- so a spell with either missing has no total to state.
        const ms = spellData.durationMs(row.durationIndex);
        const period = row.effectAmplitudeMs[index] ?? 0;
        // `ms <= 0` and not just `null`: a duration of -1 is "until cancelled"
        // (`SpellDuration.dbc` row 21), which has no tick COUNT, so there is no total to state.
        if (ms === null || ms <= 0 || period <= 0) {
          return null;
        }
        return range().min * Math.floor(ms / period);
      }
      default:
        declareGap(`$${kind}`, 'no served file states what this token means', row.id);
        return null;
    }
  }

  /**
   * A named variable from this spell's `SpellDescriptionVariables` row -- `$<mult>`, `$<percent>`.
   *
   * The row is a block of `$name=<rhs>` lines separated by CRLF; an rhs is itself description text
   * (typically `$?s<talent>[${a}][${b}]`, a talent ladder), so it is expanded through the same path,
   * with `resolving` breaking the self-reference each rung makes to the rung below it.
   */
  private variable(name: string): string | null {
    if (this.variables.has(name)) {
      return this.variables.get(name) ?? null;
    }
    if (this.resolving.has(name)) {
      // A genuinely circular row. Refuse rather than recurse; the token stays visible.
      return null;
    }
    const block = spellData.descriptionVariables(this.row.descriptionVariablesID);
    if (block === null) {
      return null;
    }
    const assignment = new RegExp(`\\$${name}=([^\\r\\n]*)`).exec(block);
    if (assignment === null) {
      return null;
    }
    // THE GUARD MUST SPAN THE FALLBACK TOO, and a first draft dropped it one line early -- caught in
    // self-review, not by a test. `delete` sat immediately after `expand`, so the `evaluate` fallback
    // below re-entered `parseAt` -> `$<name>` -> `variable(name)` with `resolving` already cleared and
    // no memo entry yet, which recurses without bound on a row that references ITSELF (`$a=$<a>`). No
    // served row does that today -- the sweep over 22,602 descriptions threw nothing -- but the file is
    // data we do not control, and an unbounded recursion here takes the whole tooltip out.
    this.resolving.add(name);
    let rendered: string | null = this.expand(assignment[1]);
    if (rendered !== null && !/\$\?/.test(assignment[1])) {
      // A BARE expression right-hand side, with no `${}` around it: `$base=($pl-1)*3+10` (variables row
      // 181). `expand` leaves that as arithmetic text, so it is evaluated directly -- but only when the
      // rhs is NOT a conditional. Trying it on a `$?s...[a][b]` rhs would fail in `evaluate` and file a
      // `${...} unparsed` row against a `$<name>` failure, which is the ledger telling a small lie
      // about what is missing.
      const unresolved = /\$/.test(rendered);
      const notANumber = !/^\s*-?[\d.]/.test(rendered);
      if (unresolved || notANumber) {
        const value = this.evaluate(assignment[1]);
        if (value !== null) {
          rendered = formatNumber(value);
        } else if (unresolved) {
          rendered = null;
        }
      }
    } else if (rendered !== null && /\$/.test(rendered)) {
      // A conditional rhs that still carries a token -- the branch it chose did not resolve.
      rendered = null;
    }
    this.resolving.delete(name);
    this.variables.set(name, rendered);
    return rendered;
  }

  /**
   * Evaluate one `${...}` body: `+ - * / ( )`, unary minus, numbers, and `$` tokens as operands.
   *
   * Hand-written recursive descent, deliberately -- the language is four operators and the project
   * takes no new dependency for one. Any operand that does not resolve fails the WHOLE expression
   * (null), which is what leaves the authored `${...}` visible instead of half-computed.
   */
  evaluate(source: string): number | null {
    let at = 0;
    const skip = () => { while (at < source.length && /\s/.test(source[at])) at += 1; };

    const primary = (): number | null => {
      skip();
      if (at >= source.length) {
        return null;
      }
      if (source[at] === '(') {
        at += 1;
        const inner = additive();
        skip();
        if (source[at] !== ')') {
          return null;
        }
        at += 1;
        return inner;
      }
      if (source[at] === '-') {
        at += 1;
        const inner = primary();
        return inner === null ? null : -inner;
      }
      if (source[at] === '$') {
        // A PLAIN token is taken numerically FIRST, and that is load-bearing: printed on its own,
        // `$s1` on an effect that rolls renders the range "6 to 10", which is not a number. Inside
        // arithmetic the operand is the effect's own value, which is what `tokenValue` answers.
        const plain = /^\$([A-Za-z]+\d*)/.exec(source.slice(at));
        if (plain !== null) {
          const numeric = this.numericToken(plain[1]);
          if (numeric !== null) {
            at += plain[0].length;
            return numeric;
          }
        }
        const parsed = this.parseAt(source, at);
        if (parsed === null) {
          return null;
        }
        at = parsed.next;
        const value = Number(parsed.text);
        return Number.isFinite(value) ? value : null;
      }
      const number = /^\d+(?:\.\d+)?/.exec(source.slice(at));
      if (number === null) {
        return null;
      }
      at += number[0].length;
      return Number(number[0]);
    };

    const multiplicative = (): number | null => {
      let left = primary();
      for (;;) {
        skip();
        const op = source[at];
        if (op !== '*' && op !== '/') {
          return left;
        }
        at += 1;
        const right = primary();
        if (left === null || right === null || (op === '/' && right === 0)) {
          return null;
        }
        left = op === '*' ? left * right : left / right;
      }
    };

    const additive = (): number | null => {
      let left = multiplicative();
      for (;;) {
        skip();
        const op = source[at];
        if (op !== '+' && op !== '-') {
          return left;
        }
        at += 1;
        const right = multiplicative();
        if (left === null || right === null) {
          return null;
        }
        left = op === '+' ? left + right : left - right;
      }
    };

    const result = additive();
    skip();
    // A trailing remainder means something in the body is not arithmetic -- `$gt($<melee>,$<spell>)`
    // is the one such form in the served variables table. Refusing keeps the authored text visible.
    if (at < source.length) {
      // KEYED BY FORM, not by the source text. A first version keyed this on `source.slice(at, at+4)`
      // and filled the ledger with 20 rows of arithmetic fragments (`+0.1`, `.5*$`, `)`) -- which made
      // the one thing the ledger is for, saying WHAT is missing and how much it costs, unreadable.
      declareGap('${...} unparsed', 'a ${...} body contains something that is not arithmetic (a function call such as $gt/$max/$FLOOR/$cond, or an operand token that did not resolve)', this.row.id);
      return null;
    }
    return result;
  }
}

/** `${` at `open` -> the index of its matching `}`, or -1. Bodies nest: `${$m1*($x+1)}` does not, but
 * a conditional's branch can carry a second `${...}`. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `[...]` at `at` -> its body and the index after it, or null when `at` is not a `[`. */
function readBracket(text: string, at: number): { body: string; next: number } | null {
  if (text[at] !== '[') {
    return null;
  }
  let depth = 0;
  for (let i = at; i < text.length; i += 1) {
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        return { body: text.slice(at + 1, i), next: i + 1 };
      }
    }
  }
  return null;
}

/**
 * A spell's description with every token this evaluator can resolve replaced by its number.
 *
 * Returns the raw description unchanged when the row carries no `$` at all, which is 9,148 of the
 * 31,748 described spells and costs them nothing.
 */
export function renderSpellDescription(row: SpellRow, stats: CasterStats): string {
  if (row.description === '' || !row.description.includes('$')) {
    return row.description;
  }
  return new Renderer(row, stats).render();
}

/**
 * THE INSTRUMENT. `window.spellDescription.explain(spellId)` -> every token in that spell's
 * description, what it resolved FROM, and what it resolved TO.
 *
 * Built because "the tooltip shows a number" is not a checkable claim -- thirty-three implementers on
 * this project have reported a success that did not reproduce, and a description evaluator is exactly
 * the kind of thing that can produce a plausible wrong number. This prints the operands beside the
 * result, so the arithmetic can be re-done by hand from the served DBC and compared.
 *
 * `raw` is the authored string, `rendered` the output, and `tokens` one row per distinct `$`
 * construction with the columns it came out of.
 *
 * **ONE CAVEAT, because an instrument that quietly disagrees with the thing it measures is worse than
 * none**: a `tokens` row renders that construction ALONE, so a token whose value depends on the text
 * before it reads differently there than in `rendered`. The only such token is the plural selector --
 * `$lpoint:points;` reports "points" in isolation (no preceding number, so not 1) while `rendered`
 * correctly says "Awards 1 combo point." **`rendered` is the truth**; a `tokens` row is the arithmetic
 * for one substitution, not a claim about the sentence.
 */
export function explainSpellDescription(spellId: number, stats: CasterStats): unknown {
  const row = spellData.spell(spellId);
  if (row === null) {
    return { spellId, error: 'no Spell.dbc row (table not loaded, or unknown id)' };
  }
  const tokens: unknown[] = [];
  const seen = new Set<string>();
  const pattern = /\$(?:\{[^}]*\}(?:\.\d)?|\?[sa]\d+|<\w+>|\/\d+(?:\.\d+)?;|\d+[a-zA-Z]+\d*|[lLgG][^:;]*:[^;]*;|[A-Za-z]+\d*)/g;
  for (const match of row.description.matchAll(pattern)) {
    if (seen.has(match[0])) {
      continue;
    }
    seen.add(match[0]);
    tokens.push({
      token: match[0],
      resolvesTo: new Renderer(row, stats).expand(match[0]),
    });
  }
  return {
    spellId,
    name: row.name,
    rank: row.subName,
    raw: row.description,
    rendered: renderSpellDescription(row, stats),
    tokens,
    // The columns every numeric token above is a function of, so the arithmetic can be re-derived.
    from: {
      effectBasePoints: row.effectBasePoints,
      effectDieSides: row.effectDieSides,
      effectRealPointsPerLevel: row.effectRealPointsPerLevel,
      effectPointsPerComboPoint: row.effectPointsPerComboPoint,
      effectAmplitudeMs: row.effectAmplitudeMs,
      effectRadiusIndex: row.effectRadiusIndex,
      effectChainTargets: row.effectChainTargets,
      durationIndex: row.durationIndex,
      durationMs: spellData.durationMs(row.durationIndex),
      procChance: row.procChance,
      stackAmount: row.stackAmount,
      maxAffectedTargets: row.maxAffectedTargets,
      baseLevel: row.baseLevel,
      spellLevel: row.spellLevel,
      maxLevel: row.maxLevel,
      schoolMask: row.schoolMask,
      descriptionVariablesID: row.descriptionVariablesID,
      descriptionVariables: spellData.descriptionVariables(row.descriptionVariablesID),
      // What `effectRange` makes of the first two columns at this caster's level -- the identity every
      // numeric token is built on.
      effect1: effectRange(row, 0, stats.level),
      effect2: effectRange(row, 1, stats.level),
    },
    caster: {
      level: stats.level,
      attackPower: stats.attackPower,
      rangedAttackPower: stats.rangedAttackPower,
      spellDamage: stats.spellDamage,
      mainHandSpeedSec: stats.mainHandSpeedSec,
      female: stats.female,
    },
  };
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).spellDescription = {
    render: renderSpellDescription,
    explain: explainSpellDescription,
    gaps: spellDescriptionGaps,
  };
}
