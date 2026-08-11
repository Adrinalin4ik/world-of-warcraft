/**
 * What `SMSG_AUTH_RESPONSE` said about the ACCOUNT, kept where the UI can read it.
 *
 * One field so far -- the expansion the account is entitled to -- and it is here rather than on the
 * `GameHandler` because of WHEN it is read. `ReputationFrame_OnLoad` calls
 * `GetAccountExpansionLevel()` during the FrameXML load, long before any bridge attaches, and the
 * runtime's engine globals are installed with no session in reach (`world-runtime.ts` takes a root, an
 * art table and a viewport, deliberately). A module-level record written by the packet handler is the
 * same arrangement `classes/spell-wire.ts` uses, and the ordering works out because the auth response
 * arrives in the login burst -- tens of seconds before the world UI boots.
 *
 * ## Why the expansion matters at all
 *
 * `MAX_PLAYER_LEVEL = MAX_PLAYER_LEVEL_TABLE[GetAccountExpansionLevel()]` (`ReputationFrame.lua:25`,
 * with the table at :15-18 as `{[0]=60, [1]=70, [2]=80}`). With that global absent the handler aborted
 * and `MAX_PLAYER_LEVEL` stayed at its declared **0**, so every `newLevel < MAX_PLAYER_LEVEL` test in
 * the manifest read false and the client believed the character was at the level cap.
 */

/** The default, and it is the CLIENT's expansion rather than a guess about the account's. */
const WOTLK = 2;

export interface AccountInfo {
  /**
   * `SMSG_AUTH_RESPONSE`'s trailing expansion byte: 0 vanilla, 1 TBC, 2 WotLK.
   *
   * MEASURED on `logon.gladewow.ru` (`scratchpad/t10-auth.js`), the whole 15-byte packet:
   *
   *   `00 0d ee 01 | 0c 00 00 00 00 00 00 00 00 00 02`
   *
   * -- a 4-byte incoming header (size 0x000d, opcode 0x01ee), then the body TrinityCore 3.3.5's
   * `WorldSession::SendAuthResponse` writes: `uint8 code` (0x0c AUTH_OK), `uint32 BillingTimeRemaining`,
   * `uint8 BillingPlanFlags`, `uint32 BillingTimeRested`, `uint8 Expansion` -- 11 body bytes, the last
   * of which is **2**.
   *
   * Starts at 2 rather than null: this client IS build 12340 (`network/config.ts`), so the expansion of
   * the game being run is WotLK whatever an account says, and `/game?offline=1` has no auth response at
   * all. A wire value overwrites it.
   */
  expansion: number;
}

export const accountInfo: AccountInfo = { expansion: WOTLK };

/**
 * Record what an auth-response body said. `body` is the packet's BODY (past the header), as measured
 * above; a body too short to carry the byte leaves the value alone rather than zeroing it, because
 * expansion 0 would mean "vanilla" and cap the level at 60.
 */
export function readAuthResponseExpansion(body: Uint8Array): void {
  if (body.length < 11) {
    return;
  }
  accountInfo.expansion = body[10];
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).accountInfo = accountInfo;
}
