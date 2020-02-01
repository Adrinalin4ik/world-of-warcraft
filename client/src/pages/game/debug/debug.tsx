import React from 'react';
import Game from '../../../game';

interface IProp {
  game: Game | null,
  renderer: THREE.WebGLRenderer | null
}

class DebugPanel extends React.Component<IProp> {

  private game: Game | null;
  private renderer: THREE.WebGLRenderer | null;

  constructor(props: IProp) {
    super(props);
    this.game = props.game;
    this.renderer = props.renderer;
    console.log("Debug component", this)
  }

  componentWillUnmount() {
    
  }

  mapStats() {
    if (!this.game) return;

    const map = this.game.world.map;

    return (
      <div>
        <div className="divider"></div>

        <h2>Map Chunks</h2>
        <div className="divider"></div>
        <p>
          Loaded: { map ? map.chunks.size : 0 }
        </p>

        <div className="divider"></div>

        <h2>Map Doodads</h2>
        <div className="divider"></div>
        <p>
          Loading: { map ? map.doodadManager.entriesPendingLoad.size : 0 }
        </p>
        <p>
          Loaded: { map ? map.doodadManager.doodads.size : 0 }
        </p>
        <p>
          Animated: { map ? map.doodadManager.animatedDoodads.size : 0 }
        </p>

        <div className="divider"></div>

        <h2>WMOs</h2>
        <div className="divider"></div>
        <p>
          Loading Entries: { map ? map.wmoManager.counters.loadingEntries : 0 }
        </p>
        <p>
          Loaded Entries: { map ? map.wmoManager.counters.loadedEntries : 0 }
        </p>
        <p>
          Loading Groups: { map ? map.wmoManager.counters.loadingGroups : 0 }
        </p>
        <p>
          Loaded Groups: { map ? map.wmoManager.counters.loadedGroups : 0 }
        </p>
        <p>
          Loading Doodads: { map ? map.wmoManager.counters.loadingDoodads : 0 }
        </p>
        <p>
          Loaded Doodads: { map ? map.wmoManager.counters.loadedDoodads : 0 }
        </p>
        <p>
          Animated Doodads: { map ? map.wmoManager.counters.animatedDoodads : 0 }
        </p>
      </div>
    );
  }

  render() {
    if (!this.game || !this.renderer) return null;

    const renderer = this.renderer;

    const map = this.game.world.map;

    const { memory, programs, render } = renderer.info;
    return (
      <div>
        <h2>Memory</h2>
        <div className="divider"></div>
        <p>
          Geometries: { memory.geometries }
        </p>
        <p>
          Textures: { memory.textures }
        </p>
        <p>
          Programs: { programs!.length }
        </p>

        <div className="divider"></div>

        {/* <h2>Render</h2>
        <div className="divider"></div>
        <p>
          Calls: { render.calls }
        </p>
        <p>
          Points: { render.points }
        </p>
        <p>
          Faces: { render.faces!.toString()}
        </p>
        <p>
          Vertices: { render.vertices }
        </p> */}

        { map && this.mapStats() }
      </div>
    );
  }

}

export default DebugPanel;
