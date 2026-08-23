/**
 * `RegisterEvent`/`UnregisterEvent`, and the dispatch that turns a fired event into every registered
 * frame's `OnEvent` handler running in order.
 *
 * `object.ts`'s own comment on `frame.ts` is explicit that these two methods were left out of Task 3
 * on purpose, with real ordering rules that a stub would either fake or collide with:
 *
 *   1. `RegisterEvent` appends to an ORDERED per-event list. Re-registering an already-registered
 *      frame is a no-op on ordering -- it keeps its original position rather than moving to the tail
 *      or appearing twice.
 *   2. Dispatch walks BY INDEX, re-reading the live list at each step, so a frame that registers for
 *      the event currently being dispatched (typically from inside another frame's handler for that
 *      same event) is still visited before this dispatch ends.
 *   3. Cross-frame order is a law consumers depend on: two frames writing the same FontString in
 *      response to one event means the LAST one registered before the write wins, and that has to be
 *      reproducible, not incidental to whatever order a `Map`/`Set` happens to iterate in.
 *   4. Events reach registered frames regardless of visibility -- there is no `Show`/`Hide` filter
 *      here, deliberately. A frame that registers while hidden and shows itself in reaction to what
 *      it just heard is a normal FrameXML idiom, not a case to special out.
 *
 * Rule 2 is the one a snapshot-taking implementation (`[...list]`, or a `for...of` over the array
 * value itself) gets wrong without looking wrong: both read as "iterate the registered frames," and
 * both silently stop seeing new registrations the instant dispatch starts, because both capture the
 * list's CONTENTS once instead of holding a reference to the same array `RegisterEvent` mutates in
 * place. The loop below keeps a reference to the live array and re-reads its length and each slot on
 * every iteration for exactly that reason.
 */
import { LuaVM } from './vm';
import { MethodTable, contextFor, onFrameTeardown, registerMethods } from './object';
import { invokeScriptHandler } from './scripts';

/** Every frame currently registered for an event, in registration order. */
const framesByEvent = new Map<string, number[]>();

/**
 * A released frame stops being registered for anything.
 *
 * Two reasons this is not merely tidiness. A stale id left in a list makes `fireEvent` dispatch to a
 * frame that no longer exists -- harmless only because `invokeScriptHandler` finds no handler, which
 * stops being true the moment id reuse ever happens. And `RegisterEvent`'s `includes` check means a
 * frame that re-registers after a rebuild would find its OLD id still there and its NEW one appended
 * behind every surviving list, quietly changing the cross-frame order rule 3 calls a law.
 *
 * Removed IN PLACE, and by index scan rather than by rebuilding the arrays, for the same reason
 * `UnregisterEvent` is: `fireEvent` holds the live array by reference for the length of a dispatch.
 */
onFrameTeardown((_ctx, id) => {
  for (const list of framesByEvent.values()) {
    const index = list.indexOf(id);
    if (index !== -1) {
      list.splice(index, 1);
    }
  }
});

const EVENT_METHODS: MethodTable = {
  // RegisterEvent(eventName). Appending only when the frame is not already in the list is what makes
  // rule 1's "keeps its original position" true -- an `indexOf` check, not a set-then-sort or a
  // remove-then-push, since either of those would move the frame instead of leaving it alone.
  RegisterEvent: (_ctx, self, args) => {
    const eventName = String(args[0] ?? '');
    let list = framesByEvent.get(eventName);
    if (list === undefined) {
      list = [];
      framesByEvent.set(eventName, list);
    }
    if (!list.includes(self)) {
      list.push(self);
    }
    return [];
  },

  /**
   * `IsEventRegistered(eventName)` -> whether THIS frame is in that event's list.
   *
   * Added as an INSTRUMENT as much as an API: the character sheet's stat panes are blank because
   * `PaperDollFrame` does not receive `VARIABLES_LOADED` at login even though its `OnEvent` is bound and
   * a manual replay of the handler fills both panes correctly (measured -- see
   * `ui/paperdoll-stats.ts`). Without this method there was no way to ask, from Lua, whether the frame
   * was registered at all, so the question could not be separated from "the event was not fired".
   *
   * It is real API too: `IsEventRegistered` exists in 3.3.5a, and reading back a list this file already
   * owns asserts nothing new.
   */
  IsEventRegistered: (_ctx, self, args) => {
    const list = framesByEvent.get(String(args[0] ?? ''));
    return [list !== undefined && list.includes(self)];
  },

  // UnregisterEvent(eventName). Removing in place (not replacing the array) matters for the same
  // reason `fireEvent` re-reads by index below: if this ever fires from inside a dispatch of the same
  // event, the in-progress walk has to see the shorter list, not a stale reference to the old one.
  UnregisterEvent: (_ctx, self, args) => {
    const eventName = String(args[0] ?? '');
    const list = framesByEvent.get(eventName);
    if (list === undefined) {
      return [];
    }
    const index = list.indexOf(self);
    if (index !== -1) {
      list.splice(index, 1);
    }
    return [];
  },
};

