/**
 * The glue screens' sound calls -- every one a no-op. This runtime has no audio engine at all (no
 * `Sound\...` asset pipeline, no mixer), so there is nothing honest to bridge these to; they exist
 * purely so a screen's `OnLoad`/`OnShow`/button click does not error calling them.
 */
import { LuaVM } from '../vm';

export function installSoundApi(vm: LuaVM): void {
  // Every button click and screen transition in AccountLogin/RealmList/CharacterSelect ("gsLogin",
  // "gsTitleOptions", ...).
  vm.registerFunction('PlaySound', () => []);
  // AccountLogin_OnEvent's SCANDLL_FINISHED hack-found alert.
  vm.registerFunction('PlaySoundFile', () => []);
  // AccountLogin_OnShow / GlueParent's START_GLUE_MUSIC.
  vm.registerFunction('PlayGlueMusic', () => []);
  // AccountLogin_OnShow / GlueParent's START_GLUE_MUSIC -- the looping ambience bed under the music.
  vm.registerFunction('PlayGlueAmbience', () => []);
  vm.registerFunction('StopGlueAmbience', () => []);
  // AccountLogin_OnHide.
  vm.registerFunction('StopAllSFX', () => []);
  // The credits screen.
  vm.registerFunction('PlayCreditsMusic', () => []);
}
