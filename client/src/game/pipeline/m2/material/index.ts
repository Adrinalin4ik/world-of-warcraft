import * as THREE from 'three';

import M2 from '..';
import MapLight from '../../../world/light/MapLight';
import TextureLoader from '../../texture-loader';

// Shader sources are assembled HERE, in JS, rather than with `#pragma glslify: import(...)`.
//
// glslify-import is a source TRANSFORM: it reads the target with `fs` and splices the text in, so the
// spliced files never enter glslify's dependency tree and glslify-loader never calls addDependency for
// them. Webpack therefore does not watch them, and edits to a common chunk do NOT invalidate the
// variant that imports it -- a running dev server keeps serving the stale compiled shader.
//
// That defect silently discarded most of plan 2's WMO shader work. Do not "tidy" this back into
// pragmas.
import fragmentCommonHeader from './fragment/common-header.glsl';
import vertexCommonHeader from './vertex/common-header.glsl';
import vertexCommonMain from './vertex/common-main.glsl';

import vertexDiffuseT1 from './vertex/diffuse-t1.glsl';
import vertexDiffuseT2 from './vertex/diffuse-t2.glsl';
import vertexDiffuseEnv from './vertex/diffuse-env.glsl';
import vertexDiffuseT1T2 from './vertex/diffuse-t1-t2.glsl';
import vertexDiffuseT1Env from './vertex/diffuse-t1-env.glsl';
import vertexDiffuseEnvEnv from './vertex/diffuse-env-env.glsl';
import vertexDiscard from './vertex/discard.glsl';

import fragmentCombinersOpaque from './fragment/combiners-opaque.glsl';
import fragmentCombinersMod from './fragment/combiners-mod.glsl';
import fragmentCombinersOpaqueOpaque from './fragment/combiners-opaque-opaque.glsl';
import fragmentCombinersOpaqueAdd from './fragment/combiners-opaque-add.glsl';
import fragmentCombinersOpaqueAddNA from './fragment/combiners-opaque-addna.glsl';
import fragmentCombinersOpaqueAddAlpha from './fragment/combiners-opaque-addalpha.glsl';
import fragmentCombinersOpaqueAddAlphaAlpha from './fragment/combiners-opaque-addalpha-alpha.glsl';
import fragmentCombinersOpaqueMod from './fragment/combiners-opaque-mod.glsl';
import fragmentCombinersOpaqueMod2x from './fragment/combiners-opaque-mod2x.glsl';
import fragmentCombinersOpaqueMod2xNA from './fragment/combiners-opaque-mod2xna.glsl';
import fragmentCombinersOpaqueMod2xNAAlpha from './fragment/combiners-opaque-mod2xna-alpha.glsl';
import fragmentCombinersModOpaque from './fragment/combiners-mod-opaque.glsl';
import fragmentCombinersModMod from './fragment/combiners-mod-mod.glsl';
import fragmentCombinersModMod2x from './fragment/combiners-mod-mod2x.glsl';
import fragmentDiscard from './fragment/discard.glsl';

/** Prepend the shared fragment header to a combiner variant. */
const assembleFragment = (body: string) => `${fragmentCommonHeader}\n${body}`;

/**
 * Assemble a vertex variant: prepend the shared header, and splice the shared main-body chunk in at
 * the variant's `// GLSLIFY_COMMON_MAIN` marker (it has to sit INSIDE main(), because it declares
 * locals -- `mvPosition`, `transformed`, `skinned` -- that the rest of main() uses).
 */
const assembleVertex = (body: string) => {
  if (!body.includes('// GLSLIFY_COMMON_MAIN')) {
    throw new Error('M2 vertex shader variant is missing its // GLSLIFY_COMMON_MAIN marker');
  }

  return `${vertexCommonHeader}\n${body.replace('// GLSLIFY_COMMON_MAIN', vertexCommonMain)}`;
};

