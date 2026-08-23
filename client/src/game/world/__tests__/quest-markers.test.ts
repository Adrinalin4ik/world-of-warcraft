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
 * `NONE` is the important half: the server answers it for every non-giver in view, so a non-null
 * result there would put a marker on the whole zone.
 */
/** The served paths use the game's own separator; built this way so no escape can be mis-typed. */
const BS = String.fromCharCode(92);
const art = (stem: string) => ['interface', 'buttons', `${stem}.m2`].join(BS);

test('every status the reference maps gets its own art, and NONE draws nothing', () => {
  // The one status that must never draw: the server answers it for every non-giver in view.
  expect(modelFor(DIALOG_STATUS.NONE)).toBeNull();

  // GOLD -- an offer you can take, and a turn-in that is ready.
  expect(modelFor(DIALOG_STATUS.AVAILABLE)).toBe(art('talktome'));
  expect(modelFor(DIALOG_STATUS.AVAILABLE_REP)).toBe(art('talktome'));
  expect(modelFor(DIALOG_STATUS.REWARD)).toBe(art('talktomequestionmark'));
  expect(modelFor(DIALOG_STATUS.REWARD2)).toBe(art('talktomequestionmark'));

  // GREY -- the same two things when they are not actionable yet. `UNAVAILABLE` and the low-level
  // offers are the grey `!`; a held-but-unfinished quest is the grey `?`, which this test used to
  // assert drew NOTHING because the model was believed unserved. It is served as
  // `talktomequestion_grey`, so the pair the owner asked for -- grey while unfinished, gold once
  // complete -- is the REWARD/INCOMPLETE line below and the one above it.
  expect(modelFor(DIALOG_STATUS.UNAVAILABLE)).toBe(art('talktomegrey'));
  expect(modelFor(DIALOG_STATUS.LOW_LEVEL_AVAILABLE)).toBe(art('talktomegrey'));
  expect(modelFor(DIALOG_STATUS.LOW_LEVEL_AVAILABLE_REP)).toBe(art('talktomegrey'));
  expect(modelFor(DIALOG_STATUS.INCOMPLETE)).toBe(art('talktomequestion_grey'));
  expect(modelFor(DIALOG_STATUS.LOW_LEVEL_REWARD_REP)).toBe(art('talktomequestion_grey'));

  // LIGHT BLUE -- the reputation turn-in, its own served model.
  expect(modelFor(DIALOG_STATUS.REWARD_REP)).toBe(art('talktomequestion_ltblue'));

  // The reference's slot, carried as a number so a silent edit shows up here.
  expect(MARKER_ATTACHMENT).toBe(18);
});
