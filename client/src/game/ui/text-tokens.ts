/**
 * SERVER TEXT TOKENS -- `$n`, `$c`, `$b`, `$g male:female;` -- and why the ENGINE does this.
 *
 * The owner's screenshot of Deputy Willem read **"Hello there, $c."** with the token printed
 * literally, and his note was "$c должен содержать имя похоже" -- the name. **It is the CLASS**, and
 * substituting a name there would have produced text that looks right and is wrong, which is the
 * failure mode this project keeps paying for.
 *
 * ## IT IS OURS, and that was checked rather than assumed
 *
 * Grepped the whole FrameXML mirror for a Lua substitution pass over these tokens: **there is none.**
 * The server sends the raw string in the gossip and quest packets and the client's ENGINE expands it
 * on display, so there is no global we are failing to answer -- this is engine work, and it belongs
 * next to the bridges that hand these strings to the documents.
 *
 * ## THE TOKEN SET IS EVIDENCED FROM SERVED TEXT, not from memory
 *
 * Every binding below is read off real 3.3.5a strings captured from the live server through
 * `SMSG_QUEST_QUERY_RESPONSE` (11 templates, residual 0) plus the owner's own screenshot:
 *
 *  - **`$n` / `$N` -> the player's NAME.** `"You there! $n, right?"` (quest 1097) and
 *    `"Your first task is one of cleansing, $N."` (quest 783). Only a name fits either.
 *  - **`$c` / `$C` -> the player's CLASS.** `"I hope you strapped your belt on tight, young $c,
 *    because there is work to be done"` (quest 5261) -- "young warrior", "young mage". **And the
 *    discriminator that settles it against "name": the SAME corpus uses `$n` for the name**, so `$c`
 *    cannot also be one. That is why this is a citation and not a guess.
 *  - **`$b` / `$B` -> a LINE BREAK.** `"...seen across the river to the east.$B$BI don't know what
 *    they're up to"` (quest 18) and `"You there! $n, right?$b$bI hope you're sure about becoming a
 *    warlock"` (quest 1097). Doubled, it is a paragraph break, which is exactly how both read.
 *  - **`$g <male>:<female>;` / `$G` -> a GENDER-CONDITIONAL.** `"Hello, $ggood sir:my lady;!  Do you
 *    have a moment?"` (quest 60). The terminator is `;` and the separator `:`.
 *
 * ## WHAT IS DELIBERATELY LEFT VISIBLE
 *
 * **`$r` / `$R` is NOT substituted.** It is widely believed to be the player's race, and `UnitRace`
 * exists and would answer -- but **no string in the captured corpus contains it**, so this client has
 * no evidence for the binding. A wrongly-substituted token is worse than a printed one, because the
 * owner cannot tell it from the game's own text; a printed one is visibly a gap. It is named here so
 * the day a `$r` string is captured, one line closes it.
 *
 * Any other `$x` is left exactly as it arrived, for the same reason.
 *
 * **`$g` is left visible when the gender is UNKNOWN.** `UnitSex` answers `1` for "unknown" (see
 * `api/units.ts:128-134`), and picking a branch on an unknown gender is a coin toss printed as fact.
 *
 * ## Why this is not the spell-description evaluator
 *
 * `pipeline/dbc/spell-description.ts` resolves 21,760 of 22,602 descriptions and shows a token for the
 * rest -- the same honesty rule, and the reason this file follows its shape. It is NOT shared, and the
 * reason is that the two token FAMILIES are disjoint: a spell description's `$s1`, `$d`, `$a1` are
 * indexed references into one spell's own DBC row (effect base points, duration, radius), evaluated
 * against a spell id. These are references to the PLAYER, evaluated against a unit token, and none of
 * the four spellings above appears in `globalstrings.lua`'s 691 `$s` / 32 `$d` / 6 `$a` occurrences.
 * Sharing the evaluator would mean one function with two unrelated symbol tables keyed on which
 * caller invoked it, which is the "two differently-wrong copies" outcome that file's own header warns
 * about.
 */
import { LuaVM } from './framexml/lua/vm';

/** `UnitSex`'s numbering, from `api/units.ts`: 1 unknown, 2 male, 3 female. */
const SEX_UNKNOWN = 1;
const SEX_MALE = 2;

/**
 * The player's name, class and gender, read through the client's OWN globals so there is one source of
 * truth rather than a second path into the descriptor.
 *
 * Read per call rather than cached: a token pass runs when a panel opens, not per frame, and a cache
 * would go stale across a character change -- which is the same staleness trap the bridges avoid by
 * reading `world.player` at call time.
 */
function playerFacts(vm: LuaVM): { name: string; className: string; sex: number } {
  const read = (expr: string, fallback: string): string => {
    const result = vm.runExpr(`return ${expr}`, 'text-tokens.lua') as { value?: unknown } | null;
    const value = result?.value;
    return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
  };
  return {
    name: read('tostring(UnitName("player"))', ''),
    className: read('tostring(UnitClass("player"))', ''),
    sex: Number(read('tostring(UnitSex("player"))', String(SEX_UNKNOWN))) || SEX_UNKNOWN,
  };
}

/**
 * Expand the tokens in one server-authored string. Returns it unchanged when it carries none, which is
 * the common case and costs a single `indexOf`.
 *
 * `$b` becomes a real newline rather than a space: `ui/text.ts` breaks on `\n`, and the client's own
 * quest body is authored as paragraphs.
 */
export function expandTextTokens(vm: LuaVM, text: string | null | undefined): string {
  if (typeof text !== 'string' || text.length === 0 || text.indexOf('$') < 0) {
    return typeof text === 'string' ? text : '';
  }
  const facts = playerFacts(vm);

  // `$g male:female;` FIRST, because its branches can themselves contain `$n` or `$b` and the simple
  // tokens must run over the branch that survives rather than over both.
  let out = text.replace(/\$[gG]([^:;]*):([^;]*);/g, (whole, male: string, female: string) => {
    if (facts.sex === SEX_UNKNOWN) {
      // Left VISIBLE -- see the header. A coin toss printed as fact is worse than a printed token.
      return whole;
    }
    return facts.sex === SEX_MALE ? male : female;
  });

  // The simple pair. Both cases of each spelling, and the replacement is a function so a name
  // containing a `$` cannot be re-scanned as a token.
  out = out.replace(/\$[nN]/g, () => facts.name);
  out = out.replace(/\$[cC]/g, () => facts.className);
  out = out.replace(/\$[bB]/g, () => '\n');

  // `$r`/`$R` and anything else are LEFT ALONE. See the header.
  return out;
}

export default expandTextTokens;