/**
 * The WoW M2 blend-mode -> three.js blend-state mapping, extracted so callers that are NOT
 * `M2Material` (its `defines.BLENDING_MODE` / `uniforms.alphaKey` are specific to its own hand-written
 * combiner shaders) can still get the exact same GL blend factors -- the zone/WMO skybox models
 * (`sky/skybox/model.ts`) are the first of these: their batches carry real M2 `blendingMode` values
 * (modes 2 and 4 observed on Nagrand's `NagrandSkyBox.m2`) and must not re-derive this mapping.
 *
 * Carries the same hard-won fix `M2Material.applyBlendingMode` does: modes >= 1 pin
 * `blendSrcAlpha = ZeroFactor` / `blendDstAlpha = OneFactor` so a draw never writes the framebuffer's
 * alpha channel (see `d348889` and this function's own comment below for why that matters on a
 * premultiplied-alpha canvas composited over the page).
 */
export function applyBlendingModeToMaterial(material: THREE.Material, blendingMode: number): void {
  if (blendingMode >= 1) {
    material.transparent = true;
    material.blending = THREE.CustomBlending;
  }

  switch (blendingMode) {
    case 0:
      material.blending = THREE.NoBlending;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.ZeroFactor;
      break;

    case 1:
      material.alphaTest = 0.5;
      material.side = THREE.DoubleSide;

      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.ZeroFactor;
      material.blendSrcAlpha = THREE.OneFactor;
      material.blendDstAlpha = THREE.ZeroFactor;
      break;

    case 2:
      material.blendSrc = THREE.SrcAlphaFactor;
      material.blendDst = THREE.OneMinusSrcAlphaFactor;
      material.blendSrcAlpha = THREE.SrcAlphaFactor;
      material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      break;

    case 3:
      material.blendSrc = THREE.SrcColorFactor;
      material.blendDst = THREE.DstColorFactor;
      material.blendSrcAlpha = THREE.SrcAlphaFactor;
      material.blendDstAlpha = THREE.DstAlphaFactor;
      break;

    case 4:
      material.blendSrc = THREE.SrcAlphaFactor;
      material.blendDst = THREE.OneFactor;
      material.blendSrcAlpha = THREE.SrcAlphaFactor;
      material.blendDstAlpha = THREE.OneFactor;
      break;

    case 5:
      material.blendSrc = THREE.DstColorFactor;
      material.blendDst = THREE.ZeroFactor;
      material.blendSrcAlpha = THREE.DstAlphaFactor;
      material.blendDstAlpha = THREE.ZeroFactor;
      break;

    case 6:
      material.blendSrc = THREE.DstColorFactor;
      material.blendDst = THREE.SrcColorFactor;
      material.blendSrcAlpha = THREE.DstAlphaFactor;
      material.blendDstAlpha = THREE.SrcAlphaFactor;
      break;

    default:
      break;
  }

  // Emulate the reference's OPAQUE backbuffer: keep every mode's RGB factors exactly as authored
  // above, but never let a draw touch the framebuffer's ALPHA channel, so it stays at the cleared
  // 1.0 across the whole frame.
  //
  // Why this is needed at all: a browser canvas is composited over the page, and three.js requests
  // `alpha: true` for the context unconditionally (its own `alpha` parameter only chooses the clear
  // alpha), with `premultipliedAlpha: true`. So the compositor reads our NON-premultiplied output as
  // premultiplied and adds `(1 - a)` of whatever is behind the canvas -- nothing here, so white.
  // Any fragment that leaves sub-1 alpha in the buffer gets a bright halo.
  //
  // It stayed hidden while `assignShaders` forced `Combiners_Opaque` on every M2, because that
  // writes `result.a = vertexColor.a` (effectively 1). The authored combiners write real texture
  // alpha -- `Combiners_Mod` is `sampled0.a * vertexColor.a * animatedTransparency` -- and mode 1
  // (alpha key) had `blendSrcAlpha` One / `blendDstAlpha` Zero, which stores it verbatim. Alpha
  // testing keeps every edge texel in [0.5, 1], so all of Elwynn's foliage gained a white fringe.
  //
  // Zero/One fixes the whole class rather than foliage alone: the genuinely blended modes (2, 4, 6 --
  // waterfalls, spell effects) mirrored their RGB factors into alpha and left sub-1 values behind
  // too. Mode 0 is `NoBlending`, which ignores these factors and writes the shader's alpha directly;
  // it is left as-is because `Combiners_Opaque` is the only combiner that pairs with it and its
  // alpha is already 1.
  if (blendingMode >= 1) {
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
  }
}

