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
  LogonEndpoint,
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
  /** See `enteredCharacter`. Set only on a successful `enterWorld`. */
  private entered_: CharacterRecord | null = null;

  private credentials: { account: string; password: string } | null = null;
  /**
   * The address the current attempt was told to dial, if the caller named one. Held beside the
   * credentials, and cleared with them, because the 3 s retry has to dial the same place the player
   * asked for -- not silently fall back to the transport's baked default.
   */
  private endpoint: LogonEndpoint | null = null;
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
  /**
   * Bumped by `cancelLogin`. `attemptLogin` captures it and re-checks after each await, so a login the
   * player cancelled cannot land its result afterwards. Separate from `stageEpoch`, which tracks world
   * DISCONNECTS for the realm/world rollbacks -- conflating them would make a cancel look like a
   * disconnect to `chooseRealm`'s rollback guard.
   */
  private loginEpoch = 0;
  private listeners = new Set<(state: SessionState) => void>();
  /**
   * Set by `stop()` and cleared by `login()`. Once true, a queued retry from `onLoginFailure` is a
   * no-op. That is ALL it does -- see `onWorldDisconnect` for the thing it used to do and must not.
   */
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

  /**
   * The character this session actually entered the world as, or null before `enterWorld` succeeds.
   *
   * The world route needs it and cannot derive it: `CMSG_PLAYER_LOGIN` carries only a guid, and the
   * server's own answer for where the character stands arrives spread across
   * `SMSG_LOGIN_VERIFY_WORLD` and a compressed update-object. The ROSTER already carries `mapId`,
   * `zoneId` and `position` for every row (`wotlk/world-wire.ts#decodeCharEnum`), so holding the
   * record the guid resolved to gives the world an authoritative-enough spawn immediately, and gives
   * anyone reading the packets an independent check on what the server says.
   *
   * Deliberately NOT cleared by `onWorldDisconnect`: it records what this session entered as, and a
   * dropped socket does not make that untrue. It is replaced only by a later successful `enterWorld`.
   */
  get enteredCharacter(): CharacterRecord | null {
    return this.entered_;
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
    this.endpoint = null;
    this.refusal_ = null;
    this.notify();
  }

  /**
   * The player cancelled an in-flight login attempt -- the connecting dialog's CANCEL button
   * (`GlueDialogTypes["CANCEL"]`, whose `OnAccept` is the client's own `StatusDialogClick`).
   *
   * `dismiss()` is not enough on its own: it clears the refusal and the retry but leaves `stage_`
   * alone, so the `Connecting` dialog stayed up over a screen whose credentials had just been dropped.
   * This returns the stage to `Offline` as well, which is what takes the dialog down.
   *
   * WHAT THIS DOES NOT DO: abort the socket. Neither transport exposes an abort, so a request already
   * on the wire stays on it. What this does instead is make it irrelevant -- `loginEpoch` is bumped, and
   * `attemptLogin` checks it after every await, so a late success neither stores a session key nor moves
   * the stage to `RealmList` (which would have walked the player onto the realm screen after they
   * cancelled), and a late failure schedules no retry. The attempt cannot affect anything the player can
   * see or reach; it merely finishes unobserved.
   */
  cancelLogin(): void {
    this.loginEpoch++;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.credentials = null;
    this.endpoint = null;
    this.refusal_ = null;
    this.sessionKey = null;
    this.stage_ = LoginStage.Offline;
    this.notify();
  }

  /** Subscribe to state; returns the unsubscribe. */
  on(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * `endpoint` is where to dial; omitted, the transport's own default stands. It arrives here rather
   * than at construction because the player can edit the server address on the login screen right up
   * until they submit.
   */
  async login(account: string, password: string, endpoint?: LogonEndpoint): Promise<void> {
    // A fresh login invalidates whatever a previous login joined, and a manual retry here must
    // replace any retry the last failure scheduled -- not stack behind it.
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.joined = false;
    // Somebody is using this session again, so a previous owner's `stop()` must not still be
    // suppressing this attempt's own retries. `stop()` is called on every glue-route unmount and
    // never undone, so without this the FIRST world entry left every later login unable to retry a
    // transport failure -- silently, since a refusal is the only other thing that ends an attempt.
    this.stopped = false;
    // A new login supersedes whatever an earlier one obtained: a session key left standing here
    // would let a stale disconnect from the old connection read it and fake a live realm list.
    this.sessionKey = null;
    // Every login starts from a closed transport, so the socket is established afresh. Without this a
    // first attempt that ended badly left its slot held and its socket open, and `authenticate` refuses
    // to start while a slot is held -- so one bad attempt made every later one throw instead of dial,
    // no matter how correct the credentials were.
    this.logon.close();
    this.credentials = { account, password };
    this.endpoint = endpoint ?? null;
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
      // BEFORE `enter`, not after: `enter` notifies, and the world route is driven off that
      // notification -- a listener that navigated to the world and then read a null
      // `enteredCharacter` would place the player at a debug spot instead of where they stand.
      this.entered_ = this.characters_.find((record) => record.guid === guid) ?? null;
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

    const epoch = this.loginEpoch;
    this.enter(LoginStage.Connecting);

    try {
      this.enter(LoginStage.Authenticating);
      const { sessionKey } = await this.logon.authenticate(
        credentials.account,
        credentials.password,
        this.endpoint ?? undefined,
      );
      // Cancelled (or superseded) while that was on the wire: drop the result on the floor. Storing
      // the key or advancing the stage here would walk the player onto the realm screen after they
      // pressed CANCEL.
      if (this.loginEpoch !== epoch) {
        return;
      }
      this.sessionKey = sessionKey;

      const realms = await this.logon.realms();
      if (this.loginEpoch !== epoch) {
        return;
      }
      this.realms_ = realms;
      this.enter(LoginStage.RealmList);
    } catch (error) {
      // Same guard on the failure path: a cancelled attempt must not re-report its refusal or queue a
      // retry. `cancelLogin` has already put the stage where it belongs.
      if (this.loginEpoch !== epoch) {
        return;
      }
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
      this.endpoint = null;
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
   * Tears down the one thing nothing outside the machine can otherwise stop: a pending 3 s retry
   * timer. An owner going away mid-retry (a screen unmounting, `GlueApp#stop`) must not leave a
   * timer firing into a dead object. There is nothing pending at this level to reject -- callers of
   * `login`/`chooseRealm`/etc. own their own promises.
   *
   * It does NOT stop the machine tracking the world connection. It used to, and that was the bug:
   * this is called on every glue-route unmount, including the one that ENTERS the world, so it
   * silenced disconnect reporting for the whole rest of the page's life. `login()` clears the flag
   * again for the same reason.
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
    // NO `stopped` GATE HERE, and its removal is the fix rather than an oversight.
    //
    // `stop()` runs on the glue route's unmount -- which is what ENTERING THE WORLD does
    // (`pages/glue/index.tsx:71-74` -> `game/ui/screens.ts:201`) -- and `stopped` is never set back
    // to false. So from the moment a session started, every world disconnect returned right here and
    // the machine went on claiming the stage it had. Captured on a live page: after
    // `session.game.disconnect()`, and after a fresh glue app had mounted and subscribed,
    // `protocol.stage` still read `InWorld`. Nothing could learn the session had died, so nothing
    // could tear it down or offer the player a way back.
    //
    // `stopped`'s own purpose is narrower than the flag had grown to be, and its declaration says so:
    // a queued 3 s retry from `onLoginFailure` must not fire after its owner went away. That is
    // still enforced, at line 346. Keeping the state machine honest costs nothing when nobody is
    // listening -- `notify()` over an empty `listeners` set is a no-op -- and is exactly what a
    // later subscriber needs to read.
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
