/**
 * Pure decode of a WMO `MOMT` material entry into the values the shader needs.
 *
 * Imports nothing, for the same reason `world/light/laws.ts` does not: it keeps the decode testable
 * without three.js, a texture loader or a parsed WMO. The material class applies what this returns.
 *
 * Laws follow `samples/benilla` (`assets/shaders/wow_model.wgsl`, the WMO lane).
 */

/** `MOMT.flags` bits (wowdev `SMOMaterial`). */
export const MOMT_FLAG = {
  /** Lighting off entirely — the draw is `tex x white`. */
  UNLIT: 0x01,
  UNFOGGED: 0x02,
  /** Two-sided: the reference disables backface culling for this material. */
  TWO_SIDED: 0x04,
  EXTERIOR_LIGHT: 0x08,
  /** Self-illuminated at night — the authored emissive colour rides the night fraction. */
  SIDN: 0x10,
  /** A window pane: an interior batch swaps GL_LIGHT0 for the brighter midpoint pair. */
  WINDOW: 0x20,
  CLAMP_S: 0x40,
  CLAMP_T: 0x80,
} as const;

/** A `CImVector` as the chunk reader hands it over: four 0..255 bytes. */
export type MomtColor = { r: number; g: number; b: number; a: number };

/**
 * Which lighting law a batch takes, from its position in `MOBA`. The chunk orders batches trans,
 * int, ext, and the group loader numbers those ranges 1, 2, 3.
 */
export type BatchClass = 'trans' | 'int' | 'ext';

export type MaterialLighting = {
  /** `F_UNLIT`: bypass lighting entirely. Also suppresses emission — with GL_LIGHTING off, the
   *  fixed-function GL_EMISSION term is dead. */
  unlit: boolean;
  sidn: boolean;
  window: boolean;
  /** The authored emissive colour, normalized to 0..1, or black when the material is not SIDN. */
  sidnColor: [number, number, number];
  twoSided: boolean;
  clampS: boolean;
  clampT: boolean;
};

/**
 * Decode `MOMT.flags` plus the material's `sidnColor` word.
 *
 * Two things this fixes, both live bugs in the material class it replaces:
 *
 * 1. **UNLIT is `0x01`, not `0x10`.** The old code tested `0x10` — which is SIDN — under a comment
 *    naming `0x01`, so it force-unlit exactly the materials meant to glow at night and never unlit
 *    the ones that should be.
 * 2. **The colour is BYTES.** `MOMT` stores a `CImVector`; uploading its components raw put 0..255
 *    values into a term added to a 0..1 light sum, which saturates instantly. Normalize here, once.
 *
 * The colour is forced to black unless the SIDN flag is set: the chunk carries an authored colour on
 * materials that are not self-illuminated, and it must not glow.
 */
export function decodeMaterialLighting(flags: number, sidnColor: MomtColor): MaterialLighting {
  const sidn = (flags & MOMT_FLAG.SIDN) !== 0;
  return {
    unlit: (flags & MOMT_FLAG.UNLIT) !== 0,
    sidn,
    window: (flags & MOMT_FLAG.WINDOW) !== 0,
    sidnColor: sidn
      ? [sidnColor.r / 255, sidnColor.g / 255, sidnColor.b / 255]
      : [0, 0, 0],
    twoSided: (flags & MOMT_FLAG.TWO_SIDED) !== 0,
    clampS: (flags & MOMT_FLAG.CLAMP_S) !== 0,
    clampT: (flags & MOMT_FLAG.CLAMP_T) !== 0,
  };
}

/**
 * The batch's lighting class. Anything outside the known range is exterior — an exterior group's
 * batches have no meaningful class, and exterior is the plain law.
 */
export function batchClassOf(batchType: number): BatchClass {
  if (batchType === 1) {
    return 'trans';
  }
  if (batchType === 2) {
    return 'int';
  }
  return 'ext';
}

/** `MOGI`/`MOGP` group flag bits that decide the LIGHTING class. */
export const MOGI_FLAG = {
  /** An outdoor group — street, deck, terrace. */
  EXTERIOR: 0x8,
  /** An interior-graph group that is nonetheless LIT as outdoors: a porch, a courtyard. */
  EXTERIOR_LIT: 0x40,
} as const;

/**
 * Whether a group takes the INTERIOR lighting law.
 *
 * The reference forks the lighting class on `MOGI & 0x48` — either EXTERIOR (`0x8`) or EXTERIOR_LIT
 * (`0x40`) sends the group down the exterior leg (benilla `wmo_portal/mod.rs`, classify `0x6a87f0`).
 *
 * This is deliberately a SECOND notion of "interior", separate from the `interior` flag that drives
 * portal culling and camera containment — the reference keeps both, because an EXTERIOR_LIT-only
 * porch still claims the camera while lighting as outdoors. Do not collapse them.
 */
export function isLightingInterior(mogiFlags: number): boolean {
  return (mogiFlags & (MOGI_FLAG.EXTERIOR | MOGI_FLAG.EXTERIOR_LIT)) === 0;
}
