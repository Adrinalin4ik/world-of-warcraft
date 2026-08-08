/**
 * The MODEL surface, driven by the client's own `SetLighting`.
 *
 * TWO happy-path tests and no more, by the project owner's standing budget, spent on the two ways a
 * model frame's state actually arrives in this client:
 *
 *  1. **From Lua**, through `SetLighting(model, race)` -- which is `glueparent.lua:327-372`
 *     transcribed VERBATIM into the test below, tables and all, and then run against a real
 *     `<ModelFFX>` in a real Lua VM. That is the whole chain this piece of work exists to close: the
 *     fog, glow and light numbers used to be hand-copied into `scene/scene-rig.ts` while this function
 *     executed into thirteen warn-once no-ops. The assertion is that the numbers the client's own
 *     tables carry come out the other end on the widget.
 *  2. **From XML**, through `<ModelFFX fogNear= fogFar= glow=>` plus its `<FogColor>` child -- the
 *     login screen's own authored fog, which no Lua ever sets.
 *
 * Everything else about this change is verified in a real browser against the client's own
 * `GlueXML.toc`, which is where a defect in it would actually show up -- and where a wrong rig would
 * be a visibly wrong picture rather than a failing expectation.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { installCompat } from '../lua/compat';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';
import { rigFog, rigLightRows } from '../../scene/scene-rig';
import { packFogParams } from '../../../world/light/fog';

const noFiles = () => null;

/**
 * `interface/gluexml/glueparent.lua`, build 12340, VERBATIM: `LIGHT_LIVE` (:97), the `HUMAN` rows of
 * `CharModelFogInfo` (:21), `CharModelGlowInfo` (:32) and `RaceLights` (:51-55), and the whole of
 * `SetLighting` (:327-372).
 *
 * Copied rather than paraphrased on purpose. The point of the test is that these numbers reach the
 * widget without this repository holding a copy of them, so the copy has to live where a reader can
 * see it is the client's -- in the fixture, next to the line numbers, and not in `client/src`.
 */
const GLUEPARENT = `
LIGHT_LIVE = 0;
LIGHT_GHOST = 1;

CharModelFogInfo = { };
CharModelFogInfo["HUMAN"] = { r=0.8, g=0.65, b=0.73, far=222 };

CharModelGlowInfo = { };
CharModelGlowInfo["HUMAN"] = 0.15;

RaceLights = {
    HUMAN =  {
        {1,     0,  0.000000,       0.000000,       -1.000000,   1.0,   0.27,       0.27,       .27,        1.0,    0,          0,          0},
        {1,     0,  -0.45756075,    -0.58900136,    -0.66611975, 1.0,   0.000000,   0.000000,   0.000000,   1.0,    0.19882353, 0.34921569, 0.43588236 },
        {1,     0,  -0.64623469,    0.57582057,     -0.50081086, 1.0,   0.000000,   0.000000,   0.000000,   2.0,    0.52196085, 0.44,       0.29764709 },
    },
};

function SetLighting(model, race)
	model:SetSequence(0);
	model:SetCamera(0);
	local fogInfo = CharModelFogInfo[race];
	if ( fogInfo ) then
		model:SetFogColor(fogInfo.r, fogInfo.g, fogInfo.b);
		model:SetFogNear(0);
		model:SetFogFar(fogInfo.far);
	else
		model:ClearFog();
    end

    local glowInfo = CharModelGlowInfo[race];
    if ( glowInfo ) then
        model:SetGlow(glowInfo);
    else
        model:SetGlow(0.3);
    end

    model:ResetLights();
	local LightValues = RaceLights[race];
	if(LightValues) then
		for index, Array in pairs (LightValues) do
			if (Array[1]==1) then
				for j, f in pairs ({model.AddCharacterLight, model.AddLight, model.AddPetLight }) do
					f(model, LIGHT_LIVE, unpack(Array));
				end
			end
		end
	end
end
`;

/**
 * A runtime with the object model installed, as `framexml/runtime.ts` builds one.
 *
 * `installCompat` is not optional here and that is a real finding rather than test scaffolding:
 * `SetLighting`'s inner loop is the ONE `unpack(` call in the whole glue manifest (`lua/compat.ts`
 * says so in its own header), and fengari is 5.3, where `unpack` is `table.unpack`. Without the compat
 * layer the function raises on its 44th line and not one light reaches the frame.
 */
function runtime() {
  const vm = new LuaVM();
  installCompat(vm);
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const ctx = installObjectModel(vm, registry);
  return { vm, registry, rt: createFrameXmlRuntime(vm, ctx) };
}

