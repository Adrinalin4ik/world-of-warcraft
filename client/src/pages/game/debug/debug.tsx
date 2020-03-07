import React from 'react';
import Game from '../../../game';
import './debug.scss';

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

  getSnapshotBeforeUpdate(prevProps:IProp, _prevState:any) {
    this.renderer = prevProps.renderer;
    this.game = prevProps.game;
  }

  playerStats() {
    if (!this.game) return;
    const player = this.game.world.player;
    
    return (
      <div>
        <div className="divider"></div>
        <p>
          Map Id: { player.mapId }
        </p>
        <p>
          x: { Math.round(player.position.x) }
        </p>
        <p>
          y: { Math.round(player.position.y) }
        </p>
        <p>
          z: { Math.round(player.position.z) }
        </p>
        <p>
          Ground distance: { player.groundDistance.toFixed(2) }
        </p>
        <p>
          On ground: { player.isOnGround.toString() }
        </p>
        <p>
          Jump: { player.isJump.toString() }
        </p>
        <p>
          Jump velocity: { player.jumpVelocity.toFixed(2) }
        </p>
        <p>
          Slope type: { player.slopeType == 0 ? 'sliding' : 'climbing' }
        </p>
        <p>
          Slope ang: { player.slopeAng.toFixed(2) }
        </p>
        <p>
          Moving forward: { player.moving.forward.toString() }
        </p>
        <p>
          Moving backward: { player.moving.backward.toString() }
        </p>
        <p>
          Moving right: { player.moving.strafeRight.toString() }
        </p>
        <p>
          Moving left: { player.moving.strafeLeft.toString() }
        </p>
        <p>
          Rotate right: { player.moving.rotateRight.toString() }
        </p>
        <p>
          Rotate left: { player.moving.rotateLeft.toString() }
        </p>
        <p>
          Animation index: { player.currentAnimationIndex.toString() }
        </p>
        <div className="divider"></div>
        {/* <p>
          Collides: { player.isCollide() ? 'true' : 'false' }
        </p> */}
      </div>
    )
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
        <div>
          
        </div>
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

    const { memory, programs } = renderer.info;
    return (
      <div className="stats">
        <h2>Player</h2>
        { this.playerStats() }
        {/* <h2>Memory</h2>
        <div className="divider"></div>
        <p>
          Geometries: { memory.geometries }
        </p>
        <p>
          Textures: { memory.textures }
        </p>
        <p>
          Programs: { programs!.length }
        </p> */}

        <div className="divider"></div>
        {/* <div className="mapStat">
          { map && this.mapStats() }
        </div> */}
      </div>
    );
  }

}

export default DebugPanel;
