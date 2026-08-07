# Drawing the player character — research findings

**Date:** 2026-08-07
**Status:** Research complete. No code changed. Input to a design conversation.
**Question:** what would it actually take to draw the player character on the glue stage, and later in
the world?

Everything below is measured. DBC field layouts, geoset ids, texture dimensions and dial counts were
read out of the live host (`https://data-direct.spelunkerdb.com/12340`) with `curl` plus a throwaway
WDBC reader; code claims carry file and line. Where a claim could not be settled by measurement it is
in §6 as a named unknown, not smoothed over.

---

## 0. The one-paragraph answer

Almost all the hard machinery already exists. The M2 pipeline is **not** a static-mesh pipeline: bone
hierarchies, keyframe sampling, the M2 pivot law, GPU vertex skinning, external `.anim` merging and a
creature DBC→model→animation driver are all live and in production use. What is missing is
specifically the *character* layer: **geoset selection** (parsed, never read), **runtime texture slots
1/2/6** (fall to `null`), and a **layered texture compositor** (no substrate at all — there is not one
`WebGLRenderTarget` in the client). Six DBCs are needed; five already have correct schemas and are
simply never loaded; one (`HelmetGeosetVisData`) is new. The glue Lua turns out to be nearly free —
the client's own `characterselect.lua` hands the engine a frame name and gets out of the way.

---

## 1. What the M2 pipeline can already do

### 1.1 Skeletal animation — EXISTS, GPU-skinned, in production

| Piece | Where |
|---|---|
| `Bone` struct (`keyBoneID`, `flags`, `parentID`, 3 animation blocks, `pivotPoint`) | [`wow-data-parser/m2/index.js:27-69`](../../../client/src/wow-data-parser/m2/index.js) |
| `boneWeights`/`boneIndices` (4× uint8) on every vertex | [`wow-data-parser/m2/index.js:83-89`](../../../client/src/wow-data-parser/m2/index.js) |
| Bone hierarchy + engine-axis mirror + bind-pose snapshot | [`m2/bind-pose.ts:34-93`](../../../client/src/game/pipeline/m2/bind-pose.ts) |
| Bone inverses taken in model space (`updateMatrixWorld` before `new Skeleton`) | [`m2/bind-pose.ts:116-122`](../../../client/src/game/pipeline/m2/bind-pose.ts) |
| Per-model immutable sequence table, `AnimationData.dbc` alias resolution | [`m2/anim/model-anim.ts`](../../../client/src/game/pipeline/m2/anim/model-anim.ts) |
| Per-placement clock + bone solver, pivot law `T(p)·TRS·T(−p)`, parent premultiply | [`m2/anim/instance-anim.ts:213-281`](../../../client/src/game/pipeline/m2/anim/instance-anim.ts) |
| Solved pose written to bone TRS (three 0.185 overwrites `boneMatrices` every frame) | [`m2/anim/pose.ts:9-72`](../../../client/src/game/pipeline/m2/anim/pose.ts) |
| GPU 4-bone skin, three's `boneTexture` path | [`m2/material/vertex/common-main.glsl:3-55`](../../../client/src/game/pipeline/m2/material/vertex/common-main.glsl) |
| Per-submesh downgrade to rigid when a submesh touches one bone | [`m2/anim/skinning-scope.ts:186-221`](../../../client/src/game/pipeline/m2/anim/skinning-scope.ts) |
| External `.anim` fetch + merge (quarantined until merged) | [`m2/anim/external-anim.ts`](../../../client/src/game/pipeline/m2/anim/external-anim.ts) |
| Bone budget / distance decimation | [`m2/anim/gating.ts:16-79`](../../../client/src/game/pipeline/m2/anim/gating.ts), `boneBudgetPerFrame: 4000` |

Bone ceiling is effectively unbounded — the `MAX_BONES = 200` define at
[`material/index.ts:308`](../../../client/src/game/pipeline/m2/material/index.ts) is **vestigial**; the
assembled shader never references it and goes through `texelFetch`. `HumanMale.m2` has **138 bones**
and **156 sequences**, well inside every budget.

`Character\Human\Male\HumanMale.m2` measured: `MD20` version **264**, 138 bones, 5264 vertices,
**3 skin views**, 156 sequences of which **52 are external** (`humanmale0066-00.anim` → 200,
11808 bytes; `0060` → 14672; `0084` → 19184). So the external-`.anim` path *is* load-bearing for
characters in a way it was not for creatures — but it already exists.

### 1.2 Geoset selection — ABSENT (data parsed, never read)

`.skin` is parsed, including `partID` (the geoset id):
[`wow-data-parser/m2/skin.js:6-20`](../../../client/src/wow-data-parser/m2/skin.js). It is stamped onto
each submesh and filed in a map at
[`m2/index.ts:515,639`](../../../client/src/game/pipeline/m2/index.ts) — and **`M2#parts` has zero
readers**. There is no `setGeosetVisible`, no visibility mask, no per-part `visible` toggling anywhere
in `client/src`.

Consequence today: a character M2 would draw **every** geoset at once — all 12 hairstyles, both
beards, all four glove variants, all five boot variants, all six cloaks, simultaneously.

Only one skin profile is loaded, the *last*: `quality = data.viewCount - 1` at
[`m2/loader.js:15-24`](../../../client/src/game/pipeline/m2/loader.js), i.e. `humanmale02.skin`.
**Measured: this is harmless for characters.** All three profiles carry the same 54 distinct geoset
ids and the same 6356 triangles (00: 61 submeshes / 5264 verts; 01: 61 / 5264; 02: 63 / 5270). No LOD
work is needed.

### 1.3 Runtime texture slots — the character slots are silently `null`

Texture-type dispatch is one `switch`, [`material/index.ts:472-504`](../../../client/src/game/pipeline/m2/material/index.ts):

```
case 0:  textureDef.filename      // hardcoded
case 11/12/13: this.skins.skin1/2/3   // CreatureDisplayInfo skins
default: break;                       // → path = null, no warning
```

`HumanMale.m2` declares exactly four textures, measured from the file:

| slot | type | meaning | handled today |
|---|---|---|---|
| 0 | **1** | composited body skin | **no** → `null` |
| 1 | **6** | hair mesh sheet | **no** → `null` |
| 2 | 0 | `CHARACTER\BLOODELF\FEMALE\DEATHKNIGHTEYEGLOW.BLP` | yes |
| 3 | **2** | cape / object skin | **no** → `null` |

There is already a runtime-supply door, `updateSkinTextures(skin1, skin2, skin3)` at
[`material/index.ts:506-512`](../../../client/src/game/pipeline/m2/material/index.ts), fed from
[`submesh.js:329-341`](../../../client/src/game/pipeline/m2/submesh.js) — the shape to extend, not
replace.

### 1.4 Attachments — parsed, one read, that read has no reader

