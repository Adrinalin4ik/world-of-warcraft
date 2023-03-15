import { vec3 } from 'gl-matrix';
import * as THREE from 'three';
import THREEUtil from './three-util';

class BSPTree {

  constructor(nodes, planeIndices, faceIndices, vertices) {
    this.nodes = nodes;
    this.indices = {
      plane: planeIndices,
      face: faceIndices
    };
    this.vertices = vertices;
  }

  query(subject, startingNodeIndex) {
    const leafIndices = [];

    this.queryBox(subject, startingNodeIndex, leafIndices);
    return leafIndices;
  }

  queryBox(box, nodeIndex, leafIndices) {
    if (nodeIndex === -1 || !this.nodes) {
      console.error("Node is empty", nodeIndex)
      return;
    }

    const node = this.nodes[nodeIndex];
    
    /*
      interface Node {
        faceStart: 0
        flags: 0
        nFaces: 0
        negChild: 361
        planeDist: -161
        posChild: 1
      }
    */

    if (node.flags === 4) {
      leafIndices.push(nodeIndex);
      return;
    }

    const leftPlane = new THREE.Plane();
    const rightPlane = new THREE.Plane();
    if (node.flags === 0) {
      leftPlane.setComponents(-1.0, 0.0, 0.0, node.planeDist);
      rightPlane.setComponents(1.0, 0.0, 0.0, -node.planeDist);
    } else if (node.flags === 1) {
      leftPlane.setComponents(0.0, -1.0, 0.0, node.planeDist);
      rightPlane.setComponents(0.0, 1.0, 0.0, -node.planeDist);
    } else if (node.flags === 2) {
      leftPlane.setComponents(0.0, 0.0, -1.0, node.planeDist);
      rightPlane.setComponents(0.0, 0.0, 1.0, -node.planeDist);
    }

    const includeLeft = THREEUtil.planeContainsBox(leftPlane, box);
    const includeRight = THREEUtil.planeContainsBox(rightPlane, box);

    if (includeLeft) {
      this.queryBox(box, node.negChild, leafIndices);
    }
    
    if (includeRight) {
      this.queryBox(box, node.posChild, leafIndices);
    }
  }
  
  calculateZRange(point, leafIndices) {
    let rangeMin = null;
    let rangeMax = null;
    for (let lindex = 0, lcount = leafIndices.length; lindex < lcount; ++lindex) {
      const node = this.nodes[leafIndices[lindex]];

      const pbegin = node.faceStart;
      const pend = node.faceStart + node.nFaces;
      
      for (let pindex = pbegin; pindex < pend; ++pindex) {
        const vindex1 = this.indices.face[3 * this.indices.plane[pindex] + 0];
        const vindex2 = this.indices.face[3 * this.indices.plane[pindex] + 1];
        const vindex3 = this.indices.face[3 * this.indices.plane[pindex] + 2];

        const vertex1 = new THREE.Vector3(
          this.vertices[3 * vindex1 + 0],
          this.vertices[3 * vindex1 + 1],
          this.vertices[3 * vindex1 + 2]
        );

        const vertex2 = new THREE.Vector3(
          this.vertices[3 * vindex2 + 0],
          this.vertices[3 * vindex2 + 1],
          this.vertices[3 * vindex2 + 2]
        );

        const vertex3 = new THREE.Vector3(
          this.vertices[3 * vindex3 + 0],
          this.vertices[3 * vindex3 + 1],
          this.vertices[3 * vindex3 + 2]
        );
        const minX = Math.min(vertex1.x, vertex2.x, vertex3.x);
        const maxX = Math.max(vertex1.x, vertex2.x, vertex3.x);

        const minY = Math.min(vertex1.y, vertex2.y, vertex3.y);
        const maxY = Math.max(vertex1.y, vertex2.y, vertex3.y);
        
        const pointInBoundsXY =
          point.x >= minX && point.x <= maxX &&
          point.y >= minY && point.y <= maxY;

        if (!pointInBoundsXY) {
          continue;
        }
        // console.log("here 1", [point.x, point.y], [minX, minY, maxX, maxY])

        const triangle = new THREE.Triangle(vertex1, vertex2, vertex3);

        const z = this.calculateZFromTriangleAndXY(triangle, point.x, point.y);

        const bary = new THREE.Vector3();

        triangle.getBarycoord(new THREE.Vector3(point.x, point.y, z), bary);

        const baryInBounds = bary.x >= 0 && bary.y >= 0 && bary.z >= 0;

        if (!baryInBounds) {
          continue;
        }

        // var normal_avg = bary.x*vertex1[2]+bary.y*vertex1[2]+bary.z*vertex1[2];

        // if (normal_avg > 0) {
        //     //Bottom
        //     var distanceToCamera = point.z - z;
        //     if ((distanceToCamera > 0) && (distanceToCamera < 99999))
        //       rangeMin = z;
        // } else {
        //     //Top
        //     rangeMax = Math.max(z, rangeMin);
        // }

        if (z < point.z && (rangeMin === null || z < rangeMin)) {
          rangeMin = z;
        }

        if (z > point.z && (rangeMax === null || z > rangeMax)) {
          rangeMax = z;
        }
      }
    }

    if (rangeMax - rangeMin < 0.001) {
      rangeMax = null;
    }

    return [rangeMin, rangeMax];
  }