describe("a MODEL frame driven by the client's own Lua", () => {
  it("carries every number SetLighting(CharacterSelect, 'HUMAN') pushes at it", () => {
    const { vm, registry, rt } = runtime();

    // The frame as `characterselect.xml:153` declares it: a `<ModelFFX>` with no fog attributes at
    // all, because `SetLighting` is what gives this screen its fog.
    const report = loadDocument(
      rt,
      parseXml('<Ui><ModelFFX name="CharacterSelect" hidden="true"/></Ui>'),
      noFiles,
      'characterselect.xml',
    );
    expect(report.errors).toEqual([]);

    expect(vm.run(GLUEPARENT, 'glueparent.lua')).toBeNull();
    expect(vm.run('SetLighting(CharacterSelect, "HUMAN")', 'call')).toBeNull();

    const rig = registry.widget(registry.byName('CharacterSelect')!)!.modelRig!;

    // `SetSequence(0)` / `SetCamera(0)` -- a FILE SLOT and a camera TABLE index, both 0 here.
    expect(rig.sequence).toBe(0);
    expect(rig.camera).toBe(0);
    // The three independent fog calls landing on one triple, `CharModelFogInfo.HUMAN` exactly.
    expect(rig.fog!.color[0]).toBeCloseTo(0.8);
    expect(rig.fog!.color[1]).toBeCloseTo(0.65);
    expect(rig.fog!.color[2]).toBeCloseTo(0.73);
    expect(rig.fog!.near).toBe(0);
    expect(rig.fog!.far).toBe(222);
    expect(rigFog(rig).params).toEqual(packFogParams(0, 222));
    // `CharModelGlowInfo.HUMAN`, not `SetLighting`'s 0.3 fallback -- the row exists for this race.
    expect(rig.glow).toBeCloseTo(0.15);

    // NINE lights: three enabled rows x the three sets `SetLighting` adds each row to
    // (`AddCharacterLight`, `AddLight`, `AddPetLight`, glueparent.lua:367). `ResetLights()` ran first,
    // so nothing survives from before it.
    expect(rig.lights).toHaveLength(9);
    expect(rig.lights.map((light) => light.set).filter((set) => set === 'background')).toHaveLength(3);
    expect(rig.lights.every((light) => light.liveness === 0)).toBe(true);

    // THE ARGUMENT SHIFT this pins, and the one a wrong reading would silently survive: the light SET
    // is the first argument and the 13-number row follows it, so `row[0]` is the ENABLED flag and
    // `row[10..12]` is the diffuse colour. Read from index 0 instead and every direction would land in
    // the enabled slot -- a rig folded one channel out of step, which still renders.
    //
    // UNORDERED, and that is a finding rather than a concession. `SetLighting` walks its rows with
    // `pairs`, whose order Lua does not specify, and fengari really does hand these three back in a
    // different order than the file lists them (it yields the warm key row first). Harmless -- the
    // fold is a sum over rows -- but an ordered expectation here would have failed for the wrong
    // reason, and any consumer that ever cares about row order has to sort them itself.
    const background = rigLightRows(rig);
    expect(background).toHaveLength(3);
    expect(background).toContainEqual([1, 0, 0, 0, -1, 1, 0.27, 0.27, 0.27, 1, 0, 0, 0]);
    const warmKey = background.find((row) => row[9] === 2)!; // the only row at diffuse INTENSITY 2
    expect(warmKey[10]).toBeCloseTo(0.52196085);
    expect(warmKey[11]).toBeCloseTo(0.44);
    expect(warmKey[12]).toBeCloseTo(0.29764709);

    vm.dispose();
  });

  it("carries the login screen's fog from its own XML, attributes and <FogColor> child alike", () => {
    const { vm, registry, rt } = runtime();

    // `accountlogin.xml:93` and `:2501`, which are 2408 lines apart in the real document -- the
    // attributes on the open tag and the colour as the last child before `</ModelFFX>`. A previous pass
    // read only the open tag and recorded that no colour was authored; it is.
    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <ModelFFX name="AccountLogin" hidden="true" fogNear="0" fogFar="1200" glow="0.08">
            <FogColor r="0.25" g="0.06" b="0.015"/>
          </ModelFFX>
        </Ui>
      `),
      noFiles,
      'accountlogin.xml',
    );
    expect(report.errors).toEqual([]);

    // `AccountLogin_OnLoad`'s own two lines plus its model (accountlogin.lua:29-30,36).
    expect(
      vm.run(
        'AccountLogin:SetCamera(0); AccountLogin:SetSequence(0);' +
          'AccountLogin:SetModel("Interface\\\\Glues\\\\Models\\\\UI_MainMenu_Northrend\\\\UI_MainMenu_Northrend.m2")',
        'accountlogin.lua',
      ),
    ).toBeNull();

    const rig = registry.widget(registry.byName('AccountLogin')!)!.modelRig!;

    expect(rig.modelPath).toBe(
      'Interface\\Glues\\Models\\UI_MainMenu_Northrend\\UI_MainMenu_Northrend.m2',
    );
    // `SetFogNear`/`SetFogFar` materialize the triple on a frame that had none, and the `<FogColor>`
    // child fills the colour in afterwards. Without the first half, the only fog this screen authors
    // would be dropped for want of a colour.
    expect(rig.fog!.near).toBe(0);
    expect(rig.fog!.far).toBe(1200);
    expect(rig.fog!.color[0]).toBeCloseTo(0.25);
    expect(rig.fog!.color[1]).toBeCloseTo(0.06);
    expect(rig.fog!.color[2]).toBeCloseTo(0.015);
    expect(rig.glow).toBeCloseTo(0.08);
    // The login screen never calls `SetLighting`, so it issues no `AddLight` -- which is what sends
    // `glue-scene.ts#pickLightRows` to the model's own directionals.
    expect(rigLightRows(rig)).toEqual([]);

    vm.dispose();
  });
});
