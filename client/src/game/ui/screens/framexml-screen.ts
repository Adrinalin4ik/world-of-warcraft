/**
 * A `GlueScreen` that is the client's own interface, not a transcription of it.
 *
 * `screens/login.ts` builds `AccountLogin` by hand from `accountlogin.xml`, and it is right -- it
 * matches the reference screenshots of the real client. This screen builds the same thing by RUNNING
 * that XML. Both exist at once on purpose: the hand-written one is the ORACLE, so every difference
 * between them is a defect in the runtime until it is shown otherwise, and `/?ui=lua` versus `/` is how
 * that comparison is made. Nothing is deleted until the diff is clean.
 *
 * Two things this screen does that the document cannot do for itself, both named rather than hidden:
 *
 *  - **The background scene.** `AccountLogin` is a `<ModelFFX>` and `AccountLogin_OnLoad` calls
 *    `self:SetModel("...UI_MainMenu_Northrend.m2")`, but `MODEL.SetModel` is a warn-once stub: there is
 *    no per-widget model state and no bridge from one to `GlueSceneView`, which is driven by SCENE
 *    TOKENS from the host. So the host sets the same token the transcription does. That is not the
 *    document's decision being honoured -- it is the diff being kept about the UI layer instead of
 *    being swamped by a black background.
 *  - **The per-frame edit-box mirror**, which lives in `framexml/runtime.ts#update`.
 */
import { GlueContext, GlueScreen } from '../screens';
// TYPE-ONLY, and the dynamic `import()` in `mount` below is the reason: `framexml/runtime.ts` pulls in
// fengari, a whole Lua VM, and a value import here would put it in the main bundle for every visitor of
// every route -- including the default screen, which does not use it. It is also the module with the
// browser-hostile node requires webpack has to be told about (`config/webpack.config.js`); keeping it in
// its own chunk means a problem there cannot blank the page for a screen that never asked for Lua.
import type { GlueRuntime } from '../framexml/runtime';
import { wantsTrialScene } from './login-state';

export class FrameXmlLoginScreen implements GlueScreen {
  private ctx: GlueContext | null = null;
  private runtime: GlueRuntime | null = null;
  /**
   * Set by `unmount`. `mount` starts an async boot, and a state change during it would otherwise
   * leave a runtime nobody disposes attached to a root nobody draws.
   */
  private unmounted = false;

  mount(ctx: GlueContext): void {
    this.ctx = ctx;
    this.unmounted = false;

    // See the file comment: the host's token, because `SetModel` cannot reach the scene view.
    ctx.setScene({ kind: 'mainmenu', streamingTrial: wantsTrialScene(window.location.search) });

    void import('../framexml/runtime')
      .then(({ bootGlueRuntime }) =>
        bootGlueRuntime({
          root: ctx.root.root,
          art: ctx.art,
          protocol: ctx.protocol,
          stopAfter: 'AccountLogin.xml',
          onQuitGame: () => {
            // The same thing the transcription's Quit button can do in a browser: nothing to exit, so
            // leave an observable signal rather than pretending.
            window.dispatchEvent(new CustomEvent('wow:quit'));
          },
          onSetCurrentScreen: (name) => {
            console.log(`framexml: SetCurrentScreen(${name})`);
          },
        }),
      )
      .then((runtime) => {
        if (this.unmounted) {
          runtime.dispose();
          return;
        }
        this.runtime = runtime;
        reportLoad(runtime);
        // A console handle on the live runtime, in the spirit of `skyDebug` and `framexml.help()`.
        // This is how the screen is INTERROGATED rather than guessed at: `glueRuntime.vm.run('...')`
        // runs a line of Lua against the tree that is on screen, which is the only way to exercise
        // paths a static screenshot cannot reach -- an edit box's text region, for one, since nothing
        // in this runtime makes an XML-loaded box mouse-focusable yet.
        (window as never as Record<string, unknown>).glueRuntime = runtime;
      })
      .catch((error) => {
        // A boot that fails outright is the one thing `bootGlueRuntime` does not turn into a report
        // line, so it must not vanish into an unhandled rejection.
        console.error('framexml: the runtime failed to boot', error);
      });
  }

  update(dt: number): void {
    this.runtime?.update(dt);
  }

  unmount(): void {
    this.unmounted = true;
    // THE teardown path (`object.ts`'s `FRAME_TEARDOWN`): this releases every wrapper handle, every
    // stored script handler, every event registration and every side-table entry, then closes the VM.
    this.runtime?.dispose();
    this.runtime = null;
    this.ctx = null;
    delete (window as never as Record<string, unknown>).glueRuntime;
  }
}

/**
 * The load report, on the console, flat.
 *
 * Flat lines and a table, not `console.log('report', object)`: a collapsed object row is invisible
 * until expanded and copies as nothing, which would make the most useful output of this whole exercise
 * the one part that cannot be pasted into a bug report.
 */
function reportLoad(runtime: GlueRuntime): void {
  const { report, files } = runtime;
  console.log(
    `framexml: ${report.frames} frames from ${files.length} files, ` +
      `${report.warnings.length} warnings, ${report.errors.length} errors`,
  );
  console.table(
    files.map((file) => ({
      file: file.file,
      kind: file.kind,
      frames: file.frames,
      warnings: file.warnings.length,
      errors: file.errors.length,
    })),
  );
  report.warnings.forEach((warning, index) => console.warn(`framexml warning ${index + 1}: ${warning}`));
  report.errors.forEach((error, index) => console.error(`framexml error ${index + 1}: ${error}`));
}
