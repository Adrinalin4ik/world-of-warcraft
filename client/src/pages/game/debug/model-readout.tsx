import React from 'react';

import { BatchReport, ModelReport } from '../../../game/pipeline/m2/model-probe';

/**
 * The slice of `ModelProbe` this section drives. Structural, like the other panel targets, so the
 * component is testable against a plain object with no renderer and no loaded model.
 */
export type ModelReadoutTarget = {
  enabled: boolean;
  /** Swap every batch to flat magenta, depth test off -- the bisection, see `ModelProbe`. */
  flatColor: boolean;
  read(camera: any): ModelReport;
};

type Props = {
  probe: ModelReadoutTarget | null;
  camera: any;
};

const yn = (v: boolean) => (v ? 'yes' : 'NO');

/** One line per batch: the four facts that separate the failure modes, then the alpha terms. */
function BatchRow({ b }: { b: BatchReport }) {
  return (
    <p>
      <strong>{b.submesh}.{b.batch}</strong>
      {b.skinned ? ' skinned' : ' static'}
      {' | vis '}{yn(b.visible)}
      {' frustum '}{yn(b.inFrustum)}
      {' drawn '}{yn(b.drawn)}
      <br />
      &nbsp;&nbsp;{b.vertexShader ?? '?'} / {b.fragmentShader ?? '?'}
      {' blend '}{b.blendingMode ?? '?'}
      {' tex '}{b.texturesReady}/{b.textureCount}
      <br />
      &nbsp;&nbsp;fade {b.fadeAlpha ?? '?'} trans {b.animatedTransparency ?? '?'}
      {' opacity '}{b.opacity}
      {' alphaKey '}{b.alphaKey ?? '?'}
      <br />
      &nbsp;&nbsp;fog {b.fogParams ? b.fogParams.slice(0, 3).map((v) => v.toFixed(4)).join(', ') : 'unset'}
      {' '}{b.fogColor ?? ''}
      {' mod '}{b.fogModifier ?? '?'}
      { b.skin && (
        <>
          <br />
          &nbsp;&nbsp;bones {b.skin.bones}
          {' zero '}{b.skin.zeroMatrices}
          {' nan '}{b.skin.nonFiniteMatrices}
          {' wsum '}{b.skin.sampleWeightSum === null ? '?' : b.skin.sampleWeightSum.toFixed(3)}
          <br />
          &nbsp;&nbsp;v0 {vec(b.skin.samplePosition)} &rarr; {vec(b.skin.sampleSkinned)}
        </>
      ) }
      { b.textures.map((t, i) => (
        <React.Fragment key={i}>
          <br />
          &nbsp;&nbsp;tex{i} {t.name ? t.name.split('\\').pop() : '?'}
          {' '}{t.width ?? '?'}x{t.height ?? '?'}
          {t.compressed ? ' compressed' : ''}
          <br />
          &nbsp;&nbsp;&nbsp;&nbsp;mean {t.mean
            ? t.mean.map((v) => v.toFixed(1)).join(', ')
            : (t.compressed ? 'n/a (compressed)' : 'n/a')}
          {' over '}{t.sampled}
        </React.Fragment>
      )) }
      { b.shading && (
        <>
          <br />
          &nbsp;&nbsp;albedo x {vec(b.shading.vertexColorRGB)} a {b.shading.vertexColorAlpha ?? '?'}
          <br />
          &nbsp;&nbsp;lighting {b.shading.useLighting ?? '?'}
          {' sun '}{b.shading.sunDiffuse ?? '?'} amb {b.shading.sunAmbient ?? '?'}
          {' int '}{b.shading.sunIntensity ?? '?'}
          <br />
          &nbsp;&nbsp;matParams {b.shading.materialParams
            ? b.shading.materialParams.map((v) => v.toFixed(2)).join(', ') : '?'}
          {' probe '}{b.shading.interiorProbe ?? '?'}
        </>
      ) }
      { b.world && (
        <>
          <br />
          &nbsp;&nbsp;matrixWorld {vec(b.world.matrixWorldPosition)}
          <br />
          &nbsp;&nbsp;sphere {vec(b.world.sphereCentre)} r{' '}
          { b.world.sphereRadius === null ? '?' : b.world.sphereRadius.toFixed(2) }
          <br />
          &nbsp;&nbsp;world {vec(b.world.sampleWorld)}
          <br />
          &nbsp;&nbsp;ndc { b.world.behindCamera ? 'BEHIND EYE' : vec(b.world.sampleNdc) }
          {' on-screen '}{yn(b.world.onScreen)}
        </>
      ) }
    </p>
  );
}

const vec = (v: [number, number, number] | null) =>
  (v === null ? 'n/a' : `(${v.map((n) => (Number.isFinite(n) ? n.toFixed(3) : String(n))).join(', ')})`);

/**
 * The Player model section of the debug panel.
 *
 * The whole draw chain in one readout, ending in a verdict. This exists because the invisible
 * character body has been misdiagnosed five times in a row here, and every one of those was a
 * plausible story about a link nobody had measured -- the bind pose, the bone weights, the fog
 * uniforms, `USE_SKINNING`. Three of those were real bugs and none of them was the cause.
 *
 * The decisive field is `drawn`, which no amount of code reading produces: it is stamped by the
 * renderer itself through `onAfterRender`. Everything upstream of a missing draw is a scene-graph
 * question; everything downstream is a shader question, and the two want opposite searches.
 */
export default class ModelReadout extends React.Component<Props> {
  render() {
    const probe = this.props.probe;

    if (!probe) {
      return <div className="model_readout">no probe</div>;
    }

    if (!probe.enabled) {
      return (
        <div className="model_readout">
          <p>
            <label>
              <input
                type="checkbox"
                checked={false}
                onChange={() => { probe.enabled = true; this.forceUpdate(); }}
              />
              &nbsp;Probe the player model
            </label>
          </p>
          <p>off &mdash; nothing is stamped or read while this is unchecked</p>
        </div>
      );
    }

    const report = probe.read(this.props.camera);

    return (
      <div className="model_readout">
        <p>
          <label>
            <input
              type="checkbox"
              checked
              onChange={() => { probe.enabled = false; this.forceUpdate(); }}
            />
            &nbsp;Probe the player model
          </label>
        </p>

        <p>
          <label>
            <input
              type="checkbox"
              checked={probe.flatColor}
              onChange={(e) => { probe.flatColor = e.target.checked; this.forceUpdate(); }}
            />
            &nbsp;Force flat magenta, no depth test
          </label>
        </p>

        <p className="model_readout-verdict">{ report.verdict }</p>

        <div className="divider"></div>

        <p>model: { report.hasModel ? (report.path ?? 'unnamed') : 'none' }</p>
        <p>submeshes: { report.submeshes } &nbsp; batches: { report.batches.length }</p>
        { report.hiddenAncestor && <p>hidden by: { report.hiddenAncestor }</p> }

        { report.batches.length > 0 && <div className="divider"></div> }
        { report.batches.map((b) => <BatchRow key={`${b.submesh}.${b.batch}`} b={b} />) }
      </div>
    );
  }
}
