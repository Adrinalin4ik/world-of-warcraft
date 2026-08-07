import * as THREE from 'three';

import { collisionWorld } from './collision-world';
import { CollisionLayer, Triangle } from './types';

/**
 * How far the centre must move before the wireframe is rebuilt (yards).
 *
 * The gather itself is the same work a cast does, so it is affordable -- but it is not free, and at
 * a walking pace nothing within the radius changes meaningfully between frames. Rebuilding on a
 * 2-yard step turns a per-frame cost into roughly a per-second one while the overlay still keeps up
 * with the player.
 */
export const COLLISION_DEBUG_REBUILD_STEP = 2;

/** Default half-extent of the gathered box (yards). Two WMO rooms across. */
export const COLLISION_DEBUG_RADIUS = 25;

/**
 * One colour per PROVIDER, because the question this overlay exists to answer is which provider a
 * face came from -- "the wall is drawn but nothing collides there" and "the tree has no hull" are
 * different bugs with different fixes, and they look identical in a single-colour wireframe.
 */
export const COLLISION_DEBUG_COLORS = {
  terrain: new THREE.Color(0x44dd66),
  wmo: new THREE.Color(0x4499ff),
  doodad: new THREE.Color(0xffaa33),
};

/** What the overlay gathered on its last rebuild, plus what is registered world-wide. */
export interface CollisionDebugCounts {
  terrain: number;
  wmo: number;
  doodad: number;
  total: number;
  registeredChunks: number;
  registeredWmoGroups: number;
  registeredHulls: number;
}

const _box = new THREE.Box3();

/**
 * A wireframe of the collision faces the movement and camera casts would actually see.
 *
 * Deliberately built from `CollisionWorld`'s own providers rather than from the scene graph: that is
 * the entire point. Collision does not come from what is drawn -- it comes from the WMO BSP, the
 * MCVT heightmap and each M2's authored hull -- so a wireframe of the render meshes would confirm
 * nothing. Every collision defect this project has hit so far has been a face that was drawn but
 * never gathered, and only a gather-side view can show that.
 *
 * The overlay draws only when enabled; disabled it does no gather, allocates nothing and leaves an
 * empty draw range.
 */
export class CollisionDebugView {
  /** The scene object. Add once at world construction; visibility follows `enabled`. */
  readonly object: THREE.LineSegments;

  readonly counts: CollisionDebugCounts = {
    terrain: 0,
    wmo: 0,
    doodad: 0,
    total: 0,
    registeredChunks: 0,
    registeredWmoGroups: 0,
    registeredHulls: 0,
  };

  private geometry = new THREE.BufferGeometry();

  private material: THREE.LineBasicMaterial;

  private positions = new Float32Array(0);

  private colors = new Float32Array(0);

  private lastCentre = new THREE.Vector3(Infinity, Infinity, Infinity);

  private dirty = true;

  /** Scratch, reused per rebuild so a steady overlay allocates nothing. */
  private scratch: Triangle[] = [];

  private _enabled = false;

  private _radius = COLLISION_DEBUG_RADIUS;

  private _layer = CollisionLayer.Walk;

  private _xray = true;

