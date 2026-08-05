/**
 * The pre-world session: the one place that knows what order the exchanges happen in.
 *
 * Version-neutral by construction -- it imports the two transport INTERFACES and nothing under
 * `wotlk/`. Screens read `stage`, `realms`, `characters` and `refusal` from state rather than
 * accumulating them from string events, which is what the old handler-per-exchange design forced.
 *
 * The policy is the reference's (benilla `login/mod.rs`), not invented here:
 *  - a REFUSAL clears the credentials and stops. No retry against a wrong password: on vmangos an
 *    0x05 locks the account out, which is exactly why the server answers unknown-account and
 *    wrong-password with the same 0x04.
 *  - a TRANSPORT failure with credentials still standing retries on a flat 3 s beat.
 */
import { LoginStage } from './stages';
import {
  CharacterRecord,
  CharCreateRequest,
  LogonTransport,
  ProtocolRefusal,
  ProtocolRefusalError,
  RealmInfo,
  WorldTransport,
} from './types';

/** The reference's flat reconnect beat. */
export const RETRY_DELAY_MS = 3000;

export type SessionState = {
  stage: LoginStage;
  realms: RealmInfo[];
  characters: CharacterRecord[];
  refusal: ProtocolRefusal | null;
};

export class ProtocolSession {
  private readonly logon: LogonTransport;
  private readonly world: WorldTransport;
  private readonly retryDelayMs: number;

  private stage_: LoginStage = LoginStage.Offline;
  private realms_: RealmInfo[] = [];
  private characters_: CharacterRecord[] = [];
  private refusal_: ProtocolRefusal | null = null;

  private credentials: { account: string; password: string } | null = null;
  private sessionKey: Uint8Array | null = null;
  /**
   * Whether `chooseRealm` has successfully joined a realm on the current login. Deliberately NOT
   * cleared when the roster refresh right after a join fails: the realm connection itself is fine
   * in that case, only the characters call is not, so the mutation guards below should still open.
   */
  private joined = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped only by `onWorldDisconnect`. `chooseRealm`/`enterWorld` capture it alongside the stage
   * they are about to leave; if a disconnect lands (and bumps this) while one of those transport
   * calls is still in flight, the disconnect's state is NEWER than whatever the operation was
   * about to restore on rejection, so the rollback below must stand down instead of overwriting it.
   */
  private stageEpoch = 0;
  private listeners = new Set<(state: SessionState) => void>();
  /** Set by `stop()`. Once true, a queued retry from `onLoginFailure` is a no-op. */
  private stopped = false;

  constructor(
    logon: LogonTransport,
    world: WorldTransport,
    options: { retryDelayMs?: number } = {},
  ) {
    this.logon = logon;
    this.world = world;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
    this.world.onDisconnect(() => this.onWorldDisconnect());
  }

  get stage(): LoginStage {
    return this.stage_;
  }

  get realms(): RealmInfo[] {
    return [...this.realms_];
  }

  get characters(): CharacterRecord[] {
    return [...this.characters_];
  }

  get lastRefusal(): ProtocolRefusal | null {
    return this.refusal_;
  }

  /**
   * Whether a transport failure has a retry queued.
   *
   * A screen needs this because a transport failure leaves NO refusal (the server never answered), so
   * `Offline` with `refusal === null` is otherwise indistinguishable from "the player has not tried
   * yet" -- and against an unreachable server that made the connecting dialog blink on the 3 s beat
   * with nothing said.
   */
  get retrying(): boolean {
    return this.retryTimer !== null;
  }

  /**
   * The player dismissed whatever the screen was saying about a login attempt.
   *
   * Clearing the refusal is the point: a screen derives its dialog from this state every frame, so
   * hiding the widget alone lasts exactly one frame and the dialog returns on the next. A queued retry
   * goes too -- a dismissed "failed to connect" that kept retrying behind the player's back would put
   * its own message straight back up -- and so do the credentials, since nothing may resubmit them
   * after the player said no.
   */
  dismiss(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.credentials = null;
    this.refusal_ = null;
    this.notify();
  }

