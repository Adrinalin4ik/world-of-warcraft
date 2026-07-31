import * as THREE from 'three';

import ContentQueue from '../../utils/content-queue';
import M2Blueprint from '../m2/blueprint';
import { attachPerObjectLighting } from '../m2/material/per-object-light';
import WMOGroupLoader from './group/loader';
import WMORootLoader from './root/loader';
import { cap96, floor112, foldInteriorProbe, selectPointLights } from '../../world/light/laws';
import { worldSpaceLightsForWmo } from '../../world/light/wmo-lights';

import gameSettings from '../../settings';

class WMO {

  static LOAD_GROUP_INTERVAL = gameSettings.wmo.group.loadInterval;
  static LOAD_GROUP_WORK_FACTOR = gameSettings.wmo.group.workFactor;
  static LOAD_GROUP_WORK_MIN = gameSettings.wmo.group.loadMin;

  static LOAD_DOODAD_INTERVAL = gameSettings.wmo.doodad.loadInterval;
  static LOAD_DOODAD_WORK_FACTOR = gameSettings.wmo.doodad.workFactor;
  static LOAD_DOODAD_WORK_MIN = gameSettings.wmo.doodad.loadMin;

  constructor(filename, doodadSetIndex = null, entryID = null, parentCounters = null, particleManager = null) {
    this.filename = filename;
    this.doodadSetIndex = doodadSetIndex;
    this.entryID = entryID;
    this.particleManager = particleManager;

    this.counters = this.stubCounters();
    this.parentCounters = parentCounters || this.stubCounters();

    this.root = null;
    this.groups = new Map();

    this.doodads = new Map();
    this.animatedDoodads = new Map();

    this.doodadSet = [];

    this.doodadRefs = {
      doodad: new Map(),
      group: new Map()
    };

    // Which group's lighting a doodad takes. Keyed per WMO INSTANCE, never on the doodadEntry --
    // WMORootLoader caches WMORoot and its doodadEntries by FILENAME, so those objects are shared by
    // every placement of this building in the world. Writing placement-dependent state onto them
    // would leak one placement's light onto all the others.
    //
    // First referencing group wins: the reference creates a doodad once, on the first visible-group
    // walk that names it, and that create freezes its lighting lane.
    this.doodadLightingGroups = new Map();

    this.views = {
      root: null,
      groups: new Map(),
      portals: new Map()
    };

    this.queues = {
      loadGroup: new ContentQueue(
        this.processLoadGroup.bind(this),
        this.constructor.LOAD_GROUP_INTERVAL,
        this.constructor.LOAD_GROUP_WORK_FACTOR,
        this.constructor.LOAD_GROUP_WORK_MIN
      ),

      loadDoodad: new ContentQueue(
        this.processLoadDoodad.bind(this),
        this.constructor.LOAD_DOODAD_INTERVAL,
        this.constructor.LOAD_DOODAD_WORK_FACTOR,
        this.constructor.LOAD_DOODAD_WORK_MIN
      )
    };

    this.pendingUnload = null;
    this.unloading = false;
  }

  stubCounters() {
    return {
      loadingGroups: 0,
      loadingDoodads: 0,
      loadedGroups: 0,
      loadedDoodads: 0,
      animatedDoodads: 0
    };
  }

  load() {
    // REMOVE THIS
    // if (!this.filename.includes('NIGHTELFSMALLHOUSE_WSG')) return Promise.reject();
    // if (!this.filename.includes('CTFNIGHTELF_A')) return Promise.reject(); // tonnel
    return WMORootLoader.load(this.filename).then((root) => {
      this.root = root;
      // const rootView = this.root.createView();
      // this.views.root = rootView;
      this.views.root = this.root.view;

      this.loadPortals(this.root.portals);

      if (this.doodadSetIndex !== null) {
        this.doodadSet = this.root.doodadSet(this.doodadSetIndex);
      }

      this.enqueueLoadGroups();

      return this;
    });
  }