Struct at [`wow-data-parser/m2/index.js:172-178`](../../../client/src/wow-data-parser/m2/index.js). The
only consumer in the whole client is
[`ui/scene/glue-scene.ts:117-126`](../../../client/src/game/ui/scene/glue-scene.ts), which finds
attachment id 0 and stores it as `stageSpot` — and **`stageSpot` has no readers**. Nothing parents an
`Object3D` to another model's bone anywhere. Weapons, shoulders and helms all need that.

### 1.5 What already renders M2s

Four populations, all through `M2Blueprint.load()`: ADT doodads
([`world/doodad-manager.js:142`](../../../client/src/game/world/doodad-manager.js)), WMO doodads
([`pipeline/wmo/index.js:253`](../../../client/src/game/pipeline/wmo/index.js)), **units/creatures**
([`classes/unit.ts:324-362`](../../../client/src/game/classes/unit.ts) — a full
`CreatureDisplayInfo`→`CreatureModelData`→M2→skinned→gait-driven path, ported from
`benilla/src/creature_anim/select.rs`), and the glue stage.

**Player-character rendering is absent in every sense.** No `CharSections` consumer, no hair assembly,
no equipment attach, no compositor. The customization bytes arrive over the wire
([`network/protocol/wotlk/world-wire.ts:111-119`](../../../client/src/network/protocol/wotlk/world-wire.ts))
and are never turned into geometry.

### 1.6 Shader-table coverage — the `Diffuse_T2` hole is not the only one

`VERTEX_SHADERS`, [`material/index.ts:164-171`](../../../client/src/game/pipeline/m2/material/index.ts)
— **6 keys**: `Diffuse_T1`, `Diffuse_Env`, `Diffuse_T1_T2`, `Diffuse_T1_Env`, `Diffuse_Env_Env`,
`Discard`.

`BatchManager` can name two vertex shaders the table does not hold:

- **`Diffuse_T2`** — emitted at [`batch-manager.js:568`](../../../client/src/game/pipeline/m2/batch-manager.js).
  Guarded twice: a `console.warn` at [`material/index.ts:426-432`](../../../client/src/game/pipeline/m2/material/index.ts)
  (whose comment names it explicitly), and a narrowing at
  [`batch-manager.js:559-571`](../../../client/src/game/pipeline/m2/batch-manager.js) so a *null*
  `textureMapping` routes to `T1`. An **explicit** T2 mapping still falls through the hole, and the
  test at [`__tests__/batch-manager-shader-names.test.js:60-62`](../../../client/src/game/pipeline/m2/__tests__/batch-manager-shader-names.test.js)
  pins that as deliberate.
- **`Diffuse_Env_T2`** — emitted at [`batch-manager.js:625`](../../../client/src/game/pipeline/m2/batch-manager.js).
  Unguarded and undocumented.

`FRAGMENT_SHADERS`, [`material/index.ts:173-210`](../../../client/src/game/pipeline/m2/material/index.ts)
— **15 keys**. Nine combiners `BatchManager` can emit are missing: `Combiners_Decal`, `Combiners_Add`,
`Combiners_Mod2x`, `Combiners_Fade`, `Combiners_Mod_Add`, `Combiners_Mod_Mod2xNA`,
`Combiners_Mod_AddNA`, `Combiners_Add_Mod`, `Combiners_Mod2x_Mod2x`.

Each miss yields `undefined` + a warn, and three silently substitutes its own program. The coverage is
therefore **not** "one gap" — it is roughly two thirds of the emittable surface, and character models
plus item models will widen the sample of batch flags the pipeline has ever seen. This should be
treated as a *measure-then-fill* item (log the misses a dressed character actually produces), not as a
speculative 11-shader backfill. Note `blizzardry/extracted_data/shaders/Pixel/arbfp1/` already carries
the extracted `.bls` for most of the missing combiners, untracked in git — the reference bytes are on
disk.

**But `Diffuse_T2` is not a future problem — it is blocking right now, on this exact screen.**
[`ui/screens.ts:265-289`](../../../client/src/game/ui/screens.ts) documents it in full: `UI_Human`, the
character screen's own stage, has a batch resolving to `Diffuse_T2`, its material reaches three.js with
`vertexShader === undefined`, and `WebGLProgram` **throws every frame**. The try/catch there exists only
so the 2D UI survives; the consequence is that `sceneView.render()` aborts, so on `/?ui=lua` character
select **the stage does not draw at all**. A character added to that same scene would be inside the
same failing traversal. So the vertex shader is a hard prerequisite for seeing *anything* — see §5,
piece 0.

---

## 2. What a 3.3.5a character actually requires

### 2.1 The base model — `ChrRaces` → `CreatureDisplayInfo` → `CreatureModelData`

Measured `ChrRaces.dbc` (21 records, 69 fields, 276-byte stride):

| id | maleDisplayID | femaleDisplayID | clientPrefix | clientFileString | name |
|---|---|---|---|---|---|
| 1 | 49 | 50 | `Hu` | `Human` | Human |
| 2 | 51 | 52 | `Or` | `Orc` | Orc |
| 3 | 53 | 54 | `Dw` | `Dwarf` | Dwarf |
| 4 | 55 | 56 | `Ni` | `NightElf` | Night Elf |
| 5 | 57 | 58 | `Sc` | `Scourge` | Undead |
| 6 | 59 | 60 | `Ta` | `Tauren` | Tauren |
| 7 | 1563 | 1564 | `Gn` | `Gnome` | Gnome |
| 8 | 1478 | 1479 | `Tr` | `Troll` | Troll |
| 10 | 15476 | 15475 | `Be` | `BloodElf` | Blood Elf |
| 11 | 16125 | 16126 | `Dr` | `Draenei` | Draenei |

(ids 9, 12–21 are Goblin and the NPC-only races.) Note **Blood Elf's male/female display ids are out
of order** — 15476 male, 15475 female — so they must be read as two separate columns, never derived.

The path is *not* built from a string template. `maleDisplayID` → `CreatureDisplayInfo.modelID` →
`CreatureModelData.file`:

```
disp 49    → model 49   → Character\Human\Male\HumanMale.mdx      scale 1.0
disp 50    → model 50   → Character\Human\Female\HumanFemale.mdx  scale 1.0
disp 1563  → model 182  → Character\Gnome\Male\GnomeMale.mdx      scale 1.15
disp 15476 → model 2208 → Character\BloodElf\Male\BloodElfMale.mdx
```

`.mdx` → `.m2` rewriting already happens in
[`m2/blueprint.js:23`](../../../client/src/game/pipeline/m2/blueprint.js). **Both DBCs are already
loaded at runtime** by [`classes/unit.ts:329,333`](../../../client/src/game/classes/unit.ts) — the base
model needs no new data layer at all. Gnome's `CreatureDisplayInfo.scale = 1.15` must be applied or
gnomes will be human-sized.

### 2.2 `CharSections` — the appearance table

Measured layout (8958 records, 10 fields, 40-byte stride), and the existing schema at
[`entities/char-sections.js`](../../../client/src/wow-data-parser/dbc/entities/char-sections.js) is
**positionally correct** but two names are wrong:

