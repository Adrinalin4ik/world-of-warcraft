import React from 'react';
import { RouteComponentProps, withRouter } from "react-router-dom";
import Character from '../../network/characters/character';
import { GameSession } from '../../network/session';

interface Props extends RouteComponentProps {
  session: GameSession
}

interface State {
  character: Character | null;
  characterIndex: number;
  characterList: Character[];
}

class CharactersScreen extends React.Component<Props, State> {

  static id = 'characters';
  static title = 'Character Selection';

  public state: State = {
    character: null,
    characterIndex: 0,
    characterList: []
  }
  constructor(props: Props) {
    super(props);

    this.props.session.characters.on('refresh', this.onRefresh.bind(this));
    this.props.session.game.on('join', this.onJoin.bind(this));

    this.refresh();
  }

  componentWillUnmount() {
    this.props.session.characters.removeListener('refresh', this.onRefresh.bind(this));
    this.props.session.game.removeListener('join', this.onJoin.bind(this));
  }

  refresh() {
    this.props.session.characters.refresh();
  }

  onCharacterSelect(event: React.ChangeEvent<HTMLSelectElement>) {
    const index = parseInt(event.target.value);
    this.setState({
      characterIndex: index,
      character: this.state.characterList[index]
    });
  }

  onJoin() {
    this.props.history.push('/game' + window.location.search);
  }

  onRefresh() {
    const characters = this.props.session.characters.list;
    this.setState({
      character: characters[0],
      characterList: characters
    });
  }

  onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const character = this.state.character;
    if (character) {
      const joined = this.props.session.game.join(character);
      if (joined) {
        this.props.history.push('/game'  + window.location.search);
      }
    }
  }

  render() {
    return (
      <div className="characters screen">
        <div className="panel">
          <h1>Character Selection</h1>

          <div className="divider"></div>

          <p>
            If you want to create a character, please use the official WoW Client
          </p>

          <form onSubmit={ (e) => this.onSubmit(e) }>
            <fieldset>
              <select value={ this.state.characterIndex }
                      onChange={ (e) => this.onCharacterSelect(e) }>
                { this.state.characterList.map((character, index) => {
                  return (
                    <option key={ index } value={ index }>
                      { character.name }
                    </option>
                  );
                }) }
              </select>
            </fieldset>

            <div className="divider"></div>

            <input type="submit" value="Join world" autoFocus />
            <input type="button" value="Refresh" onClick={ this.refresh.bind(this) } />
          </form>
        </div>
      </div>
    );
  }

}

export default withRouter(CharactersScreen);
