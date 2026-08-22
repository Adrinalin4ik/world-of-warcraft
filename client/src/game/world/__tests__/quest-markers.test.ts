import { modelFor, MARKER_ATTACHMENT } from '../quest-markers';
import { DIALOG_STATUS } from '../../../network/game/object/quest';

/**
 * THE STATUS -> MODEL MAP, and the two statuses that must draw NOTHING.
 *
 * The rest of the marker path is `attachTo` on a bone and a matrix row norm -- neither testable
 * without a loaded M2 and a propagated scene, which is the live half and is named as such. This is
 * the pure decision, and it is the one where a wrong answer hangs a `!` over an NPC with nothing to
 * offer.
 *
 * `NONE` and `UNAVAILABLE` are the important half: the server answers them for every non-giver in
 * view, so a non-null result here would put a marker on the whole zone.
 */

/** The served paths use the game's own separator; built this way so no escape can be mis-typed. */
const BS = String.fromCharCode(92);
const art = (stem: string) => ['interface', 'buttons', `${stem}.m2`].join(BS);

test('only an offer or a turn-in gets a marker, and low level gets the grey art', () => {
  // Nothing at all -- the common case, and the one that must never draw.
  expect(modelFor(DIALOG_STATUS.NONE)).toBeNull();
  expect(modelFor(DIALOG_STATUS.UNAVAILABLE)).toBeNull();
  // `INCOMPLETE` is a DECLARED gap rather than an oversight -- see `quest-markers.ts#modelFor`.
  expect(modelFor(DIALOG_STATUS.INCOMPLETE)).toBeNull();

  // An offer and a turn-in are different art.
  expect(modelFor(DIALOG_STATUS.AVAILABLE)).toBe(art('talktome'));
  expect(modelFor(DIALOG_STATUS.AVAILABLE_REP)).toBe(art('talktome'));
  expect(modelFor(DIALOG_STATUS.REWARD)).toBe(art('talktomequestionmark'));
  expect(modelFor(DIALOG_STATUS.REWARD2)).toBe(art('talktomequestionmark'));
  expect(modelFor(DIALOG_STATUS.REWARD_REP)).toBe(art('talktomequestionmark'));

  // Below the player's level: the grey art, and all three low-level statuses share it because no grey
  // question mark is served on this build.
  expect(modelFor(DIALOG_STATUS.LOW_LEVEL_AVAILABLE)).toBe(art('talktomegrey'));
  expect(modelFor(DIALOG_STATUS.LOW_LEVEL_AVAILABLE_REP)).toBe(art('talktomegrey'));
  expect(modelFor(DIALOG_STATUS.LOW_LEVEL_REWARD_REP)).toBe(art('talktomegrey'));

  // The reference's slot, carried as a number so a silent edit shows up here.
  expect(MARKER_ATTACHMENT).toBe(18);
});