class M2Material extends THREE.ShaderMaterial {

  private mapLight: MapLight | null = null;

  static VERTEX_SHADERS = {
    'Diffuse_T1': assembleVertex(vertexDiffuseT1),
    'Diffuse_T2': assembleVertex(vertexDiffuseT2),
    'Diffuse_Env': assembleVertex(vertexDiffuseEnv),
    'Diffuse_T1_T2': assembleVertex(vertexDiffuseT1T2),
    'Diffuse_T1_Env': assembleVertex(vertexDiffuseT1Env),
    'Diffuse_Env_Env': assembleVertex(vertexDiffuseEnvEnv),
    'Discard': vertexDiscard
  };

  static FRAGMENT_SHADERS = {
    'Combiners_Opaque': assembleFragment(fragmentCombinersOpaque),
    'Combiners_Mod': assembleFragment(fragmentCombinersMod),
    'Combiners_Opaque_Opaque': assembleFragment(fragmentCombinersOpaqueOpaque),
    'Combiners_Opaque_Add': assembleFragment(fragmentCombinersOpaqueAdd),
    'Combiners_Opaque_AddNA': assembleFragment(fragmentCombinersOpaqueAddNA),
    'Combiners_Opaque_AddAlpha': assembleFragment(fragmentCombinersOpaqueAddAlpha),
    'Combiners_Opaque_AddAlpha_Alpha': assembleFragment(fragmentCombinersOpaqueAddAlphaAlpha),
    'Combiners_Opaque_Mod': assembleFragment(fragmentCombinersOpaqueMod),
    'Combiners_Opaque_Mod2x': assembleFragment(fragmentCombinersOpaqueMod2x),
    'Combiners_Opaque_Mod2xNA': assembleFragment(fragmentCombinersOpaqueMod2xNA),
    'Combiners_Opaque_Mod2xNA_Alpha': assembleFragment(fragmentCombinersOpaqueMod2xNAAlpha),
    'Combiners_Mod_Opaque': assembleFragment(fragmentCombinersModOpaque),
    'Combiners_Mod_Mod': assembleFragment(fragmentCombinersModMod),
    'Combiners_Mod_Mod2x': assembleFragment(fragmentCombinersModMod2x),
    'Discard': fragmentDiscard
    /*
    'Combiners_Mod':              'frag/mod.frag',
    'Combiners_Decal':            'frag/decal.frag',
    'Combiners_Add':              'frag/add.frag',
    'Combiners_Mod2x':            'frag/mod2x.frag',
    'Combiners_Fade':             'frag/fade.frag',
    'Combiners_Opaque_Opaque':    'frag/opaque-opaque.frag',
    'Combiners_Opaque_Mod':       'frag/opaque-mod.frag',
    'Combiners_Opaque_Add':       '',
    'Combiners_Opaque_Mod2x':     9,
    'Combiners_Opaque_Mod2xNA':   10,
    'Combiners_Opaque_AddNA':     11,
    'Combiners_Mod_Opaque':       12,
    'Combiners_Mod_Mod':          13
    'Combiners_Mod_Add':          14,
    'Combiners_Mod_Mod2x':        15,
    'Combiners_Mod_Mod2xNA':      16,
    'Combiners_Mod_AddNA':        17,
    'Combiners_Add_Mod':          18,
    'Combiners_Mod2x_Mod2x':      19
    */
  };

