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
import { FrameXmlGlueScreen } from '../../game/ui/screens/framexml-screen';
import { LoginScreen } from '../../game/ui/screens/login';
import { RealmListScreen } from '../../game/ui/screens/realms';

/**
 * `?ui=lua` mounts the glue screen the FrameXML runtime builds from the client's own GlueXML manifest --
 * `AccountLogin.xml` and `RealmList.xml` both, from one Lua VM; anything else keeps the hand-written
 * transcriptions.
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
    if (wantsLuaUi(window.location.search)) {
      // ONE instance for both glue states, and that is the whole wiring of the realm list: the
      // manifest this screen loads already contains `RealmList.xml`, the client's own
      // `RealmList_OnEvent` shows it on `OPEN_REALM_LIST` (which `lua/api/realms.ts` fires from the
      // session), and `GlueApp#enter` skips the remount for a screen it is already showing. Registering
      // two instances instead would reboot the Lua VM between the two, and registering NOTHING for
      // `RealmList` would work by accident -- `onSessionState` skips a state with no screen -- while
      // leaving the machine claiming the login screen was still up.
      const glue = new FrameXmlGlueScreen();
      this.app.register(ClientState.Login, glue);
      this.app.register(ClientState.RealmList, glue);
      // ...and CharSelect, on the same instance and for the same reason. `CharacterSelect.xml` is
      // inside the manifest this screen loads now, and the client's own `SET_GLUE_SCREEN` ->
      // `GlueScreenExit` -> `SetGlueScreen("charselect")` path shows it. A second instance here would
      // reboot the Lua VM at exactly the moment the roster arrives.
      this.app.register(ClientState.CharSelect, glue);
    } else {
      this.app.register(ClientState.Login, new LoginScreen());
      this.app.register(ClientState.RealmList, new RealmListScreen());
      this.app.register(ClientState.CharSelect, new CharacterStubScreen());
    }
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
