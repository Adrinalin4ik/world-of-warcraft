/**
 * ART SET AT RUNTIME, so a `SetTexture` from Lua actually fetches something.
 *
 * ## The gap this closes
 *
 * `manifest.ts#registerTreeArt` walks the widget tree and registers every texture path it finds **once,
 * after the load**. That covers everything a document AUTHORS. It does not cover anything a SCRIPT
 * sets later -- and `methods/region.ts#SetTexture` only ever did `widget.sprite = path`, with nothing
 * anywhere to notice that the path had never been fetched. A runtime `SetTexture` therefore named a key
 * the art table had no def for, `resolveSprite` answered null, and the region painted NOTHING while
 * laying out perfectly.
 *
 * **That is a widget-layer gap, not a container one, and it is why the backpack had no backdrop.**
 * `ContainerFrame_GenerateFrame` paints the backpack by calling
 * `bgTextureTop:SetTexture("Interface\\ContainerFrame\\UI-BackpackBackground")` at runtime
 * (`containerframe.lua:375-378`) -- the path appears nowhere in `ContainerFrame.xml`, because the
 * client chooses it from the bag's id, type and size. So the frame positioned correctly and drew
 * nothing: a bare grid of slots over the world, with the close button and the money frame floating,
 * which is exactly the owner's screenshot.
 *
 * It is not specific to bags. Every `SetTexture` with a path the XML never mentioned had the same
 * fate, which is why `action-bridge.ts#pushAll` and `container-bridge.ts#pushAll` each had to
 * `art.register(...)` by hand before firing their event. Those hand-registrations are now belt and
 * braces rather than the only thing holding the icons up.
 *
 * ## Why a module-level sink rather than a reference on the context
 *
 * A method table has no world, no session and no art registry, and giving it one is the dependency
 * `methods/gametooltip.ts` is careful not to take (it reaches its item feed through a VM-keyed hook for
 * the same reason). The UI host owns the registry and publishes it here, exactly as it publishes the
 * draw list to `ui/rects.ts`. Both are cleared on dispose so a remounted world cannot write into the
 * previous one's table.
 *
 * ## Cost
 *
 * `register` is idempotent and `load` only fetches defs that have no texture yet, so a `SetTexture`
 * naming an already-loaded path costs a `Map` lookup. The fetch is async and lands a moment later; the
 * frame after it has a different draw fingerprint anyway (the sprite resolves from null to a texture),
 * so the art appears without anything needing to re-run the Lua.
 */
import type { GlueArt } from './art';

let sink: GlueArt | null = null;

/** Paths already handed to the registry from here, so a per-frame `SetTexture` is a Set lookup. */
const seen = new Set<string>();

/** The UI host publishes its registry. Called once per host. */
export function publishArtSink(art: GlueArt): void {
  sink = art;
  seen.clear();
}

/** Drop the sink -- the host is going away. */
export function clearArtSink(): void {
  sink = null;
  seen.clear();
}

/**
 * Make sure a texture path is registered and fetched.
 *
 * A no-op before a host publishes (the glue boot sets textures while its own registry is still being
 * built, and `registerTreeArt` covers everything authored anyway). Blank and non-path values are
 * ignored: `SetTexture` also takes colours, and `region.ts` handles those before reaching here.
 */
export function ensureArt(path: string): void {
  if (sink === null || path === '' || seen.has(path)) {
    return;
  }
  seen.add(path);
  if (sink.def(path) !== undefined && sink.def(path) !== null) {
    // Already known to the table -- authored art, or a second widget naming the same file.
    return;
  }
  sink.register(path, { path });
  void sink.load();
}