  m2: M2;
  layer;
  skins = {
    skin1: null,
    skin2: null,
    skin3: null,
    /**
     * Texture type 1 -- the character BODY skin, supplied at runtime like `skin1..3` are.
     *
     * Kept in the same bag rather than a field of its own because it answers the same question those
     * three do: a `textureDef` whose `type` is non-zero names a slot the FILE leaves blank and the
     * runtime fills.
     *
     * A PATH **OR** A `THREE.Texture`, and both are real cases. The real client's type-1 slot holds a
     * COMPOSITE of skin + face + facial hair + scalp + underwear (+ armour), which
     * `ui/scene/body-composite.ts` bakes on the CPU into a `DataTexture` the caller owns -- there is
     * no file to name, so `loadTextures` binds it straight into the slot instead of asking
     * `TextureLoader` for it. A string still works and is the fallback for a bake that could not
     * happen (see `resolveTexturePath`).
     */
    body: null,
    /**
     * Texture type 6 -- the character HAIR sheet.
     *
     * Measured which geometry actually reads which type, by walking `humanmale02.skin`'s 63 batches
     * through `textureLookups` into the `.m2`'s four texture defs (types 1, 6, 0, 2):
     *
     *   type 1 -> geosets 0 1 4 5 9 10 16 18 101 102 201 202 301 302 401..404 501..505 701 702
     *             802 803 902 903 1002 1102 1104 1202 1301 1302 1501 1802
     *   type 6 -> geosets 2..18            (group 0's hairstyles -- the HAIR mesh)
     *   type 2 -> geosets 1502..1506       (group 15's cloaks)
     *   type 0 -> geoset 1703              (the hardcoded DK eye glow)
     *
     * The `.m2`'s own `replacable_texture_lookup` array agrees independently: 7 entries indexed BY
     * texture type, `[2, 0, 3, -1, -1, -1, 1]`, i.e. type 1 -> slot 0, type 2 -> slot 3,
     * type 6 -> slot 1, type 0 -> slot 2. Two readings of the same file, same answer.
     *
     * Note the overlap: geosets 4, 5, 9, 10, 16 and 18 appear under BOTH types, because those
     * hairstyles ship as two submeshes with the same partID -- a scalp piece drawn with the body
     * atlas and a hair piece drawn with this sheet. Selecting the geoset shows both, which is what
     * the real client does.
     *
     * Supplied from `CharSections` BaseSection 3 `TextureName[0]` -- see `character-look.ts`.
     *
     * TYPE 8 EXISTS TOO and is not handled: `taurenfemale.m2`'s texture defs are types
     * 8, 1, 0, 2, and its type-8 slot is read by geoset 0 (the body) and geosets 202..205. Measured
     * supplier: `CharSections` BaseSection 0 `TextureName[1]`, e.g.
     * `Character\Tauren\Female\TaurenFemaleSkin00_00_Extra.blp`. So a Tauren draws part of its body
     * unbound today. No Tauren is on the test roster, so this is reported rather than written blind.
     */
    hair: null,
    /**
     * Texture type 2 -- the CLOAK sheet, and now real because the thing that made it unreachable is
     * gone. The note that used to stand here said type 2 was deliberately unhandled since "a
     * character with no cloak equipped never shows [1502..1506], and its supplier is
     * `ItemDisplayInfo` (the equipment piece)". That piece is here: the cloak geoset branch
     * (`ui/scene/character-equipment.ts`, B8) now enables 1501+v, so the consumer is reachable, and
     * without this slot it would draw the shared `PLACEHOLDER` -- a flat cape.
     *
     * Supplied from the BACK slot's `ItemDisplayInfo.leftModelTexture` as
     * `Item\ObjectComponents\Cape\<name>.blp` -- verified fetchable on the live host
     * (`cape_mage_a_01black.blp`, 206 on a range request, 128x256). Note it is **DXT**, unlike every
     * character-owned BLP measured: that is fine here and only here, because this texture goes to the
     * GPU through `TextureLoader` rather than through the CPU blit, so the loader's
     * leave-DXT-compressed default is exactly right for it.
     *
     * The cape MESH is a body geoset, not an attachment, which is why it belongs to the equipment
     * piece rather than to piece 9 -- what piece 9 owns is the shoulder/helm/weapon sub-models.
     */
    cape: null,
  };
  textures = [];
  textureDefs;
  /** Which animated-channel slots this batch reads. See the constructor. */
  animationDef: {
    uvAnimationIndices: number[];
    transparencyAnimationIndex: number;
    vertexColorAnimationIndex: number;
  };
  shaderNames = {
    vertex: null,
    fragment: null,
  };
  constructor(m2, def) {
    super();
    // if (def.useSkinning) {
    //   super({ skinning: true });
    // } else {
    //   super({ skinning: false });
    // }

    this.m2 = m2;

    this.layer = def.layer;

    this.uniforms = {
      textureCount: { value: 0 },
      textures: { value: [] },

      billboarded: { value: 0.0 },

      // Animated vertex colors
      animatedVertexColorRGB: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
      animatedVertexColorAlpha: { value: 1.0 },

      // Animated transparency
      animatedTransparency: { value: 1.0 },

      // Per-object distance-fade alpha (fade/laws.ts). 1.0 until a doodad enters its fade band.
      fadeAlpha: { value: 1.0 },

      // Animated texture coordinate transform matrices
      animatedUVs: {
        value: [
          new THREE.Matrix4(),
          new THREE.Matrix4(),
          new THREE.Matrix4(),
          new THREE.Matrix4()
        ]
      },

      // WMO point lights (MOLT) affecting this model, in world space. Assigned by the WMO that owns
      // the doodad; models outside a WMO keep a count of zero and skip the loop entirely.
      wmoLightCount: { value: 0 },
      wmoLightPosition: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      wmoLightColor: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color()] },

