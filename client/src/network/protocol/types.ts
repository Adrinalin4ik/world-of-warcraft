/**
 * The protocol layer's version-neutral vocabulary.
 *
 * Nothing here may name a build. The seam is only real if a 1.12.1 implementation can satisfy these
 * types without bending them, so three known differences are deliberately absent: the logon
 * challenge body, the world handshake's digest input and addon block, and the number of equipment
 * slots in a character record (vanilla enumerates 19 plus a bag, WotLK 23 — hence a LIST).
 */

export type RealmInfo = {
  id: number;
  name: string;
  /** Host without the port, as the realm advertises it. */
  host: string;
  port: number;
  /** The server's own load figure. Lower is lighter; the scale is the server's, not ours. */
  population: number;
  characterCount: number;
  online: boolean;
  recommended: boolean;
  pvp: boolean;
  /** Present only when the realm advertises a build. Absent is normal, not an error. */
  build?: { major: number; minor: number; patch: number; build: number };
};

export type EquipmentDisplay = {
  displayId: number;
  inventoryType: number;
  enchantmentId: number;
};

/** The five dials the create screen edits and the roster reports. */
export type CharacterAppearance = {
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialHair: number;
};

export type CharacterRecord = {
  /** Hex string: a 64-bit guid does not survive a JS number. */
  guid: string;
  name: string;
  race: number;
  class: number;
  gender: number;
  level: number;
  appearance: CharacterAppearance;
  zoneId: number;
  mapId: number;
  position: [number, number, number];
  guildId: number;
  flags: number;
  /** As many slots as the build enumerates. Consumers read what is there. */
  equipment: EquipmentDisplay[];
  pet?: { displayId: number; level: number; family: number };
};

export type CharCreateRequest = {
  name: string;
  race: number;
  class: number;
  gender: number;
  appearance: CharacterAppearance;
  /** The starting-outfit id the create screen picked. */
  outfitId: number;
};

/**
 * A refusal from the server, typed so the UI can say it in the client's own words. `stringKey` is a
 * key into `GlueStrings` -- this layer never holds user-visible wording.
 */
export type ProtocolRefusal = {
  code: number;
  stringKey: string;
};

/** Thrown/rejected with, so a caller can `instanceof` it rather than sniff shapes. */
export class ProtocolRefusalError extends Error {
  readonly refusal: ProtocolRefusal;

  constructor(refusal: ProtocolRefusal) {
    super(`server refused: ${refusal.stringKey} (${refusal.code})`);
    this.name = 'ProtocolRefusalError';
    this.refusal = refusal;
  }
}

export interface LogonTransport {
  /** Opens the logon socket and runs challenge + proof. Rejects with `ProtocolRefusalError`. */
  authenticate(account: string, password: string): Promise<{ sessionKey: Uint8Array }>;
  realms(): Promise<RealmInfo[]>;
  close(): void;
}

export interface WorldTransport {
  join(realm: RealmInfo, account: string, sessionKey: Uint8Array): Promise<void>;
  characters(): Promise<CharacterRecord[]>;
  createCharacter(request: CharCreateRequest): Promise<void>;
  deleteCharacter(guid: string): Promise<void>;
  /** Resolves when the world confirms the login. */
  enterWorld(guid: string): Promise<void>;
  close(): void;
  onDisconnect(listener: (reason: string) => void): void;
}
