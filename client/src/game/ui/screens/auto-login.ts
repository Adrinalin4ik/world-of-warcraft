import type { LuaVM } from '../framexml/lua/vm';

/**
 * AUTOLOGIN FROM THE URL -- `?login=&password=&realmIndex=&characterIndex=`.
 *
 * A development affordance the owner asked for by name: with all four present, a page refresh should walk
 * the whole entry path by itself -- fill the account form, log in, pick the realm, pick the character and
 * enter the world.
 *
 * ## IT DRIVES THE CLIENT'S OWN LUA. That is the whole design.
 *
 * Every step below is the function the client's own button calls, and nothing here reaches past a screen
 * to the protocol:
 *
 *  - `AccountLoginAccountEdit:SetText(...)` / `AccountLoginPasswordEdit:SetText(...)` then
 *    `AccountLogin_Login()` -- which is what `AccountLoginLoginButton`'s `OnClick` runs
 *    (`accountlogin.lua:170`), including its `DefaultServerLogin` and its "clear the password field".
 *  - `RealmList.currentRealm = n` then `RealmList_OnOk()` -- exactly what
 *    `RealmSelectButton_OnDoubleClick` does (`realmlist.lua:292-299`) minus `selectedName`, which is a
 *    display string the OK path never reads.
 *  - `CharacterSelect_SelectCharacter(n)` then `CharacterSelect_EnterWorld()`
 *    (`characterselect.lua:423,444`).
 *
 * So an addon hooking any of those sees the same calls it would see from a human, and a screen that
 * changes its own entry point takes this with it. Reaching for `DefaultServerLogin` or `EnterWorld`
 * directly would have been shorter and would have skipped the client's own bookkeeping -- the saved
 * account name, the sound, the password clear.
 *
 * ## EVERY STEP IS GUARDED ON THE SCREEN BEING READY, AND ON A DEADLINE
 *
 * The three screens arrive asynchronously: the manifest loads, then the auth handshake answers, then the
 * realm list arrives, then the character list. So each step polls a readiness EXPRESSION and acts once,
 * and a step that never becomes ready gives up after `STEP_TIMEOUT_MS` with a named reason.
 *
 * The deadline is not decoration. A `realmIndex` of 9 on a two-realm account, or a `characterIndex`
 * past the end, would otherwise sit silently for ever looking exactly like a slow connection -- and this
 * project has spent whole rounds on symptoms that turned out to be a silent wait.
 *
 * ## THE PASSWORD IS IN THE URL, and that is worth one line
 *
 * A query string lands in the browser's history, in any proxy log on the way, and in a screenshot of the
 * address bar. This is a local development client and the owner asked for exactly this, so it is built --
 * but nothing here writes it anywhere, and `credentials()` is the only thing that reads it.
 */

/** How long a step may wait for its screen before giving up and saying which one. */
const STEP_TIMEOUT_MS = 30_000;

export interface AutoLoginRequest {
  login: string;
  password: string;
  realmIndex: number;
  characterIndex: number;
}

/**
 * The four parameters, or null when the set is incomplete.
 *
 * ALL FOUR OR NOTHING, which is the owner's own wording ("если все параметры введены"). A partial set is
 * ambiguous -- a login with no realm index could mean "fill the form and stop" or "guess realm 1" -- and
 * guessing which would be a decision this file has no business making. Pure and exported so the parsing
 * is testable without a VM.
 *
 * The indices are 1-BASED, because that is what the client's own APIs take: `GetNumRealms` /
 * `RealmList.currentRealm` and `CharacterSelect_SelectCharacter` are both 1-based, and a 0-based
 * parameter would be a second convention for the owner to remember.
 */
export function readAutoLogin(search: string): AutoLoginRequest | null {
  const params = new URLSearchParams(search);
  const login = params.get('login');
  const password = params.get('password');
  const realm = Number(params.get('realmIndex'));
  const character = Number(params.get('characterIndex'));

  if (login === null || login === '' || password === null) {
    return null;
  }
  if (!Number.isInteger(realm) || realm < 1 || !Number.isInteger(character) || character < 1) {
    return null;
  }
  return {
    login, password, realmIndex: realm, characterIndex: character,
  };
}

