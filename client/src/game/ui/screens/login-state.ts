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
