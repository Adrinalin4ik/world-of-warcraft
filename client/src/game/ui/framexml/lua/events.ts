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
import { MethodTable, contextFor, registerMethods } from './object';
import { invokeScriptHandler } from './scripts';

/** Every frame currently registered for an event, in registration order. */
const framesByEvent = new Map<string, number[]>();

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
export function fireEvent(vm: LuaVM, eventName: string, args: unknown[] = []): void {
  const ctx = contextFor(vm);
  if (ctx === null) {
    return;
  }
  const list = framesByEvent.get(eventName);
  if (list === undefined) {
    return;
  }
  // Rule 2, spelled out: `list` is the SAME array `RegisterEvent`/`UnregisterEvent` mutate, held by
  // reference for the whole walk. `list.length` is re-read every iteration (not cached into a local
  // before the loop starts) so a push during this very dispatch extends how far the loop goes, and
  // `list[i]` is re-read every iteration so a splice during this dispatch is seen too.
  for (let i = 0; i < list.length; i++) {
    invokeScriptHandler(ctx, list[i], 'OnEvent', [eventName, ...args]);
  }
}