  /** Subscribe to state; returns the unsubscribe. */
  on(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async login(account: string, password: string): Promise<void> {
    // A fresh login invalidates whatever a previous login joined, and a manual retry here must
    // replace any retry the last failure scheduled -- not stack behind it.
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.joined = false;
    // A new login supersedes whatever an earlier one obtained: a session key left standing here
    // would let a stale disconnect from the old connection read it and fake a live realm list.
    this.sessionKey = null;
    this.credentials = { account, password };
    this.refusal_ = null;
    return this.attemptLogin();
  }

  async chooseRealm(realm: RealmInfo): Promise<void> {
    if (!this.sessionKey || !this.credentials) {
      throw new Error('cannot choose a realm before logging in');
    }

    const priorStage = this.stage_;
    const epoch = this.stageEpoch;
    this.enter(LoginStage.JoiningRealm);
    try {
      await this.world.join(realm, this.credentials.account, this.sessionKey);
      this.joined = true;
      await this.refreshCharacters();
    } catch (error) {
      // Restore whatever stage the machine actually held before this attempt -- not a guessed
      // "RealmList", which would be wrong for a realm SWITCH failing out of CharacterList. But only
      // if nothing newer has happened since: a disconnect can land while `join`/the roster refresh
      // is in flight and already move the stage on (bumping stageEpoch); that state is newer than
      // ours and a stale rollback here must not overwrite it.
      if (this.stageEpoch === epoch) {
        this.stage_ = priorStage;
        this.notify();
      }
      throw error;
    }
  }

  async createCharacter(request: CharCreateRequest): Promise<void> {
    if (!this.joined) {
      throw new Error('cannot create a character before joining a realm');
    }
    await this.world.createCharacter(request);
    await this.refreshCharacters();
  }

  async deleteCharacter(guid: string): Promise<void> {
    if (!this.joined) {
      throw new Error('cannot delete a character before joining a realm');
    }
    await this.world.deleteCharacter(guid);
    await this.refreshCharacters();
  }

  async enterWorld(guid: string): Promise<void> {
    if (!this.joined) {
      throw new Error('cannot enter the world before joining a realm');
    }

    const priorStage = this.stage_;
    const epoch = this.stageEpoch;
    this.enter(LoginStage.EnteringWorld);
    try {
      await this.world.enterWorld(guid);
      this.enter(LoginStage.InWorld);
    } catch (error) {
      // Same rollback as chooseRealm, with the same epoch guard: restore what was only if a
      // disconnect has not landed (and moved the stage on) while this call was in flight.
      if (this.stageEpoch === epoch) {
        this.stage_ = priorStage;
        this.notify();
      }
      throw error;
    }
  }

  private async attemptLogin(): Promise<void> {
    const credentials = this.credentials;
    if (!credentials) {
      throw new Error('no credentials to log in with');
    }

    this.enter(LoginStage.Connecting);

    try {
      this.enter(LoginStage.Authenticating);
      const { sessionKey } = await this.logon.authenticate(
        credentials.account,
        credentials.password,
      );
      this.sessionKey = sessionKey;

      this.realms_ = await this.logon.realms();
      this.enter(LoginStage.RealmList);
    } catch (error) {
      this.onLoginFailure(error);
      throw error;
    }
  }

  /**
   * A refusal is final; a transport failure is not. The difference is the whole policy: one of them
   * can lock an account out if retried, and the other only means the network blinked.
   */
  private onLoginFailure(error: unknown): void {
    this.stage_ = LoginStage.Offline;

    if (error instanceof ProtocolRefusalError) {
      this.refusal_ = error.refusal;
      this.credentials = null;
      // Nothing is left to join with: clear the key too, or a stale disconnect from the earlier
      // connection could still read it and claim a realm list right after this refusal.
      this.sessionKey = null;
      this.notify();
      return;
    }

    this.notify();

    if (this.credentials && this.retryTimer === null) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.stopped) {
          return;
        }
        // Fire and forget: a failed retry schedules the next one through this same path.
        void this.attemptLogin().catch(() => undefined);
      }, this.retryDelayMs);
    }
  }

  /**
   * Tears down what nothing outside the machine can otherwise stop: a pending 3 s retry timer and
   * the world transport's disconnect subscription's effect. An owner going away mid-retry (a screen
   * unmounting, `GlueApp#stop`) must not leave a timer firing into a dead object. There is nothing
   * pending at this level to reject -- callers of `login`/`chooseRealm`/etc. own their own promises.
   */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * The world connection dropped out from under us. Not a login failure, so the retry policy
   * above does not apply here -- that policy exists for the logon path only. This just makes the
   * state honest again: no realm is joined any more, and the stage moves to whatever the player
   * can still legitimately do next (pick a realm again if the session key still stands, otherwise
   * log back in from scratch).
   */
  private onWorldDisconnect(): void {
    if (this.stopped) {
      return;
    }
    this.joined = false;
    this.stage_ = this.sessionKey ? LoginStage.RealmList : LoginStage.Offline;
    // Mark this as a newer state than any chooseRealm/enterWorld call already in flight, so its
    // catch block's rollback (captured before this ran) knows to stand down rather than clobber it.
    this.stageEpoch++;
    this.notify();
  }

  private async refreshCharacters(): Promise<void> {
    this.characters_ = await this.world.characters();
    this.enter(LoginStage.CharacterList);
  }

  private enter(stage: LoginStage): void {
    this.stage_ = stage;
    this.notify();
  }

  private notify(): void {
    const state: SessionState = {
      stage: this.stage_,
      realms: [...this.realms_],
      characters: [...this.characters_],
      refusal: this.refusal_,
    };
    this.listeners.forEach((listener) => listener(state));
  }
}