  calculateZFromTriangleAndXY(triangle, x, y) {
    const p1 = triangle.a;
    const p2 = triangle.b;
    const p3 = triangle.c;

    const det = (p2.y - p3.y) * (p1.x - p3.x) + (p3.x - p2.x) * (p1.y - p3.y);

    if (det > -0.001 && det < 0.001) {
      return Math.min(p1.x, p2.x, p3.x);
    }

    const l1 = ((p2.y - p3.y) * (x - p3.x) + (p3.x - p2.x) * (y - p3.y)) / det;
    const l2 = ((p3.y - p1.y) * (x - p3.x) + (p1.x - p3.x) * (y - p3.y)) / det;
    const l3 = 1.0 - l1 - l2;

    return l1 * p1.z + l2 * p2.z + l3 * p3.z;
  }

  queryBoundedPoint(point, bounding) {
    const epsilon = 0.4;
    
    // Define a small bounding box for point
    const box = new THREE.Box3();
    box.min.set(point.x - epsilon, point.y - epsilon, bounding.min.z - epsilon);
    box.max.set(point.x + epsilon, point.y + epsilon, bounding.max.z + epsilon);

    // Query BSP tree
    const leafIndices = this.query(box, 0);

    // If no leaves were found, there is no valid result
    if (leafIndices.length === 0) {
      // console.log("here 1", bounding, leafIndices, point)
      return null;
    }

    // Determine upper and lower Z bounds of leaves
    const zRange = this.calculateZRange(point, leafIndices);
    // const zRange = this.getTopAndBottomTriangleFromBsp(point, leafIndices)
    // console.log(zRange)
    const minZ = zRange[0];
    const maxZ = zRange[1];

    return {
      z: {
        min: minZ,
        max: maxZ
      }
    };
  }