| col | real meaning | schema calls it |
|---|---|---|
| 0 | ID | `id` |
| 1 | RaceID | `raceID` |
| 2 | SexID | `gender` |
| 3 | BaseSection (0–4) | `generalType` |
| 4–6 | TextureName[3] | `textures` |
| 7 | Flags | `flags` |
| 8 | **VariationIndex** | `type` ← wrong name |
| 9 | **ColorIndex** | `variation` ← wrong name |

BaseSection values, with what each row's three texture columns actually hold (Human Male samples):

| BaseSection | meaning | TextureName[0] | [1] | [2] |
|---|---|---|---|---|
| 0 | skin | `HumanMaleSkin00_00.blp` | — | — |
| 1 | face | `HumanMaleFaceLower00_00` | `HumanMaleFaceUpper00_00` | — |
| 2 | facial hair | `FacialLowerHair00_00` | `FacialUpperHair00_00` | — |
| 3 | hair | `Hair03_00` (mesh sheet) | `ScalpLowerHair02_00` | `ScalpUpperHair02_00` |
| 4 | underwear | `HumanMaleNakedPelvisSkin00_00` | — | — |

**Flags are the load-bearing part, and this is where benilla cannot be copied** (§4.3). Observed values
across the whole table: `1, 5, 6, 8, 17, 18` — i.e. `{0x01 | 0x02} × {0x00, 0x04, 0x10}`, plus a
standalone `0x08`. What the data proves:

- `0x04` = **Death Knight only.** Human Male skins with flag `5` are `HumanMaleSkin00_10/_11/_12`, the
  pale DK skins; hair variations with flag `6` are the DK-only styles.
- `0x08` = **NPC only.** Exactly the `HumanMaleSkin00_100/_101` rows.
- `0x01` vs `0x02` = **character-create vs. barbershop-only.** Human Male hair vars 0–11 carry `0x01`,
  vars 12–16 carry `0x02` (WotLK added barbershop-only styles).

The predicate `(flags & 0x01) && !(flags & 0x04) && !(flags & 0x08)` reproduces the real dial counts,
and two independent tables agree, which is the confirmation that matters:

| race/sex | skin | face | hairStyle | hairColor | facialHair |
|---|---|---|---|---|---|
| Human M | 10 | 12 | 12 | 10 | **9** (CFHS also has 9) |
| Human F | 10 | 15 | 19 | 10 | **7** (CFHS also has 7) |
| Blood Elf F | 10 | 10 | 14 | 10 | **11** (CFHS also has 11) |
| Tauren M | 19 | 5 | 8 | 3 | **7** (CFHS also has 7) |

`0x10`'s meaning is **not** settled by the data — see §6.

The hair-style range must come from **flag-filtered `CharSections`**, not from `CharHairGeosets`:
`CharHairGeosets` has 17 variations for Human Male against 12 create-eligible styles. Deriving from
`CharHairGeosets` (which is what the reference does) would offer barbershop and DK styles at create
and produce appearance bytes a vmangos-family server rejects.

### 2.3 The composited body texture

The bake is a layered blit into one atlas. Layer set and order, from the reference (§4) and confirmed
against the shipped art:

1. base **skin** — `CharSections` BaseSection 0, `TextureName[0]`, full canvas
2. **face** — BaseSection 1, `[0]`→lower head tile, `[1]`→upper head tile
3. **facial hair** — BaseSection 2, `[0]`→lower, `[1]`→upper (keyed by *hairColor*, not skin)
4. **hair scalp** — BaseSection 3, `[1]`→lower, `[2]`→upper (note the column shift: hair uses `[1]/[2]`,
   face/facial use `[0]/[1]`)
5. **underwear** — BaseSection 4, `[0]`→pelvis tile
6. **equipment**, eight region layers in priority order (below)

The eight equipment regions are `ItemDisplayInfo` columns 15–22, and they are also the tile layout.
Measured layout (25 fields, 100-byte stride) — the existing schema at
[`entities/item-display-info.js`](../../../client/src/wow-data-parser/dbc/entities/item-display-info.js)
is **exactly right**, all 25 columns:

```
id, leftModelFile, rightModelFile, leftModelTexture, rightModelTexture, icon, iconAlt,
geosetGroupIDs[3], flags, spellVisualID, groupSoundID,
maleHelmetGeosetVisID, femaleHelmetGeosetVisID,
upperArmTexture, lowerArmTexture, handsTexture, upperTorsoTexture, lowerTorsoTexture,
upperLegTexture, lowerLegTexture, footTexture, visualID, particleColorID
```

Real row 40390: `Robe_C_03White_Sleeve_AU`, `Cloth_C_04Blue_Bracer_AL`,
`Robe_AhnQiraj_A_Purple_Glove_HA`, `Robe_C_03White_Chest_TU`, `Robe_C_03White_Chest_TL`,
`Robe_C_03White_Belt_LU`, `Robe_C_03White_Boot_LL`, `Robe_C_03White_Boot_FO` — note the three
independent art families in one row. Never derive one column from another.

Region files live at `Item\TextureComponents\<Region>Texture\<name>_<M|F>.blp` with a **`_U` unisex
fallback**, verified by probe:

```
200 128x64  torsouppertexture/robe_c_03white_chest_tu_m.blp
404         armuppertexture/robe_c_03white_sleeve_au_m.blp
200 128x64  armuppertexture/robe_c_03white_sleeve_au_u.blp     ← the fallback fires
404         armuppertexture/robe_c_03white_sleeve_au_f.blp
```

**The resolution finding that matters.** Measured BLP dimensions:

| asset | size |
|---|---|
| `HumanMaleSkin00_00.blp` | **512×512** (DXT, mipped) |
| `HumanMaleFaceUpper00_00` | 256×64 |
| `HumanMaleFaceLower00_00` | 256×128 |
| `HumanMaleNakedPelvisSkin00_00` | 256×128 |
| `ScalpUpperHair02_00` | 128×32 |
| `ScalpLowerHair02_00` | 128×64 |
| `Robe_C_03White_Chest_TU` (equip region) | 128×64 |
| `Robe_C_03White_Chest_TL` | 128×32 |

Character-owned art was **re-authored at 2×** for 3.3.5a (256×64 face upper against vanilla's 128×32,
256×128 pelvis against 128×64), but vanilla-era **scalp and item region art still ships at 1×**. So a
512² canvas needs upscaling for some layers and a 256² canvas needs the base skin taken at mip 1 and
nothing else scaled. Both are defensible; which one the client does is an unknown (§6). The **cheap
correct-looking choice is 256²** — every source then lands 1:1 or via its own authored mip, no
resampler is needed, and the base skin's mip 1 is exactly 256×256. That is also the layout the
reference's tile table is expressed in, so it can be ported verbatim.

### 2.4 Geosets — the real ids, measured

`humanmale00.skin` submesh `partID` values, all 54:

```
0  1  2  3  4  5  6  7  8  9  10 11 12 13 14 15 16 17 18      ← group 0: hairstyles (0 = bald)
101 102          ← group 1  facial hair A
201 202          ← group 2  facial hair B
301 302          ← group 3  facial hair C
401 402 403 404  ← group 4  gloves
501 502 503 504 505 ← group 5 boots
701 702          ← group 7  ears
802 803          ← group 8  sleeves
902 903          ← group 9  kneepads/leggings
1002             ← group 10 chest/doublet
1102 1104        ← group 11 pants
1202             ← group 12 tabard
1301 1302        ← group 13 robe
1501 1502 1503 1504 1505 1506 ← group 15 cloak
1703             ← group 17 belt
1802             ← group 18 (trousers/tail)
```

So `geosetId = group * 100 + variant`, confirmed on the real file. Group 0 is the only group whose
variant 0 is a real submesh (the bald scalp / body).

Drivers:

- **Hair** — `CharHairGeosets` (339 records, 6 fields; schema at
  [`entities/char-hair-geosets.js`](../../../client/src/wow-data-parser/dbc/entities/char-hair-geosets.js)
  is correct: `id, raceID, gender, hairType (=VariationID), geoset, bald (=ShowScalp)`). Measured Human
  Male: variation 0 → geoset 0 / ShowScalp 1; variations 1..16 → geosets 2..17 / ShowScalp 0. Note
  variation 1 maps to geoset **2**, not 1 — the mapping is table data, not arithmetic. The client takes
  `max(1, geoset)`. Duplicate `(race, sex, variation)` keys exist (goblin male, rows 241–244);
  **first row wins**.
- **Facial hair** — `CharacterFacialHairStyles` (222 records, 8 fields, **no ID column**; schema at
  [`entities/character-facial-hair-styles.js`](../../../client/src/wow-data-parser/dbc/entities/character-facial-hair-styles.js)
  is correct). Human Male variation 1 → `(1, 2, 1, 0, 0)`. The three values become geosets in groups
  1, 2 and 3 — but **the column→group order is an unknown** (§6): Human Male only ever has variants 1
  and 2 in each of those groups, so the data cannot distinguish an order.
- **Equipment** — `ItemDisplayInfo.geosetGroupIDs[3]`, per inventory slot, through the client's branch
  set (gloves disable 401–499 and push `401+v`; a robe disables 501–599, 902–999, 1100–1199, 1300–1399
  and pushes `1301+v`; a cloak disables 1500–1599 and pushes `1501+v`; pants push `1102+v` — note the
  1102 base, not 1101). The reference's transcription of these eight branches is the thing to port.
- **Helm hide-masks** — `ItemDisplayInfo` cols 12/13 index `HelmetGeosetVisData`. Measured: 21
  records, 8 fields, 32-byte stride = `id` + 7 masks (5 used, 2 always zero), each mask a **race
  bitfield** (`1 << race`); a set bit forces hair/facial/ear geosets to their base. **This is the one
  DBC with no schema in this repo.**

### 2.5 Equipment models

`EquipmentDisplay` already carries what is needed —
[`network/protocol/types.ts:32-36`](../../../client/src/network/protocol/types.ts):
`{ displayId, inventoryType, enchantmentId }`, 23 slots decoded at
[`world-wire.ts:138-142`](../../../client/src/network/protocol/wotlk/world-wire.ts).

Two-model rows are shoulders (`ItemDisplayInfo` 1057: `LShoulder_Leather_A_01.mdx` +
`RShoulder_Leather_A_01.mdx`, each with its own texture column). Verified fetchable:

```
200  item/objectcomponents/shoulder/lshoulder_leather_a_01.m2
200  item/objectcomponents/shoulder/shoulder_leather_a_01brown.blp
200  item/objectcomponents/weapon/sword_1h_sabre_b_02.m2
```

