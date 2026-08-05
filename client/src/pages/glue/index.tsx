/**
 * The glue host: a full-window canvas and nothing else.
 *
 * React's entire role in the pre-world screens is this component. Widgets, input and state live in
 * `game/ui`, so there is no React state here to keep in step with the glue tree.
 */
import React from 'react';

import { GameSession } from '../../network/session';
import { ClientState, GlueApp } from '../../game/ui/screens';
import { CharacterStubScreen } from '../../game/ui/screens/character-stub';
import { LoginScreen } from '../../game/ui/screens/login';
import { RealmListScreen } from '../../game/ui/screens/realms';

interface Props {
  session: GameSession;
}

class GlueHost extends React.Component<Props> {
  private canvas = React.createRef<HTMLCanvasElement>();
  private app: GlueApp | null = null;

  componentDidMount(): void {
    const canvas = this.canvas.current;
    if (!canvas) {
      return;
    }

    this.app = new GlueApp(canvas, this.props.session);
    this.app.register(ClientState.Login, new LoginScreen());
    this.app.register(ClientState.RealmList, new RealmListScreen());
    this.app.register(ClientState.CharSelect, new CharacterStubScreen());
    void this.app.start(ClientState.Login);
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
