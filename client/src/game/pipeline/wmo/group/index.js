import * as THREE from 'three';

import BSPTree from '../../../utils/bsp-tree';
import WMOLiquid from '../../liquid/wmo-liquid';
import WMORootFlags from '../root/flags';
import WMOGroupView from './view';

class WMOGroup {

  constructor(root, def) {
    this.root = root;
    this.path = def.path;
    this.index = def.index;
    this.id = def.groupID;
    this.header = def.header;
    this.def = def;
    this.interior = def.interior;
    this.lightingInterior = def.lightingInterior;
    // See WMOGroupDefinition.fogOffsets -- indices into root.fogs, resolved by the
    // camera-in-interior fog consumer, not here.
    this.fogOffsets = def.fogOffsets;

    this.doodadRefs = def.doodadRefs;
    this.lightRefs = def.lightRefs;

    this.createPortals(root, def);

    this.createMaterial(def.materialRefs);
    this.attenuateVertexColors(root, def.attributes, def.batches);
    this.createGeometry(def.attributes, def.batches);
    this.createBoundingBox(def.boundingBox);
    this.createBSPTree(def.bspNodes, def.bspPlaneIndices, def.attributes);
    
    // Create liquid meshes if liquid data is present
    this.liquid = this.createLiquid(def.liquidData);
  }

  /**
   * A FRESH view, per placement. The group owns no view of its own.
   *
   * `WMOGroupLoader` caches groups by path, so a group object is shared by every placement of the
   * building in the world. It used to hold `this.view` and hand the same object out to all of them --
   * and an Object3D has ONE parent, so re-parenting moved it: only the last placement existed, and
   * every earlier copy of that building was simply absent. Measured in game: two placements of
   * NIGHTELFSMALLHOUSE_WSG reported byte-identical world bounding boxes, which two buildings in
   * different places cannot have.
   *
   * Geometry and materials stay shared -- they are the expensive part and they are placement
   * independent. Only the scene node is per placement.
   */
  createView() {
    return new WMOGroupView(this, this.geometry, this.materials);
  }

  createPortals(root, def) {
    const portals = this.portals = [];
    const portalRefs = this.portalRefs = [];

    if (def.header.portalCount > 0) {
      const pbegin = def.header.portalOffset;
      const pend = pbegin + def.header.portalCount;

      for (let pindex = pbegin; pindex < pend; ++pindex) {
        const ref = root.portalRefs[pindex];
        const portal = root.portals[ref.portalIndex];

        portalRefs.push(ref);
        portals.push(portal);
      }
    }
  }

  // Materials are created on the root blueprint to take advantage of sharing materials across
  // multiple groups (when possible).
  createMaterial(materialRefs) {
    this.materials = this.root.loadMaterials(materialRefs, this);
  }

  createGeometry(attributes, batches) {
    const geometry = this.geometry = new THREE.BufferGeometry();

    const { indices, positions, normals, uvs, colors } = attributes;

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    const colorAttribute = new THREE.BufferAttribute(colors, 4);
    geometry.setAttribute('acolor', colorAttribute);
    // The SAME buffer under three's own attribute name, so a `vertexColors: true` material can read
    // MOCV without any shader of ours in the path -- see world/wmo-debug.ts. Costs nothing: one extra
    // attribute record over shared memory, and the WMO shader keeps reading `acolor` explicitly, so
    // nothing about the real draw changes.
    geometry.setAttribute('color', colorAttribute);

    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    // geometry.computeBoundingBox();
    this.assignBatches(geometry, batches);
    
    geometry.computeBoundsTree();

    return geometry;
  }

  assignBatches(geometry, batches) {
    const batchCount = batches.length;

    for (let index = 0; index < batchCount; ++index) {
      const batch = batches[index];
      geometry.addGroup(batch.firstIndex, batch.indexCount, index);
    }
  }

  dispose() {
    if (this.geometry) {
      this.geometry.dispose();
    }

    if (this.material) {
      for (const material of this.materials) {
        this.root.unloadMaterial(material);
      }
    }
  }

  createBoundingBox(def) {
    this.boundingBox = new THREE.Box3();
    const min = new THREE.Vector3(def.min.x, def.min.y, def.min.z);
    const max = new THREE.Vector3(def.max.x, def.max.y, def.max.z);

    this.boundingBox.set(min, max);
  }