Directory per kind: `Weapon`, `Shield`, `Shoulder`, `Head`, `Cape`, `Ammo`, `Quiver` under
`Item\ObjectComponents\`. Helms are per-race-and-sex: `<stem>_<Prefix><M|F>.m2` with `Prefix` from
`ChrRaces.clientPrefix` (§2.1). Attachment ids on `HumanMale.m2` (from the reference, empirically
pinned there): shield 0, right hand 1, left hand 2, right shoulder 5, left shoulder 6, helm 11, plus
the stow points 26–33.

### 2.6 DBC ledger — what we have, what is new

The DBC layer is fully capable. Binary reader
[`wow-data-parser/dbc/index.js`](../../../client/src/wow-data-parser/dbc/index.js) hard-seeks by the
header's `recordSize`, so a wrong schema corrupts only its own fields. Adding a table is **two steps**:
a `restructure` struct in `entities/<name>.js`, and one `export * as <ExactDbcFileName>` line in
[`entities/index.js`](../../../client/src/wow-data-parser/dbc/entities/index.js) (the export name must
equal the `.dbc` filename — [`pipeline/dbc/loader.js:9-10`](../../../client/src/game/pipeline/dbc/loader.js)).
Fetch is plain HTTP in a worker; **176 tables are defined and only 9 are ever loaded.**

| table | schema exists? | loaded today? |
|---|---|---|
| `ChrRaces` | yes | no |
| `CreatureDisplayInfo` | yes | **yes** ([`unit.ts:329`](../../../client/src/game/classes/unit.ts)) |
| `CreatureModelData` | yes | **yes** ([`unit.ts:333`](../../../client/src/game/classes/unit.ts)) |
| `CharSections` | yes (two mislabeled columns, §2.2) | no |
| `CharHairGeosets` | yes | no |
| `CharacterFacialHairStyles` | yes | no |
| `ItemDisplayInfo` | yes, exact | no |
| `AnimationData` | yes | no |
| `HelmetGeosetVisData` | **NO — new** | no |
| `CharBaseInfo`, `CharStartOutfit`, `ItemVisuals` | yes | no (char-create/glow only) |

Sizes over the wire, measured: `CharSections` 845 KB, `ItemDisplayInfo` **6.7 MB**, `ChrRaces` 6 KB,
`CharHairGeosets` 8 KB, `CharacterFacialHairStyles` 7 KB, `HelmetGeosetVisData` 693 B.
`ItemDisplayInfo` at 6.7 MB is the only one worth a thought — it is a one-shot fetch, worker-decoded,
and character select needs it before it can dress anyone.

### 2.7 The compositor has no substrate

**Zero** occurrences of `WebGLRenderTarget` anywhere in `client/src`. No `OffscreenCanvas`. The only
canvas-2D compositing is the font glyph atlas
([`ui/text.ts:298-336`](../../../client/src/game/ui/text.ts)). `THREE.DataTexture` is built in five
places, all CPU-authored pixel arrays. This is a deliberate, documented decision —
[`glue-scene.ts:15-18`](../../../client/src/game/ui/scene/glue-scene.ts) explains why the glue scene
renders straight to the canvas rather than to a target.

BLP decoding is in hand: [`wow-data-parser/blp/`](../../../client/src/wow-data-parser/blp/) decodes
palettized/raw to `IMAGE_ABGR8888` and leaves DXT compressed
([`pipeline/blp/loader.js`](../../../client/src/game/pipeline/blp/loader.js)). **The base skin and most
region textures are DXT** (`compress = 1` in the measurements above), so a CPU blit needs them
*decompressed* — the existing loader deliberately does not. That is a real, concrete gap: either the
BLP worker gains a "decode DXT too" mode for this one consumer, or the bake happens on the GPU.

---

## 3. What the glue screens specifically need

### 3.1 The Lua surface is small — the engine does the work

Fetched the real files: `interface/gluexml/characterselect.lua` (554 lines) and `charactercreate.lua`
(558 lines). Every model-related call, verbatim:

| file:line | call | what it means |
|---|---|---|
| `characterselect.lua:11-12` | `self:SetSequence(0)` / `self:SetCamera(0)` | on the `CharacterSelect` frame itself |
| `characterselect.lua:33` | `SetCharSelectModelFrame("CharacterSelect")` | names the frame the engine draws the character into |
| `characterselect.lua:495-507` | `Set/GetCharacterSelectFacing` | already real ([`api/characters.ts:302-306`](../../../client/src/game/ui/framexml/lua/api/characters.ts)) |
| `charactercreate.lua:66-67` | `self:SetSequence(0)` / `self:SetCamera(0)` | same pair |
| `charactercreate.lua:75` | `SetCharCustomizeFrame("CharacterCreate")` | the create-side twin |
| `charactercreate.lua:121,154,378,449,455` | `Set/GetCharacterCreateFacing` | rotate buttons |
| `charactercreate.lua:361,375,377,395` | `SetSelectedClass/Race/Sex` | engine-side selection |
| `charactercreate.lua:434,439` | `CycleCharCustomization(id, ±1)` | **the arrow click** |
| `charactercreate.lua:443` | `RandomizeCharCustomization()` | |
| `charactercreate.lua:101` | `ResetCharCustomize()` | random combination on show |
| `charactercreate.lua:558` | `GetHairCustomization()` / `GetFacialHairCustomization()` | dial *labels* |

The important reading: **the Lua never touches the character's appearance.** It hands the engine a
frame name once and then only sends dial deltas. `CreateCharacter(CharacterCreateNameEdit:GetText())`
(`charactercreate.lua:347`) takes **only a name** — race, class, sex and all five dials live in the
engine. So the FrameXML side of *character select* is small (five or six functions), but character
create means this runtime must **own** that selection state and hand it to `session` as a
`CharCreateRequest`, not proxy calls through to something else.

Note `SetSequence(0)`/`SetCamera(0)` on these frames are the **stage's** sequence and camera, already
honoured by [`glue-scene.ts:106-116`](../../../client/src/game/ui/scene/glue-scene.ts). The character's
own animation is a separate thing the engine picks (a looping Stand).

There is a second, larger Lua fan-out that lands entirely on stubs. `glueparent.lua:376-386`
`SetBackgroundModel` calls `SetLighting(model, race)` (`glueparent.lua:327-373`), which per stage change
issues `SetSequence`, `SetCamera`, three `SetFog*` or `ClearFog`, `SetGlow`, `ResetLights`, and then up
to twelve `AddCharacterLight` / `AddLight` / `AddPetLight` calls with 13 floats each. **`ResetLights`
and `AddCharacterLight` are the character's lighting**, and `glue-scene.ts` currently builds its rig
from `RACE_LIGHTS` in host code rather than from these calls
([`scene-rig.ts`](../../../client/src/game/ui/scene/scene-rig.ts)). That is a defensible divergence
today — but a character lit by the host's table while the client's Lua is telling us six light sets is
a decision to make deliberately, not to inherit.

### 3.2 The stubs, and why they are stubs

| stub | file:line | body |
|---|---|---|
| `SetCharSelectModelFrame` | [`api/characters.ts:362`](../../../client/src/game/ui/framexml/lua/api/characters.ts) | `() => []` |
| `UpdateSelectionCustomizationScene` | [`api/characters.ts:363`](../../../client/src/game/ui/framexml/lua/api/characters.ts) | `() => []` |
| `SetModel`, `SetCamera`, `SetSequence`, `SetFogNear/Far/Color`, `ClearFog`, `SetGlow`, `AdvanceTime`, `ResetLights`, `AddLight`, `AddCharacterLight`, `AddPetLight` | [`methods/frame.ts:241-261`](../../../client/src/game/ui/framexml/lua/methods/frame.ts) | 13 × `notImplemented(...)` |
| `Get/SetCharacterSelectFacing` | [`api/characters.ts:139,302-306`](../../../client/src/game/ui/framexml/lua/api/characters.ts) | real state, **nothing renders it** |

The comment at [`frame.ts:229-238`](../../../client/src/game/ui/framexml/lua/methods/frame.ts) already
names the design constraint exactly: wiring these needs *(a)* per-widget model state on `Widget` and
*(b)* a bridge from that state to `GlueSceneView`. It also states why a wrong model would be worse
than a visible no-op.

`MODEL` is a real Lua *class* — [`lua/object.ts:51`](../../../client/src/game/ui/framexml/lua/object.ts)
with `MODELFFX`/`PLAYERMODEL` aliased to it at `:110-111` — but `CLASS_KIND` maps it to `'frame'`
(`:95`), and [`ui/widget.ts:28-35`](../../../client/src/game/ui/widget.ts) has no `model` kind. So
`<ModelFFX name="CharacterSelect">` materializes as an ordinary frame with no model state field.

Also absent, and worth knowing they are *not needed* for 3.3.5a glue: `SetCreature`, `SetUnit`,
`RefreshUnit`, `SetRotation`, `SetPosition`, `SetModelScale`, `ClearModel`, `DressUpModel` — none appear
in the 12340 glue files. `SetFaceCustomizeCamera` is **not a 3.3.5a API at all** (Cataclysm+); it does
not occur in `charactercreate.lua` or `.xml` at this build.

And `<OnUpdateModel>` (`charactercreate.xml:806-808`, `characterselect.xml:930-932`) — the 60 Hz
`UpdateCustomizationScene(); self:AdvanceTime()` tick — **is never dispatched**: the script name is
known to [`lua/scripts.ts:76`](../../../client/src/game/ui/framexml/lua/scripts.ts) but this runtime
dispatches no `OnUpdate` family. So the character's animation clock has to be driven host-side (which
`glue-scene.ts#update` already does for the stage), not through the client's Lua.

### 3.3 The stage

[`glue-scene.ts`](../../../client/src/game/ui/scene/glue-scene.ts) is a single `GlueSceneView`
singleton with its own `Scene`, Z-up `PerspectiveCamera`, and a `root` group "so the character can yaw
without the stage yawing with it" (line 40). Attachment id 0 is read at `:117-126`, converted through
`modelToRender` (which applies the 180° Z yaw `createGeometry` bakes in: `(x,y,z) → (−x,−y,z)`), and
exposed as `stageSpot` at `:71-73` with the comment *"spec 6 consumes it"*.

