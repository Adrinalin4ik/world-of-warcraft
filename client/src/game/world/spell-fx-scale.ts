/**
 * THE SPELL-EFFECT PARTICLE SIZE, and **the measurement says the authored size is already correct.**
 *
 * The owner's report was "в момент каста появляются крошечные точки на руках" -- tiny dots. The round
 * that produced this file was scoped to find the multiplier the game's own data applies and pass it
 * through, on the reference's note that "the emitter *scale* comes from kit CharProc params x the
 * quality tier, never from this table" (`benilla-formats/src/spell_visual/mod.rs:59-61`).
 *
 * **Both candidate multipliers measure exactly 1 for every effect he is looking at, so there is no
 * data-side factor being dropped.** That is the finding, and it is why this file ships no number.
 *
 * ## What was measured
 *
 * **1. `SpellVisualEffectName`'s own scale columns.** 3.3.5a has FOUR columns 1.12 does not -- the
 * reference calls its fields 3/4 "dead-by-absence", but this build's table is 7 fields wide and
 * `dbc/entities/spell-visual-effect-name.js` names them `areaEffectSize`, `scale`, `minScale`,
 * `maxScale`. So the reference's "never from this table" is a 1.12 statement and had to be re-checked
 * here. Read off the served file for the effects in play:
 *
 *     id    path                                 areaEffectSize   scale   minScale   maxScale
 *     365   Spells\Fireball_Missile_Low.mdx              1.0000  1.0000     0.0100   100.0000
 *     288   Spells\Fire_Cast_Hand.mdx                   0.0000  1.0000     0.0100   100.0000
 *     1303  Spells\DustCloud_Land.mdx                   1.0000  1.0000     0.0100   100.0000
 *     634   Spells\ChargeTrail.mdx                      0.0000  1.0000     0.0100   100.0000
 *     284   Spells\Frost_Nova_state.mdx                 1.0000  1.0000     0.0100   100.0000
 *     54    Spells\Ice_Precast_Uber_Head.mdx            1.0000  1.0000     0.0100   100.0000
 *     321   Spells\MoltenBlast_Impact_Chest.mdx         0.0000  1.0000     0.0100   100.0000
 *
 * `scale` is **1.0 on every one**, and `minScale`/`maxScale` are permissive clamps (0.01 to 100), not
 * a size. Across the whole table `scale` is 1.0 on 1841 rows, 2.0 on 396 and 0.5 on 302 -- so the
 * column is real and does vary, and it simply does not vary for these effects.
 *
 * **2. The kit CharProc params.** Fireball's three kits carry NO CharProc slots at all -- kit 30
 * (precast), 38 (cast) and 286 (impact) each have all four type slots at `-1` and all twenty param
 * words at 0. There is nothing for a quality tier to multiply. (Charge's kit 44 does carry one, type
 * 8 with params `[14355216.0, 20.0, 1000.0, 100.0]`, but type 8 is not a key the reference names and
 * nothing here establishes it as a scale -- so it is left unread rather than pressed into service.)
 *
 * **3. The quality tier itself.** This client has none: there is no graphics-quality setting anywhere
 * in it, and the reference only ever applies the tier to an EMIT RATE, not a size -- "`params[1]` is
 * the emit rate the graphics-quality factor multiplies" (`mod.rs:364-365`), on the dynobject shard
 * chain rather than the attach-point emitters. So the tier is a named gap that changes nothing here,
 * because the thing it would multiply is absent anyway.
 *
 * ## So the sizes are correct, and the effects are genuinely small
 *
 * `ParticleBatch#pack` computes `scaleTrack(t) * worldScaleFactor * sizeScale`. Measured packed sizes
 * for `Fire_Precast_Hand` are 0.036 to 0.642 world units against a 2.03-tall human -- so the smallest
 * sprites really are a couple of centimetres. That is what the asset authors, and the reference is
 * explicit that the client does not second-guess it: "cadence/size/color/blend all authored in the
 * asset, the client sets none of them" (`creature_anim/spell_visual.rs:1235-1236`).
 *
 * `worldScaleFactor` is 1 for a spell effect and that is worth stating rather than assuming, because a
 * DOODAD's is not: `pack` extracts it from the instance's world matrix, and a doodad placed at scale 3
 * legitimately renders triple-size flames. Neither spell lane sets a model scale -- the kit lane
 * attaches to a bone and the missile lane only translates -- so nothing multiplies there either.
 *
 * ## WHICH LEAVES A JUDGEMENT THAT IS NOT MINE, and the precedent for it
 *
 * Making them bigger anyway would be a DEVIATION from the game's data, not a fidelity fix. This
 * project has taken exactly that deviation once, in the same circumstances and on the same complaint:
 * `world/game-object-sparkle.ts` sets `particleSize = 3` because the owner said "я бы сделал их
 * больше, они едва заметны", and its docstring labels it "OURS, not the client's" and cites the same
 * reference line about the asset authoring its own look.
 *
 * So the knob exists here and **defaults to 1, which changes nothing**. It is deliberately not tuned:
 * a number picked here until it looked right would be the one outcome worse than leaving it alone,
 * because it would be indistinguishable from fidelity while being invention. `window.worldSpellFxScale(n)`
 * lets the owner find the value the way the sparkle's 3 was found -- by looking -- and whatever he
 * settles on gets written here with his words beside it, as the sparkle's is.
 *
 * It is a PARTICLE size and not a model scale, which is the mistake the sparkle round made first:
 * scaling the model grows the emitter's VOLUME (every spawn position rides the world matrix, so the
 * cloud spreads) and he spotted it immediately -- "не увеличивает размер партикла, а только радиус
 * вокруг куста". `pack`'s `sizeScale` multiplies the size track alone.
 */

/**
 * The multiplier handed to `ParticleBatch#pack` as `sizeScale` for every spell-effect emitter.
 *
 * **1 = the authored size, unchanged.** See this file's header for the measurement that says 1 is what
 * the data asks for, and for why no other number is chosen here.
 */
let spellFxParticleScale = 1;

/** What the spawn lanes stamp onto each effect model. `pack` reads it per frame, per instance. */
export function spellFxParticleSize(): number {
  return spellFxParticleScale;
}

/**
 * Install `window.worldSpellFxScale(n)` -- the owner's instrument for answering the one question the
 * data cannot: whether the authored size reads on screen.
 *
 * Live: `pack` reads `particleSizeScale` off the instance every frame, so a change takes effect on the
 * next frame for effects already in flight, not just the next cast. Mirrors
 * `window.worldSparkleScale` deliberately, including returning the current value for a bad argument
 * rather than throwing.
 */
export function installSpellFxScaleKnob(live: () => Iterable<{ particleSizeScale?: number }>): void {
  (window as unknown as Record<string, unknown>).worldSpellFxScale = (value: number) => {
    const wanted = Number(value);
    if (!Number.isFinite(wanted) || wanted <= 0) {
      return `worldSpellFxScale: ignoring ${String(value)}; it stays ${spellFxParticleScale}`;
    }
    spellFxParticleScale = wanted;
    let retuned = 0;
    for (const instance of live()) {
      instance.particleSizeScale = wanted;
      retuned += 1;
    }
    return `worldSpellFxScale: ${wanted} (retuned ${retuned} live effect models)`;
  };
}
