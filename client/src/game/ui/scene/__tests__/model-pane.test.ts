/**
 * The model PANE: the two things a `<PlayerModel>` needs that the glue `<ModelFFX>` never did.
 *
 * TWO happy-path tests, by the project owner's standing budget, on the two halves that were absent:
 *
 *  1. **The paper doll's own chain, run in a real VM against the client's own Lua** -- `Model_OnLoad`
 *     and `PaperDollFrame_OnEvent`'s `SetUnit`, both transcribed verbatim from the shipped files. They
 *     RAISED before this round (measured live: `CharacterModelFrame.SetRotation` read `nil`), so the
 *     pane had no rig at all and drew nothing. The assertion is that the unit and the yaw arrive.
 *  2. **The framing arithmetic**, which decides whether the figure is in the frame at all -- and which
 *     no screenshot can attribute, because a cropped figure and a mis-scaled one look alike.
 *
 * Everything else about the booth is verified in a real browser on an ordinary online login, which is
 * where a wrong camera or a wrong V flip is a visibly wrong picture rather than a failing expectation.
 */
import { LuaVM } from '../../framexml/lua/vm';
import { FrameRegistry, installObjectModel } from '../../framexml/lua/object';
import { installCompat } from '../../framexml/lua/compat';
import { createFrameXmlRuntime, loadDocument } from '../../framexml/loader';
import { parseXml } from '../../framexml/xml';
import { WidgetRoot } from '../../widget';
import { bodyFrame, BODY_FOV } from '../booth-framing';
import { verticalFov } from '../scene-rig';

/**
 * `interface/framexml/uiparent.lua:2824-2845`, build 12340, VERBATIM -- the generic model rotation
 * functions -- and `paperdollframe.lua:157-160`'s branch of `PaperDollFrame_OnEvent`.
 *
 * Copied rather than paraphrased for the reason the sibling glue test gives: the point is that these
 * numbers reach the widget without this repository holding a copy of them, so the copy has to live
 * where a reader can see whose it is.
 */
const CLIENT_LUA = `
function Model_OnLoad (self)
	self.rotation = 0.61;
	self:SetRotation(self.rotation);
end

function Model_RotateLeft(model, rotationIncrement)
	if ( not rotationIncrement ) then
		rotationIncrement = 0.03;
	end
	model.rotation = model.rotation - rotationIncrement;
	model:SetRotation(model.rotation);
end

function PaperDollFrame_OnEvent(self, event, unit)
	if ( event == "PLAYER_ENTERING_WORLD" or
		event == "UNIT_MODEL_CHANGED" and unit == "player" ) then
		CharacterModelFrame:SetUnit("player");
		return;
	end
end
`;

function runtime() {
  const vm = new LuaVM();
  installCompat(vm);
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const ctx = installObjectModel(vm, registry);
  return { vm, registry, rt: createFrameXmlRuntime(vm, ctx) };
}

describe("a PlayerModel pane driven by the client's own Lua", () => {
  it('takes its unit from PaperDollFrame_OnEvent and its yaw from Model_OnLoad', () => {
    const { vm, registry, rt } = runtime();

    // The frame as `paperdollframe.xml:460-462` declares it: a `<PlayerModel>` that names no model
    // file at all, because `SetUnit` is what gives this pane its content.
    const report = loadDocument(
      rt,
      parseXml('<Ui><PlayerModel name="CharacterModelFrame"><Size><AbsDimension x="233" y="215"/></Size></PlayerModel></Ui>'),
      () => null,
      'paperdollframe.xml',
    );
    expect(report.errors).toEqual([]);

    expect(vm.run(CLIENT_LUA, 'uiparent.lua')).toBeNull();
    expect(vm.run('Model_OnLoad(CharacterModelFrame)', 'onload')).toBeNull();
    expect(
      vm.run('PaperDollFrame_OnEvent(PaperDollFrame, "PLAYER_ENTERING_WORLD")', 'onevent'),
    ).toBeNull();
    // Two clicks of the rotate button, which is the only thing that moves in a pane.
    expect(vm.run('Model_RotateLeft(CharacterModelFrame)', 'rotate')).toBeNull();

    const rig = registry.widget(registry.byName('CharacterModelFrame')!)!.modelRig!;
    expect(rig.unit).toBe('player');
    // 0.61 minus one 0.03 step, unwrapped and unclamped -- `Model_RotateLeft` does no normalising and
    // neither may `SetRotation`.
    expect(rig.rotation).toBeCloseTo(0.58);
    // No file was ever named: a pane's content is its unit, and `modelPath` staying null is what tells
    // the booth this is not a glue stage.
    expect(rig.modelPath).toBeNull();
  });
});

describe('the pane camera', () => {
  it('keeps feet and crown inside the frame across the player size range', () => {
    // benilla's own test values (`portrait/framing.rs:296-332`): a gnome, a human and a tauren head
    // signal, with a human's footprint.
    const aspect = 233 / 215; // `paperdollframe.xml:461-462`, the pane's authored size
    const halfAngle = 0.5 * verticalFov(BODY_FOV, aspect);

    for (const signal of [0.88, 1.9, 2.6]) {
      const frame = bodyFrame(
        { pivotHeight: signal, headHeight: 0, cameraTargetHeight: 0, groundRadius: 0.35, front: [1, 0], bust: null },
        1,
        aspect,
      );
      // The camera looks along -x at the origin's column, so a point's height above the look target
      // over its distance from the eye is the tangent of its angle off centre -- and |tan| < tan(half)
      // is exactly "inside the frame".
      const ndc = (z: number) => (z - frame.target[2]) / (frame.eye[0] * Math.tan(halfAngle));
      const feet = ndc(0);
      // A conservatively high crown: the throat signal is about 0.9 of standing height, so the top of
      // the head sits a little above it. benilla's own estimate.
      const crown = ndc(1.12 * signal);

      expect(feet).toBeLessThan(0);
      expect(crown).toBeGreaterThan(0);
      expect(Math.abs(feet)).toBeLessThan(0.95);
      expect(crown).toBeLessThan(0.95);
    }
  });
});