Three seams are pre-cut and all three are dead:

- **`stageSpot` has no readers.**
- **`yaw` (`:60`) is written by nobody and read by nobody.** `this.root` is added at `:65` and never
  rotated. `SetCharacterSelectFacing` stores radians into a closure local that reaches nothing.
- **There is no way to add anything to the scene.** `scene`, `root`, `camera` and `model` are all
  private (`:43-52`); the only public surface is `stageSpot`, `yaw`, `setScene`, `update`, `render`,
  `dispose`. And `render()` traverses `this.model` only, so a character added under `root` would get no
  per-object lighting until the traversal widens.

So the *design* for placement exists and is documented; none of the code does.

One architectural constraint on the general `Model`-widget question (not on the glue character): **there
is no DOM UI.** `screens.ts:88-99` builds one `WebGLRenderer` shared by `GlueRenderer` and
`GlueSceneView`; the UI is three.js textured quads in an ortho pass drawn over the 3D pass with
`autoClear = false` ([`ui/renderer.ts:1-10`](../../../client/src/game/ui/renderer.ts)). A per-widget
model therefore cannot be composited by putting a scene "behind a frame" — it needs a scissored second
pass or a real render target. **The glue character needs neither**, because it belongs in the same scene
at attachment 0. That is exactly why `stageSpot` exists, and it is the reason piece 2 in §5 is cheap.

`CharacterRecord.appearance` and `.equipment` are decoded and available on the session
([`world-wire.ts:111-142`](../../../client/src/network/protocol/wotlk/world-wire.ts)). They are **not**
surfaced to Lua and do not need to be — `GetCharacterInfo` returns ten values, none of them appearance
([`api/characters.ts:16-34`](../../../client/src/game/ui/framexml/lua/api/characters.ts)). The host
reads them straight off the session, exactly as `SetCharSelectBackground` already does for the stage.

### 3.4 Why character create is the harder consumer

**Character create is not even loaded today, and that is the first thing to say about it.**
`stopAfter` defaults to `'CharacterSelect.xml'`
([`runtime.ts:196`](../../../client/src/game/ui/framexml/runtime.ts),
[`framexml-screen.ts:107`](../../../client/src/game/ui/screens/framexml-screen.ts)), and
`CharacterCreate.xml` sits after it in the TOC — so it is never fetched, parsed or run. `pages/glue`
registers no screen for `ClientState.CharCreate`. Roughly **25 char-create globals are unregistered**,
and the very first line of `CharacterCreate_OnLoad` past the two frame methods is a nil
`SetCharCustomizeFrame` (`charactercreate.lua:75`), which would abort the handler before anything else
ran. So "make character create real" is a screen-boot task with a model task inside it, not a model
task.

Character select re-dresses only when the highlighted row changes, and the roster is at most 10 rows —
a small LRU makes every re-selection free after the first pass.

Character create re-bakes per dial change. **Correcting an easy wrong assumption:** the customization
arrows have `OnClick` only (`charactercreate.xml:176-192`) — no `OnUpdate`, no auto-repeat — so bakes are
human-paced, one per click, tens of milliseconds apart at worst. A 5–15 ms composite is invisible there.
What *is* per-frame is the **rotation** path: `CharacterCreateRotateLeft/Right_OnUpdate`
(`charactercreate.lua:449,455`) fire `SetCharacterCreateFacing(f ± CHARACTER_FACING_INCREMENT)` (=2,
**degrees**) every frame while the button is held, and the drag handler does two `GetCursorPosition()`
plus one facing write per frame (`:152`, `CHARACTER_ROTATION_CONSTANT = 0.6`). Character select has the
same shape (`characterselect.lua:495-507`). **Rotation must therefore be a bare field write plus a
quaternion and must not touch the bake** — the reference enforces exactly this with a yaw-only fast path
(§4.2).

A single `CycleCharCustomization(id, ±1)` changes one of `NUM_CHAR_CUSTOMIZATIONS = 5` dials, and the
consequence differs per dial:

| dial | needs a new bake? | needs new geosets? |
|---|---|---|
| skin | **yes** (base layer) | no |
| face | **yes** (2 tiles) | no |
| hairStyle | yes (scalp tiles) | **yes** (group 0) |
| hairColor | **yes** (scalp + facial tiles) | no |
| facialHair | **yes** (2 tiles) | **yes** (groups 1/2/3) |

So four of five dials force a re-composite. **The genuinely expensive interactions are race and sex
clicks**, not dials: `charactercreate.lua:368-391` and `:393-430` each run `SetSelectedRace/Sex`,
`SetCharacterRace`, both enumerate calls, `SetCharacterClass`, `CharacterCreate_UpdateHairCustomization`
and `CharacterChangeFixup` — and `SetCharacterRace` ends in `GetCreateBackgroundModel()` +
`SetBackgroundModel`, i.e. **a whole new `UI_<race>.m2` stage load, an ambience crossfade and the full
`SetLighting` fan-out**, plus a different base character M2 (male and female are different files) and a
full recomposite. Hundreds of milliseconds, network-bound. `GlueSceneView.setScene` already
token-guards a same-token reselect (`glue-scene.ts:83-86`), which is what makes Gnome→Dwarf and
Troll→Orc free.

This argues for: cache keyed on the full appearance tuple (so cycling a dial back is a map hit),
decoded source layers cached separately from the composite, a yaw-only fast path, and the composite
itself cheap enough to run synchronously in a click handler. A GPU bake into a `WebGLRenderTarget` is
the cheap option here; a CPU blit over DXT-decoded 512² sources is the expensive one.

---

## 4. How benilla does it

### 4.1 The structure

| concern | path |
|---|---|
| appearance data | `samples/benilla/crates/benilla-formats/src/characters/` — `sections.rs` (651 L), `geosets.rs` (505 L), `customization.rs` (742 L) |
| item identity | `crates/benilla-formats/src/items.rs` (397 L) — `ItemDisplay`, `ItemDisplayCatalog` |
| per-entity dressing | `crates/benilla/src/entities/attach/` — `char_skin.rs` (491 L), `dress.rs` (617 L), `redress.rs` (566 L), `glue_preview.rs` (586 L) |
| equipment | `crates/benilla/src/entities/equipment/` — `mod.rs`, `resolve.rs`, `spawn.rs` |
| GPU skinning | `crates/benilla/src/rig_palette.rs` + `assets/shaders/wow_model.wgsl:292-335` |
| pose eval | `crates/benilla/src/creature_anim/{pose,compose,select,driver}.rs` |
| char create | `crates/benilla/src/char_create/` (2079 L) |
| char select | `crates/benilla/src/char_select/` (2081 L) |
| offscreen booths | `crates/benilla/src/portrait/{booth,glue_booth,...}.rs` (4557 L) |

