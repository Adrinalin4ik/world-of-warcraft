/**
 * `focus` resolves to the entity `FocusUnit` was given, and stops resolving when that entity leaves.
 *
 * One test, happy path, per the project's test rule. It covers the join the model-pane agent named as
 * the missing call -- token -> entity for `focus` -- because that is the part no other test reaches:
 * `resolveUnitToken`'s other cases read fields `World` maintains for its own reasons, while this one is
 * written from `ui/group-bridge.ts` and nothing else would notice if the write disappeared.
 */
import { resolveUnitToken, TokenWorld } from '../unit-tokens';

type FakeUnit = { guid: string };

function fakeWorld(): TokenWorld & { focus: FakeUnit | null } {
  const player = { guid: '0x1' } as never;
  const other = { guid: '0x2' } as never;
  return {
    player,
    target: other,
    entities: new Map([['0x1', player], ['0x2', other]]),
    focus: null,
  } as never;
}

describe('the focus unit token', () => {
  it('resolves to the entity the focus was set to, and to nothing once it is cleared', () => {
    const world = fakeWorld();

    // Nothing focused: null, which callers must draw as "no portrait" rather than a black disc.
    expect(resolveUnitToken('focus', world)).toBeNull();

    // What `FocusUnit` does: store the entity behind the token it was handed.
    world.focus = resolveUnitToken('target', world) as never;
    expect(resolveUnitToken('focus', world)).toBe(world.target);
    // Case is the resolver's business, not the caller's -- the client's own files use both spellings.
    expect(resolveUnitToken('FOCUS', world)).toBe(world.target);

    // What `ClearFocus` and `World#remove` do.
    world.focus = null;
    expect(resolveUnitToken('focus', world)).toBeNull();
  });
});
