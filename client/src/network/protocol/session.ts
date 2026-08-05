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
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(state: SessionState) => void>();

  constructor(
    logon: LogonTransport,
    world: WorldTransport,
    options: { retryDelayMs?: number } = {},
  ) {
    this.logon = logon;
    this.world = world;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  }

  get stage(): LoginStage {
    return this.stage_;
  }

  get realms(): RealmInfo[] {
    return this.realms_;
  }

  get characters(): CharacterRecord[] {
    return this.characters_;
  }

  get lastRefusal(): ProtocolRefusal | null {
    return this.refusal_;
  }

  /** Subscribe to state; returns the unsubscribe. */
  on(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async login(account: string, password: string): Promise<void> {
    this.credentials = { account, password };
    this.refusal_ = null;
    return this.attemptLogin();
  }

  async chooseRealm(realm: RealmInfo): Promise<void> {
    if (!this.sessionKey || !this.credentials) {
      throw new Error('cannot choose a realm before logging in');
    }

    this.enter(LoginStage.JoiningRealm);
    await this.world.join(realm, this.credentials.account, this.sessionKey);
    await this.refreshCharacters();
  }

  async createCharacter(request: CharCreateRequest): Promise<void> {
    await this.world.createCharacter(request);
    await this.refreshCharacters();
  }

  async deleteCharacter(guid: string): Promise<void> {
    await this.world.deleteCharacter(guid);
    await this.refreshCharacters();
  }

  async enterWorld(guid: string): Promise<void> {
    this.enter(LoginStage.EnteringWorld);
    await this.world.enterWorld(guid);
    this.enter(LoginStage.InWorld);
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
      this.notify();
      return;
    }

    this.notify();

    if (this.credentials && this.retryTimer === null) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        // Fire and forget: a failed retry schedules the next one through this same path.
        void this.attemptLogin().catch(() => undefined);
      }, this.retryDelayMs);
    }
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
      realms: this.realms_,
      characters: this.characters_,
      refusal: this.refusal_,
    };
    this.listeners.forEach((listener) => listener(state));
  }
}