  enqueueLoadGroups() {
    const { exteriorGroupIndices, interiorGroupIndices } = this.root;

    for (let egi = 0, eglen = exteriorGroupIndices.length; egi < eglen; ++egi) {
      const groupIndex = exteriorGroupIndices[egi];
      this.enqueueLoadGroup(groupIndex);
    }

    for (let igi = 0, iglen = interiorGroupIndices.length; igi < iglen; ++igi) {
      const groupIndex = interiorGroupIndices[igi];
      this.enqueueLoadGroup(groupIndex);
    }
  }

  enqueueLoadGroup(groupIndex) {
    // Already loaded.
    if (this.groups.has(groupIndex)) {
      return;
    }

    this.queues.loadGroup.add(groupIndex, groupIndex);

    this.parentCounters.loadingGroups++;
    this.counters.loadingGroups++;
  }

  processLoadGroup(groupIndex) {
    // Already loaded.
    if (this.groups.has(groupIndex)) {
      this.parentCounters.loadingGroups--;
      this.counters.loadingGroups--;
      return;
    }

    WMOGroupLoader.loadByIndex(this.root, groupIndex).then((group) => {
      if (this.unloading) {
        return;
      }

      this.loadGroup(group);

      this.parentCounters.loadingGroups--;
      this.counters.loadingGroups--;
      this.parentCounters.loadedGroups++;
      this.counters.loadedGroups++;
    });
  }

  loadGroup(group) {
    // const groupView = group.createView();
    const groupView = group.view;
    this.placeGroupView(groupView);
    this.views.groups.set(group.index, groupView);

    this.groups.set(group.index, group);

    if (group.doodadRefs) {
      this.enqueueLoadGroupDoodads(group);
    }
  }

  loadPortals(portals) {
    for (let index = 0; index < portals.length; ++index) {
      const portal = portals[index];

      const portalView = portal.createView();
      this.views.portals.set(index, portalView);
      this.placePortalView(portalView);
    }
  }

  enqueueLoadGroupDoodads(group) {
    group.doodadRefs.forEach((doodadIndex) => {
      const doodadEntry = this.doodadSet.entries[doodadIndex - this.doodadSet.start];

      // Since the doodad set is filtered based on the requested set in the entry, not all
      // doodads referenced by a group will be present.
      if (!doodadEntry) {
        return;
      }

      // Assign the index as an id property on the entry.
      doodadEntry.id = doodadIndex;

      // Record the owning group on THIS instance's map (never on doodadEntry -- see the field's
      // comment in the constructor). First writer wins.
      if (!this.doodadLightingGroups.has(doodadEntry.id)) {
        this.doodadLightingGroups.set(doodadEntry.id, group);
      }

      const refCount = this.addDoodadRef(doodadEntry, group);

      // Only enqueue load on the first reference, since it'll already have been enqueued on
      // subsequent references.
      if (refCount === 1) {
        this.enqueueLoadDoodad(doodadEntry);
      }
    });
  }

  enqueueLoadDoodad(doodadEntry) {
    // Already loading or loaded.
    if (this.queues.loadDoodad.has(doodadEntry.id) || this.doodads.has(doodadEntry.id)) {
      return;
    }

    this.queues.loadDoodad.add(doodadEntry.id, doodadEntry);

    this.parentCounters.loadingDoodads++;
    this.counters.loadingDoodads++;
  }

  processLoadDoodad(doodadEntry) {
    // Already loaded.
    if (this.doodads.has(doodadEntry.id)) {
      this.parentCounters.loadingDoodads--;
      this.counters.loadingDoodads--;
      return;
    }

    M2Blueprint.load(doodadEntry.filename).then((doodad) => {
      if (this.unloading) {
        return;
      }

      this.loadDoodad(doodadEntry, doodad);

      this.parentCounters.loadingDoodads--;
      this.counters.loadingDoodads--;
      this.parentCounters.loadedDoodads++;
      this.counters.loadedDoodads++;

      if (doodad.animated) {
        this.parentCounters.animatedDoodads++;
        this.counters.animatedDoodads++;
      }
    });
  }

