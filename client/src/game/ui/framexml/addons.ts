/**
 * `Interface\AddOns\Blizzard_*` -- the client's own UI shipped as addons rather than as FrameXML.
 *
 * ## Why this exists at all
 *
 * This client loaded `FrameXML.toc` and nothing else, and that is not the whole interface. Nine of
 * the character panel's own subframes come from FrameXML, but `TokenFrame` does not: it is defined in
 * `Interface\AddOns\Blizzard_TokenUI\Blizzard_TokenUI.xml`. `CHARACTERFRAME_SUBFRAMES`
 * (`characterframe.lua:8`) names it, and `ToggleCharacter` walks that table calling `_G[value]:Hide()`
 * at `characterframe.lua:28` -- so with the addon unloaded the character sheet could not open AT ALL,
 * which the owner reported. It is not a data gap: all three of the addon's files are served.
 *
 * ## The set, and which part of it is ours
 *
 * The real client ENUMERATES `Interface\AddOns\` off disk. Over HTTP there is no directory listing and
 * `FileData.dbc` is not an enumerator (10 records, all cinematics -- measured in round 28b), so a list
 * is unavoidable. It is not a recalled one: it is a CENSUS of `LoadAddOn("Blizzard_...")` over all 13
 * `.lua` files `framexml.toc` names, which yields 23 distinct addons, and every one of the 23 answers
 * 200 for `<name>/<name>.toc` on the asset host. The client's own files are the enumerator.
 *
 * A brief for this work gave the set as 15. That is where reading the real files disagreed with it:
 * `uiparent.lua:246-336` alone names `Blizzard_BattlefieldMinimap`, `Blizzard_TrainerUI`,
 * `Blizzard_RaidUI`, `Blizzard_GMSurveyUI`, `Blizzard_BarberShopUI`, `Blizzard_ArenaUI` and
 * `Blizzard_GMChatUI`, and `Blizzard_CombatText` comes from elsewhere in the manifest. All eight are
 * served and all eight are `## LoadOnDemand: 1`, so the STARTUP set is unaffected -- but a
 * `LoadAddOn` implementation built against the 15 would have been missing a third of its targets.
 *
 * What is NOT ours is the startup/on-demand split. It is read from each addon's own `.toc` at load
 * time via the `## LoadOnDemand` directive, exactly as the client does -- there is no baked-in
 * classification here to drift out of date. Measured against the host today: `Blizzard_TokenUI` alone
 * carries no `## LoadOnDemand`, and the other twenty-two all carry `## LoadOnDemand: 1`. So the startup
 * set is one addon, three files (`Blizzard_TokenUI.lua`, `Blizzard_TokenUI.xml`, `Localization.lua`),
 * and every other Blizzard addon is correctly absent until something asks for it.
 *
 * ## `LoadAddOn()` -- REAL, and the timing is the whole design
 *
 * A Lua global returns synchronously and fetching an addon's files does not, so demand loading needs
 * every candidate's text in hand before the first `LoadAddOn` call. Two measurements make that
 * affordable:
 *
 *  - **The whole on-demand set is 53 files and 780,575 bytes**, against the manifest's 264 files. It is
 *    not the "load the interface twice" cost the flag exists to avoid.
 *  - **The boot spends ~5 s EXECUTING the manifest after fetching it**, so these closures are fetched
 *    concurrently with that execution and awaited only just before the login events fire. In the common
 *    case the await costs nothing; it exists so the behaviour is DETERMINISTIC rather than depending on
 *    whether a fetch happened to win a race.
 *
 * That is not theoretical tidiness. `UIParent_OnEvent`'s `PLAYER_LOGIN` arm calls `CombatLog_LoadUI()`
 * unconditionally (`uiparent.lua:481`), so an addon IS demand-loaded during the boot on every login --
 * and while `LoadAddOn` was a declared gap that put a modal "Couldn't load Blizzard_...: Unknown load
 * problem" dialog on screen, photographed on a live login. `UIParentLoadAddOn` (`uiparent.lua:234-243`)
 * turns any failure into `message(...)`, so a declared gap here is anything but quiet.
 */
import Loader from '../../net/loader';
import { PrefetchedManifest, prefetchManifest } from './manifest';
import { Toc, parseToc, tocDirective } from './toc';

const ADDONS_DIR = 'Interface\\AddOns\\';

/**
 * Every `Blizzard_*` addon the client's own FrameXML asks for, censused out of it -- see the header
 * for why this is a list and how it was built.
 */