  createBSPTree(nodes, planeIndices, attributes) {
    const { indices, positions } = attributes;

    this.bspTree = new BSPTree(nodes, planeIndices, indices, positions);

    // MOPY flags, one byte per triangle, indexed by the SAME triangle index MOBR's entries carry.
    // That shared indexing is what lets the walk face set (minus DETAIL) and the camera face set
    // (minus NOCAMCOLLIDE) come out of one shared BSP instead of two bakes.
    this.triangleFlags = attributes.triangleFlags;
  }

  createLiquid(liquidData) {
    if (!liquidData) {
      return null;
    }

    console.log('Creating WMO liquid mesh for WMO group:', this.path, this.index);
    console.log('Liquid data:', liquidData);

    // Create WMO-specific liquid mesh
    return new WMOLiquid(liquidData);
  }

  /**
   * Identify the closest portal to the given point (in local space). Projects point on portal
   * plane and clamps to portal vertex bounds prior to calculating distance.
   *
   * See: CMapObj::ClosestPortal
   *
   * @param point - Point (in local space) for which distance is calculated
   * @param max - Optional upper limit for distance
   *
   * @returns - Closest portal and corresponding ref
   *
   */
  closestPortal(point, max = null) {
    if (this.portals.length === 0) {
      return null;
    }

    let shortestDistance = max;



    const portals = [];
    for (let index = 0, count = this.portals.length; index < count; ++index) {
      const portal = this.portals[index];
      const portalRef = this.portalRefs[index];
      const projectedPoint = new THREE.Vector3();
      portal.plane.projectPoint(point, projectedPoint);

      
      const distance = projectedPoint.clamp(portal.boundingBox.min, portal.boundingBox.max)
        .distanceTo(point);

      // if (shortestDistance === null || distance < shortestDistance) {
      //   shortestDistance = distance;

        const sign = portal.plane.distanceToPoint(point) < 0.0 ? -1 : 1;

        const result = {
          portal,
          portalRef,
          distance: distance,
          sign
        };
        
        // if (portalRef.side * distance >= 0.0 && result.distance > 0) {
        // console.log(portal.index, distance, sign, portalRef.side);
        if ((portalRef.side === 1 && distance * sign > 0) || (portalRef.side === -1 && distance * sign <= 0)) {
          portals.push(result);
        }
      // }
    }

    portals.sort((a,b) => a.distance - b.distance);

    return portals[0] || null;

    // return (result.portal === null) ? null : result;
  }

  attenuateVertexColors(root, attributes, batches) {
    if (root.header.flags & WMORootFlags.SKIP_MOCV_ATTENUATION) {
      return;
    }

    const { batchCounts, batchOffsets } = this.header;

    if (batchCounts.a === 0) {
      return;
    }

    const firstBatchB = batches[batchOffsets.b];

    const vertices = attributes.positions;
    const colors = attributes.colors;

    const vmax = firstBatchB ? firstBatchB.firstVertex : vertices.length;

    for (let vindex = 0; vindex < vmax; ++vindex) {
      const color = colors.subarray(vindex * 4, vindex * 4 + 4);
      const vertex = vertices.subarray(vindex * 3, vindex * 3 + 3);

      // In the case of no portals, there is no world light
      if (this.portals.length === 0) {
        color[3] = 0.0;
        continue;
      }

      const origin = new THREE.Vector3(vertex[0], vertex[1], vertex[2]);
      const closestPortal = this.closestPortal(origin, 6.0);

      if (!closestPortal) {
        color[3] = 0.0;
        continue;
      }

      let attenuation = 0.0;
      let newAlpha = 0.0;

      const distance = closestPortal.distance;

      const destinationFlags = root.groupInfo[closestPortal.portalRef.groupIndex].flags;

      if (destinationFlags & (0x08 | 0x40)) {
        if (distance < 0.0) {
          attenuation = 1.0;
        } else {
          attenuation = 1.0 - (distance / 6.0);
        }
      }

      if (attenuation <= 0.001) {
        attenuation = 0.0;
        newAlpha = 0.0;
      } else if (attenuation <= 1.0) {
        newAlpha = attenuation * 255.0;
      } else {
        attenuation = 1.0;
        newAlpha = 255.0;
      }

      // Red
      const tempR = color[0] * 255.0;
      const newR = ((127.0 - tempR) * attenuation) + tempR;
      color[0] = newR / 255.0;

      // Green
      const tempG = color[1] * 255.0;
      const newG = ((127.0 - tempG) * attenuation) + tempG;
      color[1] = newG / 255.0;

      // Blue
      const tempB = color[2] * 255.0;
      const newB = ((127.0 - tempB) * attenuation) + tempB;
      color[2] = newB / 255.0;

      // Alpha
      color[3] = newAlpha / 255.0;
    }
  }

}

export default WMOGroup;