  loadDoodad(doodadEntry, doodad) {
    doodad.entryID = doodadEntry.id;

    this.placeDoodad(doodadEntry, doodad);

    // World position is only valid once placeDoodad has updated this instance's world matrix.
    this.foldDoodadLighting(doodadEntry, doodad);

    // if (doodad.animated) {
    //   this.animatedDoodads.set(doodadEntry.id, doodad);

    //   if (doodad.animations.length > 0) {
    //     // TODO: Do WMO doodads have more than one animation? If so, which one should play?
    //     doodad.animations.playAnimation(0);
    //     doodad.animations.playAllSequences();
    //   }
    // }

    this.doodads.set(doodadEntry.id, doodad);

    if (this.particleManager) {
      this.particleManager.register(doodad);
    }
  }

  unload() {
    this.unloading = true;

    this.queues.loadGroup.clear();
    this.queues.loadDoodad.clear();

    this.counters.loadingGroups = 0;
    this.counters.loadedGroups = 0;
    this.counters.loadingDoodads = 0;
    this.counters.loadedDoodads = 0;
    this.counters.animatedDoodads = 0;

    for (const group of this.groups.values()) {
      WMOGroupLoader.unload(group);
      // ColliderManager.collidableMeshList.delete(group.uuid);
    }

    for (const doodad of this.doodads.values()) {
      if (this.particleManager) {
        this.particleManager.unregister(doodad);
      }

      M2Blueprint.unload(doodad);
    }

    WMORootLoader.unload(this.root);

    this.groups = new Map();
    this.doodads = new Map();
    this.animatedDoodads = new Map();
    this.doodadRefs = new Map();

    this.views.root = null;
    this.views.groups = new Map();
    this.views.portals = new Map();

    this.root = null;
    this.doodadSetIndex = null;
    this.entryID = null;
    this.filename = null;
  }

  placeGroupView(groupView) {
    // Add to scene and update matrices
    // world.scene.add(groupView)
    this.views.root.add(groupView);
    // ColliderManager.collidableMeshList.set(groupView.uuid, groupView);
    groupView.updateMatrix();
    groupView.updateMatrixWorld();
    // console.log(groupView)
    // const box = new THREE.Box3(groupView.group.boundingBox.min, groupView.group.boundingBox.max);
    
    // var helper = new THREE.Box3Helper(box, 0xffff00);
    // this.views.root.add(helper)
  }

  placePortalView(portalView) {
    // Add to scene and update matrices
    this.views.root.add(portalView);
    portalView.updateMatrix();
    portalView.updateMatrixWorld();
  }

  placeDoodad(doodadEntry, doodad) {
    const { position, rotation, scale } = doodadEntry;

    doodad.position.set(position.x, position.y, position.z);

    // Adjust doodad rotation to match Wowser's axes.
    const quat = doodad.quaternion;
    doodad.boundingMesh.quaternion.set(rotation.x, rotation.y, -rotation.z, -rotation.w);
    quat.set(rotation.x, rotation.y, -rotation.z, -rotation.w);

    doodad.scale.set(-scale, -scale, scale);
    // doodad.scale.set(-1, -1, 1);

    // Add to scene and update matrices
    this.views.root.add(doodad);
    doodad.updateMatrix();
    doodad.updateMatrixWorld();
    // this.views.root.add(doodad.boundingMesh);
    // doodad.boundingMesh.updateMatrix();
    // doodad.boundingMesh.updateMatrixWorld();
  }

  /**
   * Fold this doodad's per-object lighting once at create. Which lane it takes depends on the
   * owning group's lighting class (the reference's MOGI & 0x48 -- deliberately not `interior`,
   * which only answers portal culling): `lightingInterior` groups fold a probe, everything else
   * (a porch, a courtyard, any EXTERIOR_LIT group) takes the exterior lane, which still owes the
   * doodad its building's own MOLT point lights -- only WMO *surfaces* take none of those.
   */
  foldDoodadLighting(doodadEntry, doodad) {
    const group = this.doodadLightingGroups.get(doodadEntry.id);

    if (group && group.lightingInterior) {
      this.foldInteriorDoodadLighting(doodadEntry, doodad, group);
    } else {
      this.foldExteriorDoodadLighting(doodad);
    }
  }

