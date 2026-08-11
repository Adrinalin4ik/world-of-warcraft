/**
 * The two account-scope globals the in-world manifest reads at LOAD time, both of them one fact: which
 * expansion this account is entitled to.
 *
 * Small, and load-bearing out of all proportion to its size. `ReputationFrame_OnLoad` is
 *
 *     MAX_PLAYER_LEVEL = MAX_PLAYER_LEVEL_TABLE[GetAccountExpansionLevel()];
 *
 * (`ReputationFrame.lua:25`, table at :15-18 = `{[0]=60, [1]=70, [2]=80}`). With the global absent that
 * handler aborted, `MAX_PLAYER_LEVEL` stayed at the **0** the file declares, and every
 * `level < MAX_PLAYER_LEVEL` test in the manifest read false -- so the client treated a level-2
 * character as capped. `LFDFrame.lua:1` (`EXPANSION_LEVEL = GetExpansionLevel()`) aborted its whole
 * chunk on the other spelling at file scope.
 *
 * The value comes off the wire: `SMSG_AUTH_RESPONSE`'s trailing byte, decoded in
 * `network/game/account-info.ts`, which is also where the measured packet bytes are recorded.
 */
import { accountInfo } from '../../../../../network/game/account-info';
import { LuaVM } from '../vm';

export function installAccountApi(vm: LuaVM): void {
  // Both spellings are the SAME engine value in 3.3.5 -- an account's entitlement -- and the client
  // uses `GetAccountExpansionLevel` for the level cap and `GetExpansionLevel` for content gating. There
  // is no per-realm expansion cap in this client to make them differ.
  vm.registerFunction('GetAccountExpansionLevel', () => [accountInfo.expansion]);
  vm.registerFunction('GetExpansionLevel', () => [accountInfo.expansion]);
}