registerMethods('FRAME', EVENT_METHODS);

/**
 * Fires `eventName` at every frame currently registered for it, in registration order, as an
 * `OnEvent(self, event, ...)` / legacy-globals call through `invokeScriptHandler` -- the one dispatch
 * path Task 5 built, so both calling conventions and the this/event/argN restore-on-error guarantee
 * come along for free.
 *
 * This is the intended firing entry point for anything outside Lua that needs to tell the UI
 * something happened: the session state machine on a connection-state transition, the protocol layer
 * as world/realm packets arrive, the loader for whatever it fires once glue screens are built, and
 * Task 8's engine API (e.g. the realm list arriving, which should become `fireEvent(vm,
 * 'REALM_LIST_UPDATED')` or whatever name Task 8 settles on for it) -- all of them have a `LuaVM` in
 * hand and nothing else, which is why this takes the VM rather than a `MethodContext`: `contextFor`
 * exists in `object.ts` precisely so JS-driven callers like this one can recover the context instead
 * of one being threaded in from wherever the VM was installed. A caller holding a `MethodContext`
 * already (inside a method body, say) can still reach in and call `contextFor` itself if it ever needs
 * to fire an event synchronously from there.
 *
 * Silently does nothing if the VM has no object model installed, or nothing is registered for
 * `eventName` -- both are normal, not error conditions worth throwing over.
 */
/**
 * WHAT EACH EVENT COSTS -- `window.uiEventCensus()`.
 *
 * The owner's frame budget went to 19 fps with `ui.framexml` at **35.6 ms**, everything else in the
 * panel adding to less than that. This file's own neighbour already records why that is the number to
 * instrument: `action-bridge.ts:12` took `ui.framexml` "from ~10 ms to ~1 ms" by firing FEWER events,
 * because one event re-runs every handler registered for it -- `ActionButton_Update` across 24 buttons
 * in that case. So an event fired once per frame instead of once per change is the shape of this defect,
 * and the census names which one rather than leaving it to be guessed.
 *
 * `handlers` is the total number of `OnEvent` invocations, not the number of fires: an event with one
 * fire and forty registered frames costs forty script calls, and that ratio is the thing worth seeing.
 *
 * COST OF THE INSTRUMENT: two `performance.now()` calls per fire. That is real and it is the right
 * trade at 35 ms -- and it is stated rather than hidden, because `CLAUDE.md`'s rule is that an
 * instrument gets the same scepticism as the thing it measures. If events turn out NOT to explain the
 * cost, `total` will be well under `ui.framexml` and the answer is the `OnUpdate` frames instead.
 */
const eventCensus = new Map<string, { fires: number; handlers: number; ms: number }>();

let eventCensusInstalled = false;

function installEventCensus(): void {
  if (eventCensusInstalled) {
    return;
  }
  eventCensusInstalled = true;
  (window as unknown as Record<string, unknown>).uiEventCensus = () => {
    const rows = Array.from(eventCensus.entries())
      .map(([name, row]) => ({
        name,
        fires: row.fires,
        handlers: row.handlers,
        ms: Math.round(row.ms * 10) / 10,
      }))
      .sort((left, right) => right.ms - left.ms);
    const total = rows.reduce((sum, row) => sum + row.ms, 0);
    return { totalMs: Math.round(total * 10) / 10, top: rows.slice(0, 14) };
  };
  (window as unknown as Record<string, unknown>).uiEventCensusReset = () => {
    eventCensus.clear();
    return 'cleared';
  };
}

export function fireEvent(vm: LuaVM, eventName: string, args: unknown[] = []): void {
  const ctx = contextFor(vm);
  if (ctx === null) {
    return;
  }
  installEventCensus();
  const list = framesByEvent.get(eventName);
  if (list === undefined) {
    // COUNTED EVEN SO. An event with no listener is nearly free, but "fired ten thousand times and
    // listened to by nobody" is a real answer and the silent return would hide it.
    const row = eventCensus.get(eventName) ?? { fires: 0, handlers: 0, ms: 0 };
    row.fires += 1;
    eventCensus.set(eventName, row);
    return;
  }
  const startedAt = performance.now();
  let invoked = 0;
  // Rule 2, spelled out: `list` is the SAME array `RegisterEvent`/`UnregisterEvent` mutate, held by
  // reference for the whole walk. `list.length` is re-read every iteration (not cached into a local
  // before the loop starts) so a push during this very dispatch extends how far the loop goes, and
  // `list[i]` is re-read every iteration so a splice during this dispatch is seen too.
  for (let i = 0; i < list.length; i++) {
    invokeScriptHandler(ctx, list[i], 'OnEvent', [eventName, ...args]);
    invoked += 1;
  }
  const row = eventCensus.get(eventName) ?? { fires: 0, handlers: 0, ms: 0 };
  row.fires += 1;
  row.handlers += invoked;
  row.ms += performance.now() - startedAt;
  eventCensus.set(eventName, row);
}