  constructor() {
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      // Fog would fade the overlay out at exactly the distances a "does anything collide over
      // there" question is asked at.
      fog: false,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
    });

    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.name = 'CollisionDebugView';
    this.object.visible = false;
    // The gathered set changes every rebuild and its bounds are never worth recomputing; the whole
    // overlay is a few thousand lines.
    this.object.frustumCulled = false;
    this.object.renderOrder = 999;
    this.object.matrixAutoUpdate = false;

    this.geometry.setDrawRange(0, 0);
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (this._enabled === value) {
      return;
    }
    this._enabled = value;
    this.object.visible = value;
    this.dirty = true;

    if (!value) {
      this.geometry.setDrawRange(0, 0);
      this.counts.terrain = 0;
      this.counts.wmo = 0;
      this.counts.doodad = 0;
      this.counts.total = 0;
    }
  }

  get radius(): number {
    return this._radius;
  }

  set radius(value: number) {
    if (this._radius === value) {
      return;
    }
    this._radius = value;
    this.dirty = true;
  }

  /**
   * Which AUDIENCE to show. The two differ only in the WMO MOPY filter, and that difference is
   * exactly what makes an overhang stop the camera but not the player -- so being able to flip
   * between them is how a camera-only complaint gets separated from a movement one.
   */
  get layer(): CollisionLayer {
    return this._layer;
  }

  set layer(value: CollisionLayer) {
    if (this._layer === value) {
      return;
    }
    this._layer = value;
    this.dirty = true;
  }

  /** Draw through walls. On answers "is there collision here at all"; off answers "does it line up
   * with what is drawn". Both questions come up, and they want opposite settings. */
  get xray(): boolean {
    return this._xray;
  }

  set xray(value: boolean) {
    if (this._xray === value) {
      return;
    }
    this._xray = value;
    this.material.depthTest = !value;
    this.material.needsUpdate = true;
  }

  /** Force a rebuild on the next `update`, wherever the centre is. */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Refresh the overlay around `centre` -- the player, normally. Cheap and early-returning when
   * disabled or when nothing has moved far enough to matter.
   */
  update(centre: THREE.Vector3): void {
    // The REGISTERED counts are refreshed unconditionally, ahead of the enabled gate, and this is a
    // fix rather than tidying. They used to be written only inside `rebuild()`, which the gate below
    // skips entirely -- so with the overlay checkbox off the panel showed "registered terrain chunks:
    // 0" for ever, whatever the world held. That reading was taken as evidence that a world-entry
    // fall happened because nothing had loaded; the live numbers on the same run were 441 terrain
    // chunks and 318 WMO groups. A registry size is three property reads, so there is no reason for
    // it to be behind a gate at all: what is expensive, and stays gated, is the GATHER below.
    this.counts.registeredChunks = collisionWorld.terrain.size;
    this.counts.registeredWmoGroups = collisionWorld.wmo.size;
    this.counts.registeredHulls = collisionWorld.doodads.size;

    if (!this._enabled) {
      return;
    }

    if (!this.dirty && this.lastCentre.distanceToSquared(centre)
      < COLLISION_DEBUG_REBUILD_STEP * COLLISION_DEBUG_REBUILD_STEP) {
      return;
    }

    this.dirty = false;
    this.lastCentre.copy(centre);
    this.rebuild(centre);
  }

  private rebuild(centre: THREE.Vector3): void {
    const r = this._radius;
    _box.min.set(centre.x - r, centre.y - r, centre.z - r);
    _box.max.set(centre.x + r, centre.y + r, centre.z + r);

    // Gathered per provider rather than in one pass and classified afterwards: the provider is
    // known exactly this way, with no guessing from the `source` object's type.
    const tris = this.scratch;

    tris.length = 0;
    collisionWorld.terrain.gather(_box, tris);
    const terrain = tris.length;

    collisionWorld.wmo.gather(_box, this._layer, tris);
    const wmo = tris.length - terrain;

    collisionWorld.doodads.gather(_box, tris);
    const doodad = tris.length - terrain - wmo;

    this.counts.terrain = terrain;
    this.counts.wmo = wmo;
    this.counts.doodad = doodad;
    this.counts.total = tris.length;
    // The three `registered*` counts are refreshed in `update()` instead, so they stay true while the
    // overlay is off.

    this.write(tris, terrain, wmo);
  }

  /** Three edges per triangle, six vertices, coloured by which provider's slice it fell in. */
  private write(tris: Triangle[], terrain: number, wmo: number): void {
    const vertexCount = tris.length * 6;
    this.ensureCapacity(vertexCount);

    const positions = this.positions;
    const colors = this.colors;

    let p = 0;

    for (let i = 0, len = tris.length; i < len; ++i) {
      const t = tris[i];

      const color = i < terrain
        ? COLLISION_DEBUG_COLORS.terrain
        : i < terrain + wmo
          ? COLLISION_DEBUG_COLORS.wmo
          : COLLISION_DEBUG_COLORS.doodad;

      const edges = [t.a, t.b, t.b, t.c, t.c, t.a];

      for (let e = 0; e < 6; ++e) {
        const v = edges[e];
        positions[p] = v.x;
        positions[p + 1] = v.y;
        positions[p + 2] = v.z;
        colors[p] = color.r;
        colors[p + 1] = color.g;
        colors[p + 2] = color.b;
        p += 3;
      }
    }

    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.setDrawRange(0, vertexCount);
  }

  /** Grow-only, doubling: a steady overlay stops reallocating after the first few rebuilds. */
  private ensureCapacity(vertexCount: number): void {
    if (this.positions.length >= vertexCount * 3 && this.positions.length > 0) {
      return;
    }

    let capacity = Math.max(2048, this.positions.length / 3);
    while (capacity < vertexCount) {
      capacity *= 2;
    }

    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
  }
}

/**
 * The process-wide overlay. One per client; `World` adds it to the scene and drives its `update`.
 */
export const collisionDebugView = new CollisionDebugView();

if (typeof window !== 'undefined') {
  (window as any).collisionDebug = collisionDebugView;
}