  /**
   * The interior lane: fold the group's ambient/diffuse/MOLR lights into one SH probe.
   *
   * `ambient = cap96(MODD.colour)` and `diffuse = floor112(MODD.colour)`, the latter committed on
   * the FIXED engine axis rather than the day/night sun -- which is why an interior prop's light is
   * day/night independent and can be folded once here rather than every frame.
   *
   * MOLR point lights (the group's referenced omni lights, its own flame included) are gated by
   * distance inside `foldInteriorProbe` itself; a group with no MOLR means no point light at all.
   */
  foldInteriorDoodadLighting(doodadEntry, doodad, group) {
    // MODD.color is a uint32. CImVector is BGRA in memory, so as a little-endian uint32 red lands
    // at >> 16 -- the same unpacking WMORootDefinition.createLights uses for MOLT colour.
    const color = doodadEntry.color;
    const bytes = [
      (color >> 16) & 0xff,
      (color >> 8) & 0xff,
      color & 0xff
    ];

    const ambient = cap96(bytes);
    const diffuse = floor112(bytes);

    const worldPosition = doodad.getWorldPosition(new THREE.Vector3());
    const refPoint = [worldPosition.x, worldPosition.y, worldPosition.z];

    const lights = this.molrLightsFor(group);

    const probe = foldInteriorProbe(ambient, diffuse, refPoint, lights);

    doodad.perObjectLighting = {
      interior: true,
      sunIntensity: 1.0,
      probe,
      // Deliberately empty, not an unfinished stub: this doodad's MOLR lobes are already folded into
      // `probe` above (see foldInteriorProbe). Populating both would double-count the same lights.
      pointLights: []
    };

    this.attachDoodadLighting(doodad);
  }

  /**
   * The exterior lane: no probe, no folded ambient/diffuse -- those keep coming from MapLight's own
   * day/night blend the way they always have. What WAS missing without this fold is the doodad's
   * own ≤3-nearest MOLT point lights (benilla wow_model.wgsl::point_light_sum): a doodad standing on
   * a porch or in a courtyard group still takes its building's point lights, exactly like the
   * reference -- it is WMO *surfaces*, not M2 doodads, that take none.
   *
   * Anchored at the doodad's own world position, never the camera -- selecting against the camera
   * lights doodads from sideways lamps the real client never commits. Candidates are drawn from
   * THIS WMO instance's own MOLT lights (`worldSpaceLightsForWmo(this)`, the same conversion
   * `molrLightsFor` uses for the interior fold above), so a doodad here never picks up a
   * neighbouring building's lights, and an ADT doodad placed outside any WMO never reaches this
   * method at all (it is only called from `loadDoodad`, which only runs for this WMO's own doodads).
   */
  foldExteriorDoodadLighting(doodad) {
    const worldPosition = doodad.getWorldPosition(new THREE.Vector3());
    const origin = [worldPosition.x, worldPosition.y, worldPosition.z];

    const worldLights = worldSpaceLightsForWmo(this);
    const candidates = [];

    if (worldLights) {
      for (const light of worldLights) {
        // root.lights (and therefore this array) is positionally aligned with MOLT and has holes
        // for lights createLights skipped -- see WMORootDefinition.createLights.
        if (!light) {
          continue;
        }

        candidates.push({
          position: [light.position.x, light.position.y, light.position.z],
          color: [
            light.color.r * light.intensity,
            light.color.g * light.intensity,
            light.color.b * light.intensity
          ],
          attenStart: light.attenStart,
          attenEnd: light.attenEnd
        });
      }
    }

    const pointLights = selectPointLights(origin, candidates, 3);

    doodad.perObjectLighting = {
      interior: false,
      sunIntensity: 1.0,
      probe: null,
      pointLights
    };

    this.attachDoodadLighting(doodad);
  }