      // Managed by light manager
      sunParams: { value: new THREE.Vector4() },
      sunDiffuseColor: { value: new THREE.Color() },
      sunAmbientColor: { value: new THREE.Color() },

      fogParams: { value: new THREE.Vector4() },
      fogColor: { value: new THREE.Color() },

      // The interior fog triple (MapLight's resolved camera-in-WMO-room haze), pulled the same way
      // the WMO material does. Only consumed when `interiorFog` (below) is set for this draw --
      // defaults here just keep the material sane before the first `updateLightUniforms()` call.
      wmoFogParams: { value: new THREE.Vector4(1.0 / 577.0, 577.0, 1.0, 1.0) },
      wmoFogColor: { value: new THREE.Color(0.25, 0.5, 0.8) },

      // Cleared by render flag 0x02 (unfogged). Declared here so fogged materials -- the majority --
      // have it set: applyRenderFlags only ever assigned it for the unfogged case, and a uniform the
      // shader declares but nobody supplies reads as zero, which would have unfogged everything.
      fogModifier: { value: 1.0 },

      materialParams: { value: [1,1,1,1] },

      // The per-object block (per-object-light.ts). Declared with safe defaults: a uniform the shader
      // reads but nobody supplies reads as zero, and for `sunIntensity` that would flatten the sun.
      sunIntensity: { value: 1.0 },
      interiorProbe: { value: 0 },
      // Per-object, pushed by per-object-light.ts alongside interiorProbe -- but a SEPARATE question
      // from it (see PerObjectLighting.interiorFog). Selects the interior fog triple above instead of
      // the scene triple in applyFog.
      interiorFog: { value: 0 },
      // A flat Float32Array of 7 vec4s. See per-object-light.ts for why this is not Vector4[].
      probeCoeffs: { value: new Float32Array(28) },
    };

    this.defines.MAX_BONES = 200;
    this.defines.USE_LIGHTING = 1;
    
    this.applyRenderFlags(def.renderFlags);
    this.applyBlendingMode(def.blendingMode);

    this.assignShaders(def.shaderNames);

    // Loaded by calling updateSkinTextures()

    this.textureDefs = def.textures;
    this.loadTextures();

    // The three `register*Animation` subscription helpers that used to run here are gone. They
    // pushed closures onto an EventEmitter owned by the shared AnimationManager (the `.on('update')`
    // calls had already been commented out, leaving them inert), which is precisely the binding
    // model this refactor removes.
    //
    // What replaces them is a per-draw push (`applyAnimatedUniformsBeforeRender` in `m2/submesh.js`)
    // of the DRAWN placement's value slots. All this material keeps is which slots its batch reads:
    // it is shared across every placement, so it cannot hold any placement's values itself.
    //
    // `?? -1` rather than a truthiness test on purpose -- `BatchManager.stubDef()` leaves both
    // indices `null` when the batch has no such animation, and `null >= 0` is TRUE in JS.
    this.animationDef = {
      uvAnimationIndices: def.uvAnimationIndices || [],
      transparencyAnimationIndex: def.transparencyAnimationIndex ?? -1,
      vertexColorAnimationIndex: def.vertexColorAnimationIndex ?? -1,
    };
  }

  enableBillboarding() {
    // TODO: Make billboarding happen in the vertex shader.
    this.uniforms.billboarded = { value: '1.0' };

    // TODO: Shouldn't this be FrontSide? Billboarding logic currently seems to flips the mesh
    // backward.
    this.side = THREE.DoubleSide;
  }

  applyRenderFlags(renderFlags) {
    // Flag 0x01 (unlit)
    if (renderFlags & 0x01) {
      // `materialParams.y`, because that is the switch the shader actually reads:
      // `light = mix(light, vec3(1.0), 1.0 - materialParams.y)`. At y = 0 the light term becomes
      // white and the batch renders unlit.
      //
      // This used to assign `uniforms.lightModifier = { value: '0.0' }` -- a uniform the fragment
      // header declares but nothing reads, and a STRING where a float belongs. So the unlit flag has
      // never done anything: every flagged batch (glows, eyes, spell effects, anything the reference
      // lights not at all) has been taking the full sun and the full day/night ramp.
      this.uniforms.materialParams.value[1] = 0.0;
    }

    // Flag 0x02 (unfogged). Numeric, not the string '0.0' this used to assign -- and the shader now
    // actually reads it. Torch flames and glow billboards carry this flag, and ignoring it is what let
    // fog tint them.
    if (renderFlags & 0x02) {
      this.uniforms.fogModifier.value = 0.0;
    }

    // Flag 0x04 (no backface culling)
    if (renderFlags & 0x04) {
      this.side = THREE.DoubleSide;
      this.transparent = true;
    }

    // Flag 0x10 (no z-buffer write)
    if (renderFlags & 0x10) {
      this.depthWrite = false;
    }
  }

  applyBlendingMode(blendingMode) {
    this.defines.BLENDING_MODE = blendingMode;

    if (blendingMode === 1) {
      this.uniforms.alphaKey = { value: 1.0 };
    } else {
      this.uniforms.alphaKey = { value: 0.0 };
    }

    applyBlendingModeToMaterial(this, blendingMode);
  }

  assignShaders(shaderNames) {
    /*
    let vertex, fragment;

    if (!shaderNames) {
      // TODO: warn somehow?
      console.log('missing shader names, assigning defaults');

      vertex = 'Diffuse_T1';
      fragment = 'Combiners_Opaque';
    } else {
      vertex = shaderNames.vertex;
      fragment = shaderNames.fragment;
    }

    this.shaderNames = {
      vertex: vertex,
      fragment: fragment
    };
    */

    this.shaderNames = shaderNames;

    if (this.shaderNames) {
      this.vertexShader = M2Material.VERTEX_SHADERS[shaderNames.vertex];
      this.fragmentShader = M2Material.FRAGMENT_SHADERS[shaderNames.fragment];

      // Warn about a missing VERTEX shader too, not just a missing fragment one. EITHER miss is fatal
      // to the frame, not to the batch: an unresolved name leaves the field `undefined`, and
      // `WebGLProgram` calls `resolveIncludes` on both of them (three 0.185.1,
      // `build/three.cjs:67002` and `:67006`), which does `.replace` on the string. So the throw
      // aborts the whole `sceneView.render()` traversal. That is why `screens.ts` wraps the stage pass
      // at all.
      //
      // (An earlier version of this comment said three "silently substitutes its own" for a missing
      // fragment shader. It does not -- `ShaderMaterial`'s defaults are overwritten by the assignments
      // just above, so there is nothing left to fall back to. Checked in three's source, not assumed.)
      //
      // `Diffuse_T2` was in exactly that state -- named by `shaderNamesFromSingleOpTable`, absent
      // from `VERTEX_SHADERS` -- and it took a GL driver error on an unrelated code path to find it.
      // It is present now (`vertex/diffuse-t2.glsl`), and a measured sweep of all eleven `UI_*` glue
      // stages says nothing they load names any other absent vertex or fragment shader. The warns
      // stay: character and item models will widen the sample of batch flags this pipeline has seen,
      // and this pair of lines is the only thing that will say so.
      if (!M2Material.FRAGMENT_SHADERS[shaderNames.fragment]) {
        console.warn('MISSING FRAGMENT SHADER FOR M2: ', this.m2.name, this.shaderNames.fragment);
      }

      if (!M2Material.VERTEX_SHADERS[shaderNames.vertex]) {
        console.warn('MISSING VERTEX SHADER FOR M2: ', this.m2.name, this.shaderNames.vertex);
      }
    } else {
      this.vertexShader = M2Material.VERTEX_SHADERS['Discard'];
      this.fragmentShader = M2Material.FRAGMENT_SHADERS['Discard'];
    }
  }

  loadTextures() {
    const textureDefs = this.textureDefs;

    const textures = [];

    textureDefs.forEach((textureDef, index) => {
      // A slot the runtime supplies as a TEXTURE rather than as a path -- today only the composited
      // body skin (type 1). It is bound directly and deliberately NOT put through `TextureLoader`:
      // the loader is a path->texture cache with reference counting, and a texture that was never
      // fetched from a path has no key in it to count. Its owner is `body-composite.ts`'s cache, which
      // is also the only thing that may dispose it -- so this assignment adds no reference to leak.
      const supplied = this.resolveSuppliedTexture(textureDef);
      if (supplied) {
        textures[index] = supplied;
        return;
      }

      const path = this.resolveTexturePath(textureDef);

      if (!path) {
        textures[index] = null;
        return;
      }

      // Claim the slot so `textureCount` and the uniform array keep their shape; the entry is
      // replaced in place once the texture has been fetched and decoded.
      textures[index] = TextureLoader.PLACEHOLDER;

      TextureLoader.load(path, THREE.RepeatWrapping, THREE.RepeatWrapping)
        .then((texture) => {
          textures[index] = texture;
        })
        .catch((error) => {
          console.error(`Failed to load M2 texture ${path}:`, error);
        });
    });

    this.textures = textures;

    // Update shader uniforms to reflect loaded textures.
    this.uniforms.textures = { value: textures };
    this.uniforms.textureCount = { value: textures.length };
  }

  /**
   * The runtime slots that may be supplied as a ready THREE texture instead of a path. Only type 1
   * (the composited body skin) is, and only when the caller passed a texture; a string body falls
   * through to `resolveTexturePath` below.
   */
  resolveSuppliedTexture(textureDef) {
    if (textureDef.type === 1 && this.skins.body && this.skins.body.isTexture) {
      return this.skins.body;
    }
    return null;
  }

  resolveTexturePath(textureDef) {
    let path = null;

    switch (textureDef.type) {
      case 0:
        // Hardcoded texture
        path = textureDef.filename;
        break;

      case 1:
        // The character body skin, as a PATH. Normally this slot is handed the composited atlas as a
        // texture and never reaches here (`resolveSuppliedTexture`); a string arrives only as the
        // fallback for a bake that could not happen, and then it is the raw base skin --
        // `CharSections` BaseSection 0 `TextureName[0]`, e.g.
        // `Character\Human\Male\HumanMaleSkin00_00.blp`, measured 512x512 palettized. That draws a
        // body whose face and pelvis tiles are the blank regions the file ships with.
        if (this.skins.body) {
          path = this.skins.body;
        }
        break;

      case 2:
        // The character cloak sheet -- geosets 1502..1506 only. See `skins.cape`.
        if (this.skins.cape) {
          path = this.skins.cape;
        }
        break;

      case 6:
        // The character hair sheet. See `skins.hair` for the measurement of which geosets read it.
        if (this.skins.hair) {
          path = this.skins.hair;
        }
        break;

      case 11:
        if (this.skins.skin1) {
          path = this.skins.skin1;
        }
        break;

      case 12:
        if (this.skins.skin2) {
          path = this.skins.skin2;
        }
        break;

      case 13:
        if (this.skins.skin3) {
          path = this.skins.skin3;
        }
        break;

      default:
        break;
    }

    return path;
  }

  updateSkinTextures(skin1, skin2, skin3) {
    this.skins.skin1 = skin1;
    this.skins.skin2 = skin2;
    this.skins.skin3 = skin3;

    this.loadTextures();
  }

  /**
   * Supply the character slots -- texture type 1 (body), type 6 (hair) and type 2 (cloak). Same shape
   * as `updateSkinTextures`, and the same single reload.
   *
   * ONE CALL FOR ALL THREE, deliberately, and not three setters: `loadTextures()` takes a fresh
   * `TextureLoader` reference for every def it walks and does NOT release the array it replaces
   * (`TextureLoader.unload` keys off a resolved texture's `textureKey`, which a slot still showing
   * `PLACEHOLDER` does not have, so the release cannot be done from the array alone). Every extra
   * `loadTextures()` therefore pins one more reference on every texture this material holds. Three
   * setters would have tripled that; one keeps it at the one call the type-1 slot already cost.
   * The residual over-reference is pre-existing and is NOT fixed here -- it needs `loadTextures` to
   * track paths rather than textures, in the shared pipeline, which is not this milestone. The cloak
   * joining this call rather than getting its own is that constraint honoured, not a convenience.
   */
  updateCharacterTextures(body, hair, cape) {
    this.skins.body = body;
    this.skins.hair = hair;
    this.skins.cape = cape;

    this.loadTextures();
  }

  dispose() {
    super.dispose();

    this.textures.forEach((texture) => {
      // Only textures this material took THROUGH the loader may be released to it. A `textureKey` is
      // what `TextureLoader.load` stamps on, so its absence marks the two kinds it never issued: the
      // shared `PLACEHOLDER`, and a runtime-supplied texture such as the composited body skin, whose
      // owner is `body-composite.ts`'s cache. Unloading either used to push `undefined` into
      // `pendingUnload` and decrement a reference count that does not exist.
      if (!texture?.textureKey) {
        return;
      }
      TextureLoader.unload(texture);
    });
  }

  // `setFadeAlpha(alpha)` used to sit here. Deleted, not deprecated: it had zero callers, and it
  // wrote `uniforms.fadeAlpha.value` WITHOUT raising `uniformsNeedUpdate`, which is the one dirty-
  // flag invariant Task 14 established (`submesh.js#applyUniformsBeforeRender` documents why a bare
  // `.value` write never reaches the GPU for a shared material). Keeping a public setter that
  // silently breaks it is a loaded gun. The live path is the per-draw push in
  // `submesh.js#applyFadeAlphaBeforeRender`, which reports whether it changed anything so the caller
  // can raise the flag once for both pushes.

  /**
   * Set the map light system
   */
  setMapLight(mapLight: MapLight): void {
    this.mapLight = mapLight;
    this.updateLightUniforms();
  }

  /**
   * Update light uniforms from the map light system
   */
  updateLightUniforms(): void {
    if (this.mapLight) {
      const uniforms = this.mapLight.uniforms;
      this.uniforms.fogParams.value.copy(uniforms.fogParams.value);
      this.uniforms.fogColor.value.copy(uniforms.fogColor.value);
      this.uniforms.wmoFogParams.value.copy(uniforms.wmoFogParams.value);
      this.uniforms.wmoFogColor.value.copy(uniforms.wmoFogColor.value);
      // World-space sun direction: this shader lights against worldVertexNormal. `uniforms.sunDir`
      // carries the view-space variant, which rotates with the camera.
      this.uniforms.sunParams.value.copy(this.mapLight.sunDir);
      this.uniforms.sunDiffuseColor.value.copy(uniforms.sunDiffuseColor.value);
      this.uniforms.sunAmbientColor.value.copy(uniforms.sunAmbientColor.value);
    }
  }
}

export default M2Material;