The split worth copying: **one look-resolution law, two screens.** `GlueLook::{Create, Select}`
(`portrait/glue_booth.rs:95-98`) is a single enum both screens write into one `GluePreview`, and both
go through the same `build_glue_preview` (`attach/glue_preview.rs:84`) which reuses
`char_skin::build_char_skin_materials`, `equip_geosets`, `ensure_item_model` and `placement`. There is
no forked selection law between select and create.

### 4.2 The bake

`CharSections::composite_body`, `benilla-formats/src/characters/sections.rs:181-242`. A **CPU 8-bit
source-over blit**, not a GPU render target, into a **256×256** canvas with a mip chain.

Tile table (`sections.rs:31-47`): head upper `(0,160,128,32)`, head lower `(0,192,128,64)`, pelvis
`(128,96,128,64)`; and the eight equipment tiles ArmUpper `(0,0,128,64)`, ArmLower `(0,64,128,64)`,
Hand `(0,128,128,32)`, TorsoUpper `(128,0,128,64)`, TorsoLower `(128,64,128,32)`, LegUpper
`(128,96,128,64)`, LegLower `(128,160,128,64)`, Foot `(128,224,128,32)`.

Overlay order at `sections.rs:205-221` is exactly the list in §2.3, including the hair column shift.
Equipment layers at `:224-240` are ordered by an 8×8 priority table (`EQUIP_LAYER_PRIORITY`,
`:67-76`), reverse-engineered from the client at `[0x803bf8]`, `-1` meaning the slot does not touch the
layer. Kernel `blit_over` (`:307-347`) walks each authored mip, shifting the dest tile by the mip
level, and does `a==0` skip / `a==255` copy / else 8-bit source-over.

Cached as `SkinComposites(SpatialCache<SkinKey, Handle<Image>>)` (`crates/benilla/src/entities.rs:309`)
keyed on `{race, sex, skin, face, facial_hair, hair_style, hair_color, equip: [u32;8]}` — so cycling a
dial back is a hashmap hit. Evicted on map change and by distance/idle.