  // The owning group's MOLR-referenced lights, converted to world space (cached on this WMO
  // instance) and shaped for foldInteriorProbe. A group with no MOLR chunk, or whose refs all miss
  // (non-omni/disabled MOLT slots), yields no point lights at all -- correct per the law, not a bug.
  molrLightsFor(group) {
    const refs = group.lightRefs;
    if (!refs || refs.length === 0) {
      return [];
    }

    const worldLights = worldSpaceLightsForWmo(this);
    if (!worldLights) {
      return [];
    }

    const lights = [];
    for (const ref of refs) {
      const light = worldLights[ref];
      if (!light) {
        continue;
      }

      lights.push({
        position: [light.position.x, light.position.y, light.position.z],
        color: [
          light.color.r * light.intensity,
          light.color.g * light.intensity,
          light.color.b * light.intensity
        ],
        attenStart: light.attenStart,
        attenEnd: light.attenEnd
      });
    }

    return lights;
  }

  // Install the per-draw lighting push on each of the doodad's batch meshes -- one mesh per batch,
  // per Submesh.applyBatches, all sharing the model's material.
  attachDoodadLighting(doodad) {
    doodad.submeshes.forEach((submesh) => {
      submesh.children.forEach((batchMesh) => {
        attachPerObjectLighting(batchMesh, () => doodad.perObjectLighting);
      });
    });
  }

  addDoodadRef(doodadEntry, group) {
    if (!this.doodadRefs.doodad.has(doodadEntry.id)) {
      this.doodadRefs.doodad.set(doodadEntry.id, new Set());
    }

    if (!this.doodadRefs.group.has(group.index)) {
      this.doodadRefs.group.set(group.index, new Set());
    }

    const byDoodad = this.doodadRefs.doodad.get(doodadEntry.id);
    const byGroup = this.doodadRefs.group.get(group.index);

    byDoodad.add(group.index);
    byGroup.add(doodadEntry.id);

    const refCount = byDoodad.size;

    return refCount;
  }

  removeDoodadRef(doodadEntry, group) {
    const byDoodad = this.doodadRefs.doodad.get(doodadEntry.id);
    const byGroup = this.doodadRefs.group.get(group.index);

    if (!byDoodad) {
      return 0;
    }

    byDoodad.delete(group.index);
    byGroup.delete(doodadEntry.id);

    const refCount = this.doodadRefs.doodad.size;

    if (refCount === 0) {
      this.doodadRefs.doodad.delete(doodadEntry.id);
      this.doodadRefs.group.delete(group.index);
    }

    return refCount;
  }

  groupsForDoodad(doodad) {
    const groupIDs = this.doodadRefs.doodad.get(doodad.entryID) || [];
    const groups = [];

    for (const groupID of groupIDs) {
      const group = this.groups.get(groupID);

      if (group) {
        groups.push(group);
      }
    }

    return groups;
  }

  doodadsForGroup(group) {
    const doodadIDs = this.doodadRefs.group.get(group.index) || [];
    const doodads = [];

    for (const doodadID of doodadIDs) {
      const doodad = this.doodads.get(doodadID);

      if (doodad) {
        doodads.push(doodad);
      }
    }

    return doodads;
  }

  animate(delta, camera, cameraMoved) {
    if (!this.views.root) {
      return;
    }

    const doodads = this.animatedDoodads.values();

    for (const doodad of doodads) {
      if (!doodad.visible) {
        continue;
      }

      if (doodad.receivesAnimationUpdates && doodad.animations.length > 0) {
        doodad.animations.update(delta);
      }

      if (cameraMoved && doodad.billboards.length > 0) {
        doodad.applyBillboards(camera);
      }

      if (doodad.skeletonHelper) {
        doodad.skeletonHelper.update();
      }
    }
  }

}

export default WMO;
