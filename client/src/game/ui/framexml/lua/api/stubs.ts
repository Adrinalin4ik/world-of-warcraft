/**
 * Everything the brief calls out as a no-op that "must merely exist so a reference does not error" --
 * the account-message system, the legal-notice/EULA/TOS flow, the anti-cheat DLL scan, the PIN/token
 * second-factor, screenshots, launching a browser, the changed-options dialog, the video/audio options
 * "reset to defaults" buttons, the Battle.net multi-WoW-account picker, tournament realm categories,
 * and the realm-split notice.
 *
 * None of these bridge to anything real in this client: there is no account-message backend, no legal
 * flow, no anti-cheat scanner, no second factor, no screenshot capability, no options system with
 * defaults to reset, no multiple WoW accounts per Battle.net account, and no tournament realms. Each
 * comment below names the screen that calls it, so the next reader can tell "deliberately stubbed"
 * from "forgotten."
 *
 * A few of these are given a non-nil, non-throwing return where the reference feeds the result straight
 * into a numeric comparison or a `for` loop bound (`GetNumUnreadMsgs() > 0`, `for i=1,
 * GetNumGameAccounts()`) -- returning nothing there would turn "no-op" into "runtime error," which is
 * exactly the failure mode this file exists to avoid.
 */
import { LuaVM } from '../vm';