  getTopAndBottomTriangleFromBsp(point, leafIndices) {
    var cameraLocal = [point.x, point.y, point.z]
    console.log("cameraLocal", cameraLocal, this)
    var result = 0;
    var nodes = this.nodes;
    var topZ = -999999;
    var bottomZ = 999999;
    var minPositiveDistanceToCamera = 99999;
    for (var i = 0; i < leafIndices.length; i++) {
      var node = nodes[leafIndices[i]];

      for (var j = node.firstFace; j < node.firstFace+node.numFaces; j++) {
        var vertexInd1 = this.indices.face[3*this.indices.plane[j] + 0];
        var vertexInd2 = this.indices.face[3*this.indices.plane[j] + 1];
        var vertexInd3 = this.indices.face[3*this.indices.plane[j] + 2];

        var vert1 = vec3.fromValues(
          this.vertices[3*vertexInd1 + 0],
          this.vertices[3*vertexInd1 + 1],
          this.vertices[3*vertexInd1 + 2]);

        var vert2 = vec3.fromValues(
          this.vertices[3*vertexInd2 + 0],
          this.vertices[3*vertexInd2 + 1],
          this.vertices[3*vertexInd2 + 2]);

        var vert3 = vec3.fromValues(
          this.vertices[3*vertexInd3 + 0],
          this.vertices[3*vertexInd3 + 1],
          this.vertices[3*vertexInd3 + 2]);

        //1. Get if camera position inside vertex

        var minX = Math.min(vert1[0], vert2[0], vert3[0]);
        var minY = Math.min(vert1[1], vert2[1], vert3[1]);
        var minZ = Math.min(vert1[2], vert2[2], vert3[2]);

        var maxX = Math.max(vert1[0], vert2[0], vert3[0]);
        var maxY = Math.max(vert1[1], vert2[1], vert3[1]);
        var maxZ = Math.max(vert1[2], vert2[2], vert3[2]);

        var testPassed = (
          (cameraLocal[0] > minX && cameraLocal[0] < maxX) &&
          (cameraLocal[1] > minY && cameraLocal[1] < maxY)
        );
        if (!testPassed) continue;

        var z = this.calcZ(vert1,vert2,vert3,cameraLocal[0],cameraLocal[1]);

        //2. Get if vertex top or bottom
        var normal1 = vec3.fromValues(
          this.normals[3*vertexInd1 + 0],
          this.normals[3*vertexInd1 + 1],
          this.normals[3*vertexInd1 + 2]
        );
        var normal2 = vec3.fromValues(
          this.normals[3*vertexInd2 + 0],
          this.normals[3*vertexInd2 + 1],
          this.normals[3*vertexInd2 + 2]
        );
        var normal3 = vec3.fromValues(
          this.normals[3*vertexInd3 + 0],
          this.normals[3*vertexInd3 + 1],
          this.normals[3*vertexInd3 + 2]
        );

        var bary = this.getBarycentric(
          vec3.fromValues(cameraLocal[0], cameraLocal[1], z),
          vert1,
          vert2,
          vert3
        );

        /*if (testPassed && cameraLocal[2] < vert1[2] || cameraLocal[2] < vert2[2] || cameraLocal[2] < vert3[2]){
          } */
        if ((bary[0] < 0) || (bary[1] < 0) || (bary[2] < 0)) continue;

        var normal_avg = bary[0]*normal1[2]+bary[1]*normal2[2]+bary[2]*normal3[2];
        if (normal_avg > 0) {
          //Bottom
          var distanceToCamera = cameraLocal[2] - z;
          if ((distanceToCamera > 0) && (distanceToCamera < minPositiveDistanceToCamera))
              bottomZ = z;
        } else {
          //Top
          topZ = Math.max(z, topZ);
        }
      }
    }
    return [bottomZ, topZ];
  }

  calcZ(p1, p2, p3, x, y) {
    var det = (p2[1] - p3[1]) * (p1[0] - p3[0]) + (p3[0] - p2[0]) * (p1[1] - p3[1]);

    if (det > -0.001 && det < 0.001) {
        return Math.min(p1[0], p2[0], p3[0]);
    }

    var l1 = ((p2[1] - p3[1]) * (x - p3[0]) + (p3[0] - p2[0]) * (y - p3[1])) / det;
    var l2 = ((p3[1] - p1[1]) * (x - p3[0]) + (p1[0] - p3[0]) * (y - p3[1])) / det;
    var l3 = 1.0 - l1 - l2;

    return l1 * p1[2] + l2 * p2[2] + l3 * p3[2];
  }

  getBarycentric( p, a, b, c) {
    var v0 = vec3.create();
    vec3.subtract(v0, b, a);
    var v1 = vec3.create();
    vec3.subtract(v1, c, a);
    var v2 = vec3.create();
    vec3.subtract(v2, p, a);

    var d00 = vec3.dot(v0, v0);
    var d01 = vec3.dot(v0, v1);
    var d11 = vec3.dot(v1, v1);
    var d20 = vec3.dot(v2, v0);
    var d21 = vec3.dot(v2, v1);
    var denom = d00 * d11 - d01 * d01;
    var v = (d11 * d20 - d01 * d21) / denom;
    var w = (d00 * d21 - d01 * d20) / denom;
    var u = 1.0 - v - w;
    return vec3.fromValues(u, v, w)
  }
}

export default BSPTree;