export const BLIZZARD_ADDONS: readonly string[] = [
  'Blizzard_AchievementUI',
  'Blizzard_ArenaUI',
  'Blizzard_AuctionUI',
  'Blizzard_BarberShopUI',
  'Blizzard_BattlefieldMinimap',
  'Blizzard_BindingUI',
  'Blizzard_Calendar',
  'Blizzard_CombatLog',
  'Blizzard_CombatText',
  'Blizzard_DebugTools',
  'Blizzard_GMChatUI',
  'Blizzard_GMSurveyUI',
  'Blizzard_GlyphUI',
  'Blizzard_GuildBankUI',
  'Blizzard_InspectUI',
  'Blizzard_ItemSocketingUI',
  'Blizzard_MacroUI',
  'Blizzard_RaidUI',
  'Blizzard_TalentUI',
  'Blizzard_TimeManager',
  'Blizzard_TokenUI',
  'Blizzard_TradeSkillUI',
  'Blizzard_TrainerUI',
];

export interface PrefetchedAddOn {
  /** The addon's folder name, which is also its `ADDON_LOADED` argument. */
  name: string;
  /** `Interface\AddOns\<name>\`, the base every file of this addon resolves against. */
  dir: string;
  /** The addon's own manifest and file closure, keyed within its OWN namespace. */
  manifest: PrefetchedManifest;
}

/**
 * Which of `names` load at startup, with their files already fetched.
 *
 * One fetch per addon `.toc` to read `## LoadOnDemand`, then the full closure for the ones that stay.
 * The tocs are fetched in PARALLEL because they are the only serial step and there are 23 of them;
 * the closures then follow only for the survivors, which today is one addon.
 *
 * An addon whose `.toc` cannot be fetched is dropped from BOTH sets and named by the caller's report,
 * the same contract `prefetchManifest` has for a missing include: one absent addon costs an addon,
 * not the interface.
 *
 * Returns the startup set RESOLVED and the on-demand set as a PENDING promise -- see the header for why
 * that asymmetry is the design and not an oversight.
 */
export async function prefetchStartupAddOns(
  names: readonly string[] = BLIZZARD_ADDONS,
): Promise<{ startup: PrefetchedAddOn[]; demand: Promise<Map<string, PrefetchedAddOn>> }> {
  const tocs = await Promise.all(names.map(async (name): Promise<[string, Toc | null]> => {
    // NOT `prefetchManifest` with a `stopAfter`: an entry it cannot find in the manifest means "the
    // WHOLE manifest" by design (see its doc comment), so probing that way would fetch all 23
    // addons entire -- the exact cost `## LoadOnDemand` exists to avoid. Only the `.toc` text is
    // wanted here, and it is read through the same `Loader` the rest of the interface uses.
    const text = await fetchTocText(`${ADDONS_DIR}${name}\\${name}.toc`);
    return [name, text === null ? null : parseToc(text)];
  }));

  const closure = async ([name]: [string, Toc | null]): Promise<PrefetchedAddOn> => {
    const dir = `${ADDONS_DIR}${name}\\`;
    return { name, dir, manifest: await prefetchManifest(dir, `${name}.toc`) };
  };

  const served = tocs.filter(([, toc]) => toc !== null);
  // THE ON-DEMAND CLOSURES ARE NOT AWAITED HERE, and that is the point -- see the header. The promise
  // is started now so the fetches overlap the manifest's EXECUTION pass, and the caller awaits it just
  // before the login events, which is the first moment an addon can actually be asked for.
  const demand = Promise.all(served.filter(([, toc]) => isLoadOnDemand(toc)).map(closure))
    .then((all) => new Map(all.map((addOn) => [addOn.name.toLowerCase(), addOn])));

  const startup = await Promise.all(served.filter(([, toc]) => !isLoadOnDemand(toc)).map(closure));
  return { startup, demand };
}

/**
 * The client's own test: an addon loads at startup unless its `.toc` says otherwise.
 *
 * Truthy-by-presence rather than `=== '1'`. The directive's documented values are `1` and `0`, and
 * every one of the twenty-two on-demand addons in this build writes `1`, but a `0` must mean "loads at
 * startup" or the flag's absence and its explicit negation would disagree.
 */
function isLoadOnDemand(toc: Toc | null): boolean {
  if (toc === null) {
    return false;
  }
  const value = tocDirective(toc, 'LoadOnDemand');
  return value !== null && value.trim() !== '' && value.trim() !== '0';
}

/**
 * One `.toc`'s text, or null when the host does not serve it.
 *
 * Its own function rather than an inline `try` because the "absent addon costs an addon" contract in
 * `prefetchStartupAddOns`' doc comment is entirely this catch, and a swallowed rejection is worth
 * being able to point at (`pipeline/worker/pool.js:124` is the cautionary case in this codebase).
 */
async function fetchTocText(path: string): Promise<string | null> {
  try {
    return new TextDecoder('utf-8').decode(await new Loader().load(path));
  } catch {
    return null;
  }
}
