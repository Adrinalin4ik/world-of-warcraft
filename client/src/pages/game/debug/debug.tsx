import React from 'react';
import * as THREE from 'three';
import { GameHandler } from '../../../network/game/handler';
import CollapsibleSection from './collapsible-section';
import CollisionControls from './collision-controls';
import ModelReadout from './model-readout';
import MoveReadout from './move-readout';
import SavedCoords from './saved-coords';
import WmoControls from './wmo-controls';
import FogControls from './fog-controls';
import LightControls from './light-controls';
import { wmoDebug } from '../../../game/world/wmo-debug';
import { fogDebug } from '../../../game/world/fog-debug';
import { lightDebug } from '../../../game/world/light-debug';
import { modelProbe } from '../../../game/pipeline/m2/model-probe';
import LightingControls from './lighting-controls';
import LightingReadouts from './lighting-readouts';
import './debug.scss';

interface IProp {
  game: GameHandler | null,
  renderer: THREE.WebGLRenderer | null
}

class DebugPanel extends React.Component<IProp> {


  public static test1: string = "";
  public static test2: string = "";
  public static test3: string = "";

  static vector3ToString(v: {x: number, y: number, z: number}) {
    return `${v.x}, ${v.y}, ${v.z}`
  }

  static frustumToString(frustum: any[]) {
    return `[0]:${DebugPanel.vector3ToString(frustum[0].normal)},
    [1]:${DebugPanel.vector3ToString(frustum[1].normal)},
    [2]:${DebugPanel.vector3ToString(frustum[2].normal)},
    [3]:${DebugPanel.vector3ToString(frustum[3].normal)},
    [4]:${DebugPanel.vector3ToString(frustum[4].normal)},
    [5]:${DebugPanel.vector3ToString(frustum[5].normal)}`
  }

  playerStats() {
    if (!this.props.game) return;
    const player = this.props.game.world.player;
    
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
          facing: { (player.move.faceYaw * 180 / Math.PI).toFixed(1) }&deg;
          &nbsp;body: { (player.move.modelYaw * 180 / Math.PI).toFixed(1) }&deg;
        </p>
        <p>
          vz: { player.move.velZ.toFixed(2) }
          &nbsp;horiz: { player.move.horizVel.length().toFixed(2) }
        </p>
        <p>
          airborne: { player.move.airborneSince === null ? 'no' : 'yes' }
          &nbsp;fallFar: { player.move.fallFar.toString() }
          &nbsp;wedged: { player.move.wedged.toString() }
        </p>
        <p>
          swimming: { player.move.swimming.toString() }
          &nbsp;pitch: { (player.move.swimPitch * 180 / Math.PI).toFixed(1) }&deg;
          &nbsp;stroke: { player.move.swimStrokeSpeed.toFixed(2) }
        </p>
        <p>
          collision height: { player.collisionHeight.toFixed(3) }
        </p>
        <MoveReadout />
        <div className="divider"></div>
        <SavedCoords player={ player } />
        <div className="divider"></div>
        {/* <p>
          Collides: { player.isCollide() ? 'true' : 'false' }
        </p> */}
      </div>
    )
  }

  mapStats() {
    if (!this.props.game) return;

    const map = this.props.game.world.map;

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
    if (!this.props.game || !this.props.renderer) return null;

    const renderer = this.props.renderer;

    const map = this.props.game.world.map;

    const { memory, programs } = renderer.info;
    return (
      <div className="stats">
        <CollapsibleSection title="Tests" storageKey="tests" defaultCollapsed={true}>
          <p>
            Test1: {DebugPanel.test1}
          </p>
          <p>
            Test2: {DebugPanel.test2}
          </p>
          <p>
            Test3: {DebugPanel.test3}
          </p>
        </CollapsibleSection>
        <CollapsibleSection title="Player" storageKey="player" defaultCollapsed={true}>
          { this.playerStats() }
        </CollapsibleSection>
        <CollapsibleSection title="Player model" storageKey="player-model" defaultCollapsed={true}>
          <ModelReadout
            probe={ modelProbe }
            camera={ this.props.game.camera }
            renderer={ this.props.renderer }
          />
        </CollapsibleSection>
        <CollapsibleSection title="WMO surfaces" storageKey="wmo-surfaces" defaultCollapsed={true}>
          <WmoControls wmo={ wmoDebug } />
        </CollapsibleSection>
        <CollapsibleSection title="Collisions" storageKey="collisions" defaultCollapsed={true}>
          <CollisionControls view={ this.props.game.world.collisionDebug } />
        </CollapsibleSection>
        <CollapsibleSection title="Lighting" storageKey="lighting" defaultCollapsed={false}>
          <FogControls fog={ fogDebug } />
          <LightControls light={ lightDebug } />
          <div className="divider"></div>
          <LightingControls mapLight={ this.props.game.world.map ? this.props.game.world.map.mapLight : null } />
        </CollapsibleSection>
        <CollapsibleSection title="Lighting resolve" storageKey="lighting-resolve" defaultCollapsed={false}>
          <LightingReadouts
            mapLight={ this.props.game.world.map ? this.props.game.world.map.mapLight : null }
            cloudReadout={ this.props.game.world.skyManager.getCloudReadout() }
          />
        </CollapsibleSection>
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
