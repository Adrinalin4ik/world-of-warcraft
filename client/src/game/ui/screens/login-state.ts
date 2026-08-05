/**
 * What the login screen tells the player, given where the session is.
 *
 * Pure, and separate from the layout, because this is the part with actual rules: an in-flight attempt
 * outranks a previous failure (otherwise a stale "unknown account" sits over the connecting dialog),
 * and a refusal survives the return to `Offline` precisely so the player can read it.
 *
 * Returns a string KEY, never wording -- `GlueStrings` resolves it at draw time, so the player reads
 * the client's own words.
 */
import { LoginStage } from '../../../network/protocol/stages';
import { ProtocolRefusal } from '../../../network/protocol/types';
import { ClientState } from '../screens';

export type LoginDialog =
  | { kind: 'none' }
  | { kind: 'connecting' }
  | { kind: 'error'; stringKey: string };

export function loginDialog(stage: LoginStage, refusal: ProtocolRefusal | null): LoginDialog {
  if (stage === LoginStage.Connecting || stage === LoginStage.Authenticating) {
    return { kind: 'connecting' };
  }

  if (refusal && stage === LoginStage.Offline) {
    return { kind: 'error', stringKey: refusal.stringKey };
  }

  return { kind: 'none' };
}

/**
 * Which client state the session's stage means -- the one thing that carries a successful login past
 * the login screen.
 *
 * Total over `LoginStage` deliberately: a stage with no mapping would leave whatever screen happened
 * to be up still mounted, which is exactly the dead end this function exists to close.
 *
 *  - `Offline`, `Connecting` and `Authenticating` all mean the player is still AT the login screen.
 *    The first two put a dialog over it, but that is `loginDialog`'s business, not a state change.
 *  - `JoiningRealm` stays on `RealmList`: the realm the player clicked is still being joined and the
 *    roster `CharSelect` draws does not exist yet. It also lines up with `ProtocolSession#chooseRealm`,
 *    whose rollback on a failed join restores the stage the player was already looking at.
 *  - `EnteringWorld` stays on `CharSelect`, for the mirror reason: the character is chosen but the
 *    world has not confirmed, and a failed `enterWorld` rolls back to `CharacterList` -- the screen
 *    the player never left.
 *  - `InWorld` maps to `ClientState.InWorld`, because that is what it means. No glue screen is
 *    registered for it (the world is its own route), so `GlueApp#enter` warns and keeps the current
 *    screen. That is the honest outcome: the alternative is to claim the stage means a screen it does
 *    not mean, and `screens.ts#tick` already documents that the world loop must not start until the
 *    glue loop has stopped.
 */
export function clientStateForStage(stage: LoginStage): ClientState {
  switch (stage) {
    case LoginStage.Offline:
    case LoginStage.Connecting:
    case LoginStage.Authenticating:
      return ClientState.Login;
    case LoginStage.RealmList:
    case LoginStage.JoiningRealm:
      return ClientState.RealmList;
    case LoginStage.CharacterList:
    case LoginStage.EnteringWorld:
      return ClientState.CharSelect;
    case LoginStage.InWorld:
      return ClientState.InWorld;
  }
}

/**
 * Which main-menu stage the URL asks for. A debug affordance, not the client's law: the client keys
 * off `IsStreamingTrial()`, and `expansion` is here because an expansion number is the way a human
 * thinks about "show me the 3.3.5 screen". `expansion=0` (or `1`) means the pre-Wrath art, which the
 * client only ever shows to a trial account; anything else, or nothing at all, means Wrath.
 */
export function wantsTrialScene(search: string): boolean {
  const params = new URLSearchParams(search);

  if (params.get('trial') === '1' || params.get('trial') === 'true') {
    return true;
  }

  const expansion = params.get('expansion');
  if (expansion === null) {
    return false;
  }

  const level = Number(expansion);
  return Number.isFinite(level) && level < 2;
}
