import React from 'react';
import { RouteComponentProps, withRouter } from "react-router-dom";
import Realm from '../../network/realms/realm';
import { GameSession } from '../../network/session';
import './realms.scss';

interface Props extends RouteComponentProps {
  session: GameSession;
}

interface State {
  realm: Realm | null,
  realmList: Realm[]
}

class RealmsScreen extends React.Component<Props, State> {
  public state: State = {
    realm: null,
    realmList: []
  }
  
  constructor(props: Props) {
    super(props);

    this.props.session.realms.on('refresh', this.onRefresh.bind(this));
    this.props.session.game.on('authenticate', () => {
      this.props.history.push('/characters'  + window.location.search);
    });

    this.refresh();
  }
  connect(realm: Realm) {
    this.props.session.game.connect(this.props.session.auth.host, realm);
  }

  refresh() {
    this.props.session.realms.refresh();
  }

  onRealmSelect(event: React.ChangeEvent<HTMLSelectElement>) {
    const realms = this.props.session.realms.list;
    this.setState({
      realm: realms[event.target.selectedIndex]
    });
  }

  onRefresh() {
    const realms = this.props.session.realms.list;
    this.setState({
      realm: realms[0],
      realmList: realms
    });
  }

  onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const realm = this.state.realm;
    if (realm) {
      // this.connect(realm);
      this.connect( this.props.session.realms.list[1]);
    }
  }

  render() {
    return (
      <div className="realms screen">
        <div className="panel">
          <h1>Realm Selection</h1>
  
          <div className="divider"></div>
  
          <form onSubmit={ (e) => this.onSubmit(e) }>
            <fieldset>
              <select value={ this.state.realm?.name }
                      onChange={ (e) => this.onRealmSelect(e) }>
                { this.state.realmList.map((realm) => {
                  return (
                    <option key={ realm.ord } value={ realm.name }>
                      { realm.name }
                    </option>
                  );
                }) }
              </select>
            </fieldset>
  
            <div className="divider"></div>
  
            <input type="submit" value="Connect" autoFocus />
            <input type="button" value="Refresh" onClick={ () => this.refresh() } />
          </form>
        </div>
      </div>
    );
  }
}

export default withRouter(RealmsScreen);
