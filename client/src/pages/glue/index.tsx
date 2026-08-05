/**
 * The glue host: a full-window canvas and nothing else.
 *
 * React's entire role in the pre-world screens is this component. Widgets, input and state live in
 * `game/ui`, so there is no React state here to keep in step with the glue tree.
 */
import React from 'react';

import { GlueApp } from '../../game/ui/screens';
import { ProbeScreen, PROBE_STATE } from '../../game/ui/screens/probe';

class GlueHost extends React.Component {
  private canvas = React.createRef<HTMLCanvasElement>();
  private app: GlueApp | null = null;

  componentDidMount(): void {
    const canvas = this.canvas.current;
    if (!canvas) {
      return;
    }

    this.app = new GlueApp(canvas);
    this.app.register(PROBE_STATE, new ProbeScreen());
    void this.app.start(PROBE_STATE);
  }

  componentWillUnmount(): void {
    this.app?.stop();
    this.app = null;
  }

  render(): React.ReactNode {
    return (
      <canvas
        ref={this.canvas}
        style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />
    );
  }
}

export default GlueHost;