export function installStubApi(vm: LuaVM): void {
  // --- AccountMsg_* (AccountLogin / RealmList's account-message popup) ---------------------------
  vm.registerFunction('AccountMsg_LoadHeaders', () => []);
  vm.registerFunction('AccountMsg_GetNumUnreadMsgs', () => [0]); // fed into `> 0`; must be a number.
  vm.registerFunction('AccountMsg_GetIndexNextUnreadMsg', () => []);
  vm.registerFunction('AccountMsg_LoadBody', () => []);
  vm.registerFunction('AccountMsg_GetHeaderSubject', () => ['']);
  vm.registerFunction('AccountMsg_GetBody', () => ['']);

  // --- AccountLogin's legal-notice flow (TOSFrame) -------------------------------------------------
  vm.registerFunction('ShowTOSNotice', () => [false]);
  vm.registerFunction('ShowEULANotice', () => [false]);
  vm.registerFunction('ShowContestNotice', () => [false]);
  vm.registerFunction('ShowScanningNotice', () => [false]);
  vm.registerFunction('ShowTerminationWithoutNoticeNotice', () => [false]);
  // Treated as already accepted: a private-server client has no legal flow to gate on.
  vm.registerFunction('TOSAccepted', () => [true]);
  vm.registerFunction('EULAAccepted', () => [true]);
  vm.registerFunction('ContestAccepted', () => [true]);
  vm.registerFunction('ScanningAccepted', () => [true]);
  vm.registerFunction('TerminationWithoutNoticeAccepted', () => [true]);

  // --- AccountLogin's anti-cheat DLL scan --------------------------------------------------------
  vm.registerFunction('ScanDLLStart', () => []);
  vm.registerFunction('ScanDLLContinueAnyway', () => []);
  vm.registerFunction('IsScanDLLFinished', () => [true]); // No scanner: treat as already finished.

  // --- AccountLogin / VirtualKeypadFrame / TokenEntryOkayButton's second factor ------------------
  vm.registerFunction('PINEntered', () => []);
  vm.registerFunction('TokenEntered', () => []);

  // --- AccountLogin_OnKeyDown / CinematicsFrame_OnKeyDown's PRINTSCREEN handler -------------------
  vm.registerFunction('Screenshot', () => []);

  // --- AccountLogin_ManageAccount / AccountLogin_LaunchCommunitySite ------------------------------
  vm.registerFunction('LaunchURL', () => []);

  // --- Options screens ------------------------------------------------------------------------------
  vm.registerFunction('SetClearConfigData', () => []); // VideoOptionsFrame.
  vm.registerFunction('SetPreferredInfo', () => []); // GlueParent's GET_PREFERRED_REALM_INFO handler.
  vm.registerFunction('StatusDialogClick', () => []); // The generic connecting/status dialog.
  vm.registerFunction('SurveyNotificationDone', () => []); // AccountLogin_SurveyNotificationDone.
  vm.registerFunction('GetChangedOptionWarnings', () => []); // ChangedOptionsDialog: nothing changed.
  vm.registerFunction('ShowChangedOptionWarnings', () => [false]); // ChangedOptionsDialog_OnShow.
  vm.registerFunction('VideoOptionsFrame_SetAllToDefaults', () => []);
  vm.registerFunction('VideoOptionsFrame_SetCurrentToDefaults', () => []);
  vm.registerFunction('AudioOptionsFrame_SetAllToDefaults', () => []);
  vm.registerFunction('AudioOptionsFrame_SetCurrentToDefaults', () => []);

  // --- WoWAccountSelect (the Battle.net multi-WoW-account picker) ---------------------------------
  vm.registerFunction('SetGameAccount', () => []);
  vm.registerFunction('GetGameAccountInfo', () => []);
  vm.registerFunction('GetNumGameAccounts', () => [0]); // fed into `for i=1, ...`; must be a number.

  // --- RealmList's locale/tournament realm categories ---------------------------------------------
  vm.registerFunction('IsInvalidLocale', () => [false]);
  vm.registerFunction('IsTournamentRealmCategory', () => [false]);
  vm.registerFunction('IsInvalidTournamentRealmCategory', () => [false]);

  // --- GlueParent's SERVER_SPLIT_NOTICE / RealmList's realm-split notice --------------------------
  vm.registerFunction('SetRealmSplitState', () => []);
  vm.registerFunction('RequestRealmSplitInfo', () => []);
  vm.registerFunction('RealmListDialogCancelled', () => []);

  // --- The addon system (AddonList.xml, and `UpdateAddonButton` from CharacterSelect_OnShow) -------
  //
  // This client has no addon loader at all: nothing reads an `.toc`, nothing sandboxes a third-party
  // Lua file, and there is no disk to enumerate. So "no addons" is the complete and TRUE answer, not a
  // placeholder -- `GetNumAddOns() > 0` is the first line of `UpdateAddonButton` (addonlist.lua:5) and
  // it correctly hides the Addons button on the character screen.
  //
  // Latent until this task: `UpdateAddonButton` is only reachable from `CharacterSelect_OnShow`, so
  // while `CharacterSelect.xml` was past `stopAfter` the nil `GetNumAddOns` could not be hit. It aborted
  // that whole `OnShow` -- which is why `CharSelectRealmName` drew blank before this line existed.
  vm.registerFunction('GetNumAddOns', () => [0]); // fed into `> 0` and `for i=1, ...`; must be a number.
  vm.registerFunction('GetAddOnInfo', () => []);
  vm.registerFunction('GetAddOnDependencies', () => []);
  vm.registerFunction('GetAddOnEnableState', () => [0]); // 0 = disabled, the state of an absent addon.
  vm.registerFunction('EnableAddOn', () => []);
  vm.registerFunction('DisableAddOn', () => []);
  vm.registerFunction('EnableAllAddOns', () => []);
  vm.registerFunction('DisableAllAddOns', () => []);
  vm.registerFunction('ResetAddOns', () => []);
  vm.registerFunction('SaveAddOns', () => []);
  vm.registerFunction('IsAddonVersionCheckEnabled', () => [false]);
  vm.registerFunction('SetAddonVersionCheck', () => []);

  // `SetCharSelectBackground` and `SetCharCustomizeBackground` were here as no-ops and are now real,
  // in `api/characters.ts` -- they are the two calls `SetBackgroundModel` (glueparent.lua:374-386)
  // bottoms out in, so stubbing them was what pinned character select to the login screen's stage.
}
