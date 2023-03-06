import React from 'react';
import { AuthorizationStatus, SocketConnestionStatus } from '../../network/enums';
import { GameSession } from '../../network/session';
import './auth.scss';

interface Props {
  session: GameSession;
}

interface State {
  username: string;
  password: string;
}

class Auth extends React.Component<Props> {

  public state: State;

  constructor(props: Props) {
    super(props)

    this.state = {
      username: window.location.search.split('account=')[1] || 'Adrinalin4ik',
      password: 'Hi73s6dL',
    }
  }
  async authenticate(username: string, password: string) {
    // username = window.location.search.split('account=')[1] || this.state.username;
    const status = await this.props.session.authenticate(username, password);
    if (status.status === AuthorizationStatus.Success) {
      console.log('authenticate status' , status);
      window.location.href = '/realms' + window.location.search;
      // this.props.history.push('/realms' + window.location.search);
    }
  }

  async connect() {
    const status = await this.props.session.connect();
    if (status.status === SocketConnestionStatus.Connected) {
      this.authenticate(this.state.username, this.state.password);
    }
    console.log('connect status', status);
  }

  onConnect() {
    this.authenticate(this.state.username, this.state.password);
  }

  onSubmit(event: React.FormEvent) {
    event.preventDefault();
    this.connect();
  }

  onChange(event: React.ChangeEvent<HTMLInputElement>) {
    this.setState({
      [event.target.name]: event.target.value
    });
  }

  render() {
    return (
      <div className="auth screen">
        <div className="panel">
          <h1>Authentication</h1>

          <div className="divider"></div>

          <p>
            <strong>Note:</strong> Wowser requires a WebSocket proxy, see the README on GitHub.
          </p>

          <form onSubmit={ (e) => this.onSubmit(e) }>
            <fieldset>
              <label>Username</label>
              <input type="text" onChange={ (e) => this.onChange(e) }
                     name="username" value={ this.state.username } autoFocus />

              <label>Password</label>
              <input type="password" onChange={ (e) =>  this.onChange(e) }
                     name="password" value={ this.state.password } />
            </fieldset>

            <div className="divider"></div>

            <input type="submit" defaultValue="Connect" />
          </form>
        </div>
      </div>
    )
  }
}

export default Auth;