Geoset selection is `CharacterGeosets::visible_geosets` (`geosets.rs:51-150`): base set
`[1,101,201,301,401,501,601,702,801,901,1001,1101,1201,1301,1401,1501]` plus geoset 0 unconditionally
(note slot 7's base is **702**, the outlier), then the eight equipment branches B1–B8 and the helm
hide-masks. Skinning is GPU with custom vertex attributes so Bevy's own skinning lane stays off;
the whole joint hierarchy is dropped for units in favour of flat `RigPose` arrays.

Character create: dial ranges are **data-derived, never hardcoded** (`customization.rs:4-21`), the
create preview is dressed in the level-1 `CharStartOutfit` for (race, class, sex), and a re-bake is
gated behind a monotonic `revision` compared at `glue_booth.rs:816-819` so a yaw-only change skips the
whole rebuild (`apply_yaw`, `:970-974`).

### 4.3 Where the reference cannot be followed — and this is the biggest single finding

**benilla is WoW 1.12.1 / build 5875, not 3.3.5a.** Its own DBC crate says so
(`crates/benilla-dbc/src/lib.rs:1-8`). Concretely:

| what | 1.12.1 (benilla) | 3.3.5a (measured) |
|---|---|---|
| composite canvas | 256×256 | base skin is **512×512**; canvas size unknown (§6) |
| face upper art | 128×32 | **256×64** |
| pelvis art | 128×64 | **256×128** |
| item region art | 128×64 | still **128×64** — mixed scale |
| `ItemDisplayInfo` | 23 fields | **25 fields** |
| `CharSections` flags | no DK, no barbershop | `0x04` DK, `0x02` barbershop-only — **benilla ignores flags entirely** |
| hairStyle dial source | `CharHairGeosets` variations | must be flag-filtered `CharSections` (§2.2) |
| external `.anim` | none exist | **52 of 156** on `HumanMale.m2` |

So: **port benilla's structure and its tile/priority/branch tables; do not port its numbers or its
flag-blindness.** The tile table is a 1× layout that scales cleanly by 2 for the character-owned tiles
(measured: every 3.3.5a character layer is exactly 2× its vanilla tile), which is why a 256² canvas
lets it be reused verbatim.

---

## 5. The honest cost — pieces in dependency order

Sizes: **S** ≈ under a day, **M** ≈ two to four days, **L** ≈ a week or more. Each piece is meant to
ship on its own and be visibly true or false.

| # | piece | size | depends on | what you can see |
|---|---|---|---|---|
| 0 | **The `Diffuse_T2` vertex shader.** Hard prerequisite, not an optional cleanup: `UI_Human` throws every frame today and the whole stage render aborts (§1.6). Add the entry, delete the narrowing workaround at [`batch-manager.js:559-571`](../../../client/src/game/pipeline/m2/batch-manager.js) if it becomes redundant, and remove the swallow-and-warn at [`screens.ts:279-289`](../../../client/src/game/ui/screens.ts) only once nothing throws. | **S** | — | **the character-select stage draws at all** — today it does not |
| 1 | **Geoset visibility on `M2`.** Give `M2#parts` a reader: `setVisibleGeosets(Set<number>)` toggling `submesh.visible`. Pure, testable, no new data. | **S** | — | nothing yet (unit tests only) |
| 2 | **A naked character on the glue stage.** `ChrRaces` (new load, existing schema) → the already-loaded `CreatureDisplayInfo`/`CreatureModelData` → `M2Blueprint.load` → a public `GlueSceneView.setCharacter(...)` placing it at `stageSpot` under a group `yaw` finally rotates, `render()`'s traversal widened to include it, `CreatureDisplayInfo.scale` applied (Gnome is 1.15), a looping Stand armed, appearance read host-side off `session.characters[selectedIndex]`. Geosets from piece 1: body + base variants only. Body texture = `CharSections` BaseSection 0 `TextureName[0]` **straight into slot type 1, no bake.** | **M** | 0, 1 | **the first visible character** — correctly shaped, correctly posed, correctly rotating, with a blank face/pelvis region |
| 3 | **Texture-type slots 1 / 2 / 6.** Extend `resolveTexturePath`'s switch and `updateSkinTextures` to carry body/cape/hair. | **S** | 2 | hair mesh and cape draw with real art |
| 4 | **Hair and facial hair.** `CharHairGeosets` + `CharacterFacialHairStyles` (both schemas exist) → geoset ids, `max(1, geoset)`, first-row-wins on duplicate keys. | **S–M** | 1, 3 | a character with the right haircut and beard, still with a flat face texture |
| 5 | **The compositor.** A layered bake of skin + face + facial hair + scalp + underwear into one 256² mipped texture, keyed on the appearance tuple. Includes the DXT-decode decision (§2.7). Ship it *without* equipment layers. | **M–L** | 3 | a **finished-looking naked character** — the milestone where it stops looking like a tech demo |
| 6 | **The FrameXML bridge.** Make `SetCharSelectModelFrame` real: per-widget model state on `Widget` plus a bridge to `GlueSceneView`. Feed appearance off the session, not through Lua. | **S–M** | 2 | the character appears because the *client's own Lua* asked for it |
| 7 | **Equipment textures.** `ItemDisplayInfo` (schema exact) + the eight region layers + the priority table + `_M`/`_F`/`_U` fallback. | **M** | 5 | a **dressed** character on character select — armour, robes, boots |
| 8 | **Equipment geosets + helm hide-masks.** The eight branches, `HelmetGeosetVisData` (the one new schema). | **M** | 1, 7 | robes replace legs, gloves replace hands, helms hide hair |
| 9 | **Attachments.** Parent an M2 to another model's bone; weapons, shoulders, helms, capes; the select-screen "weapons in hands, ranged skipped" rule. | **M–L** | 2, 8 | weapons and shoulders |
| 10 | **Character create.** Two halves. *(a)* Boot the screen at all: move `stopAfter` past `CharacterCreate.xml`, register a `ClientState.CharCreate` screen, and implement the ~25 absent globals (`SetCharCustomizeFrame`, `SetSelected*`/`GetSelected*`, `CharacterCreateEnumerate*`, `IsRaceClassValid`, `GetFactionForRace`, `GetNameForRace`, `GetHair/FacialHairCustomization`, `CreateCharacter`), with the runtime **owning** the selection state (`CreateCharacter` passes only a name). *(b)* The model half: flag-filtered dial ranges (§2.2), `CycleCharCustomization`, `RandomizeCharCustomization`, `ResetCharCustomize`, `CharBaseInfo` combos, `CharStartOutfit` preview, a revision-gated re-bake and a yaw-only fast path. | **L** | 5, 6, 8 | a working create screen |
| 11 | **Characters in the world.** Reuse everything through `classes/unit.ts`, which already has the DBC→model→gait driver. Adds: many characters at once, the bone/bake budget, LRU eviction, redress-in-place on gear change. | **M–L** | 5, 8, 9 | other players |
| 12 | **Shader-table backfill, measured.** Log which of the 11 missing shader names a dressed character and its item models actually emit, then fill those. `.bls` reference bytes are already on disk. | **S–M** | 7, 9 | correct blending instead of three's substitute |

**First visible character: piece 2.** Pieces 0+1+2 together, ~three days, and a Human Male stands on the
`UI_Human` stage in a Stand loop with the correct body texture. Piece 0 alone is worth shipping first
regardless: it un-breaks the stage that is failing today.

**Cheapest credible first milestone: pieces 0 + 1 + 2 + 3 + 4.** That is a race-and-sex-correct
character with the right hairstyle and beard, real hair and cape art, standing and rotating on the
stage — and it needs **no compositor, no render target, no new DBC schema, no new Lua global beyond
`SetCharSelectModelFrame`, and no new dependency**. The only visible wrongness is that the face,
facial-hair and underwear layers are absent, so the head shows the base skin's blank face region. That
is a known, explainable gap rather than a wrong picture, and it is exactly the point at which the
compositor's design (§6.1, §6.4) can be argued from something on screen.

### New dependencies

**None required.** Everything the work needs the game data or the existing code already provides:

- Bone/skin/animation machinery — exists (§1.1).
- BLP decode — exists; needs a DXT-decode path *if* the bake is on the CPU (§2.7). That is a change to
  our own decoder, which already contains `dxt.ts`, not a new library.
- The bake — either `THREE.WebGLRenderTarget` (in three, already a dependency) or a canvas-2D /
  `DataTexture` blit (both already used in this client). No image library, no resampler needed if the
  canvas is 256².
- DBC — the reader, the worker route and the schema format all exist; one new 20-line schema file.

---

## 6. Blockers and unknowns

Each is named with the evidence that would settle it. None of these blocks pieces 1–4.

1. **The composite canvas size for 3.3.5a — 256² or 512²?** The base skin is 512×512 but scalp and item
   region art still ship at 1× (§2.3). A 256² canvas takes the base skin's mip 1 and needs no
   resampling anywhere; a 512² canvas needs every 1× layer upscaled. *Settled by:* baking a Human Male
   at both sizes with the same layers and comparing against a real 3.3.5a client screenshot at a known
   camera — the seams and the face texel density will disagree visibly. Do this before committing to
   piece 5. **benilla cannot settle it (1.12.1 has no 2× art).**

2. **`CharacterFacialHairStyles` column → geoset group order.** The five columns become geosets in
   groups 1, 2 and 3, but Human Male only ever has variants 1 and 2 in each of those three groups, so
   every ordering produces a valid-looking id. The reference records `gA→group1, gC→group2, gB→group3`
   for 1.12.1 (`geosets.rs:68-72`). *Settled by:* finding a race/sex whose three groups have different
   variant counts and checking which assignment stays in range for every row — or by visual comparison
   on a beard whose moustache and sideburns differ.

3. **`CharSections` flag bit `0x10`.** `0x04` (DK), `0x08` (NPC) and the `0x01`/`0x02` create-vs-
   barbershop pair are all confirmed by the data (§2.2). `0x10` appears on skin/facial-hair/hair/
   underwear rows but **never on face rows**, which rules out the obvious "available to players"
   reading. The create predicate that reproduces every measured dial count ignores it, so this is not
   a blocker — but a wrong guess here would silently corrupt the barbershop later. *Settled by:*
   comparing a real 3.3.5a client's create and barbershop dial counts for a race where `0x10`-bearing
   and `0x10`-free rows differ. **benilla cannot settle it.**

4. **Whether the DXT decode belongs in the BLP worker or the bake belongs on the GPU.** The base skin
   and most region textures are DXT; the existing loader deliberately leaves DXT compressed
   ([`blp/loader.js`](../../../client/src/game/pipeline/blp/loader.js)). CPU blit needs decode; GPU bake
   needs the first `WebGLRenderTarget` in this client. *Settled by:* measuring one full bake both ways
   for a Human Male — decode cost for eight DXT sources versus a target allocation plus 13 blit draws
   — against character create's per-click budget (§3.4). This is the one place where "build an
   instrument before deciding" clearly applies.

5. **`ItemDisplayInfo` at 6.7 MB on the critical path.** Character select cannot dress anyone until it
   lands. *Settled by:* timing the fetch + worker decode + index on a cold cache. If it is too slow,
   the options are a naked-then-dressed two-phase paint (which the reference deliberately avoids via
   its `settled` gate) or a server-side index — but measure first.

6. **Two mislabeled `CharSections` columns.** `type`/`variation` in
   [`entities/char-sections.js`](../../../client/src/wow-data-parser/dbc/entities/char-sections.js) are
   really `variationIndex`/`colorIndex` (§2.2). Positionally harmless, semantically a trap for whoever
   writes piece 5. Not an unknown — a known defect to fix in passing.

7. **Attachment ids on 3.3.5a character models are taken from the reference, not measured here.** The
   reference pinned them empirically on 1.12.1's `HumanMale.m2`. The 3.3.5a file parses fine and has
   attachments; the specific ids were not re-verified. *Settled by:* dumping `HumanMale.m2`'s
   attachment array and checking id 1 sits at the right hand. Cheap; do it inside piece 9.