/** Where the walk has got to. `Done` is terminal either way -- finished or given up. */
enum Step {
  Login,
  Realm,
  Character,
  Done,
}

/** One step: what to wait for, what to do, and what to call it when it never arrives. */
interface StepPlan {
  readonly name: string;
  /** A Lua expression answering true when the step may act. Errors count as "not yet". */
  readonly ready: string;
  /** The Lua the step runs -- the client's own entry point. */
  readonly act: string;
}

/**
 * Escape a string for embedding in a Lua literal.
 *
 * An account name or a password is arbitrary text off a URL, and it is spliced into a chunk. Backslash
 * first, then the quote, then the newline -- in that order, or the escaping escapes its own escapes.
 * `object.ts`' own docstring warns about "splicing frame names into a `runExpr` source string" for this
 * reason; here the splice is unavoidable (the values are the point), so it is made safe instead.
 */
function luaString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export class AutoLoginDriver {
  private step = Step.Login;

  /** When the current step started waiting, for the deadline. */
  private since = 0;

  private readonly plans: Record<Step, StepPlan | null>;

  constructor(private readonly request: AutoLoginRequest, now: number) {
    this.since = now;
    this.plans = {
      [Step.Login]: {
        name: 'the login form',
        // The frame has to exist AND be up: the manifest holds `AccountLogin` and `CharacterSelect` at
        // once, and which is visible is the client's decision (`framexml-screen.ts`' header).
        ready: 'AccountLogin ~= nil and AccountLogin:IsShown() and AccountLoginAccountEdit ~= nil',
        act: `AccountLoginAccountEdit:SetText(${luaString(request.login)})\n`
          + `AccountLoginPasswordEdit:SetText(${luaString(request.password)})\n`
          + 'AccountLogin_Login()',
      },
      [Step.Realm]: {
        name: `realm ${request.realmIndex}`,
        // `GetNumRealms` takes the selected category, which `RealmList_OnShow` has set by the time the
        // dialog is up. Waiting for the COUNT and not just the frame is what makes a too-large index
        // time out with a reason instead of joining nothing.
        ready: 'RealmList ~= nil and RealmList:IsShown()'
          + ` and GetNumRealms(RealmList.selectedCategory) >= ${request.realmIndex}`,
        act: `RealmList.currentRealm = ${request.realmIndex}\nRealmList_OnOk()`,
      },
      [Step.Character]: {
        name: `character ${request.characterIndex}`,
        ready: 'CharacterSelect ~= nil and CharacterSelect:IsShown()'
          + ` and GetNumCharacters() >= ${request.characterIndex}`,
        act: `CharacterSelect_SelectCharacter(${request.characterIndex})\n`
          + 'CharacterSelect_EnterWorld()',
      },
      [Step.Done]: null,
    };
  }

  get finished(): boolean {
    return this.step === Step.Done;
  }

  /**
   * One tick. Cheap when the step is not ready: a single boolean expression through the VM.
   *
   * Called from the glue screen's own `update`, which already runs per frame -- so this costs one `runExpr`
   * per frame for the few seconds the walk takes, and nothing at all afterwards.
   */
  tick(vm: LuaVM, now: number): void {
    const plan = this.plans[this.step];
    if (plan === null) {
      return;
    }

    const ready = vm.runExpr(`return ${plan.ready}`, 'autologin.ready');
    // An ERROR here is "not ready", not a failure: a global that the manifest has not defined yet raises,
    // and that is precisely the state this is waiting out. A global that is never defined is caught by
    // the deadline below instead, which reports which step it was.
    if (!('value' in ready) || ready.value !== true) {
      if (now - this.since > STEP_TIMEOUT_MS) {
        console.warn(
          `autologin: gave up waiting for ${plan.name} after ${Math.round(STEP_TIMEOUT_MS / 1000)}s`,
          'value' in ready ? '' : ready,
        );
        this.step = Step.Done;
      }
      return;
    }

    const error = vm.run(plan.act, 'autologin.act');
    if (error !== null) {
      console.warn(`autologin: ${plan.name} raised; stopping the walk`, error);
      this.step = Step.Done;
      return;
    }
    this.step = this.step === Step.Login ? Step.Realm
      : this.step === Step.Realm ? Step.Character
        : Step.Done;
    this.since = now;
  }
}

export default AutoLoginDriver;
