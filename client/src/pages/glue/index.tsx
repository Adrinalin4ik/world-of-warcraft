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
import { FrameXmlLoginScreen } from '../../game/ui/screens/framexml-screen';
import { LoginScreen } from '../../game/ui/screens/login';
import { RealmListScreen } from '../../game/ui/screens/realms';

/**
 * `?ui=lua` mounts the login screen the FrameXML runtime builds from the client's own
 * `AccountLogin.xml`; anything else keeps the hand-written transcription.
 *
 * The DEFAULT stays the transcription deliberately. It is the screen that matches the reference
 * screenshots, and it is the ORACLE the runtime is being compared against -- so it holds `/` until the
 * side-by-side diff is clean, not until the runtime merely looks right.
 */
function wantsLuaUi(search: string): boolean {
  return new URLSearchParams(search).get('ui') === 'lua';
}

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
    this.app.register(
      ClientState.Login,
      wantsLuaUi(window.location.search) ? new FrameXmlLoginScreen() : new LoginScreen(),
    );
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
