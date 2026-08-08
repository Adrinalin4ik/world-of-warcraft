import { ReadonlyVec4, mat3, mat4, vec3, vec4 } from 'gl-matrix';
import * as THREE from 'three';


function checkFrustum(planes: number[][], three_box: THREE.Box3, num_planes: number, points) {
  // check box outside/inside of frustum
  // debugger;
  points = null;
  const box = [[three_box.min.x, three_box.min.y, three_box.min.z],[three_box.max.x, three_box.max.y, three_box.max.z]];
  for (var i = 0; i < num_planes; i++) {
      var out = 0;
      out += (((planes[i][0]*box[0][0]+ planes[i][1]*box[0][1]+ planes[i][2]*box[0][2]+planes[i][3]) < 0.0 ) ? 1 : 0);
      out += (((planes[i][0]*box[1][0]+ planes[i][1]*box[0][1]+ planes[i][2]*box[0][2]+planes[i][3]) < 0.0 ) ? 1 : 0);
      out += (((planes[i][0]*box[0][0]+ planes[i][1]*box[1][1]+ planes[i][2]*box[0][2]+planes[i][3]) < 0.0 ) ? 1 : 0);
      out += (((planes[i][0]*box[1][0]+ planes[i][1]*box[1][1]+ planes[i][2]*box[0][2]+planes[i][3]) < 0.0 ) ? 1 : 0);
      out += (((planes[i][0]*box[0][0]+ planes[i][1]*box[0][1]+ planes[i][2]*box[1][2]+planes[i][3]) < 0.0 ) ? 1 : 0);
      out += (((planes[i][0]*box[1][0]+ planes[i][1]*box[0][1]+ planes[i][2]*box[1][2]+planes[i][3]) < 0.0 ) ? 1 : 0);
      out += (((planes[i][0]*box[0][0]+ planes[i][1]*box[1][1]+ planes[i][2]*box[1][2]+planes[i][3]) < 0.0 ) ? 1 : 0);
      out += (((planes[i][0]*box[1][0]+ planes[i][1]*box[1][1]+ planes[i][2]*box[1][2]+planes[i][3]) < 0.0 ) ? 1 : 0);

      if (out == 8) return false;
  }

  // check frustum outside/inside box
  if (points) {
      out = 0; for (var i = 0; i < 8; i++) out += ((points[i][0] > box[1][0]) ? 1 : 0); if (out == 8) return false;
      out = 0; for (var i = 0; i < 8; i++) out += ((points[i][0] < box[0][0]) ? 1 : 0); if (out == 8) return false;
      out = 0; for (var i = 0; i < 8; i++) out += ((points[i][1] > box[1][1]) ? 1 : 0); if (out == 8) return false;
      out = 0; for (var i = 0; i < 8; i++) out += ((points[i][1] < box[0][1]) ? 1 : 0); if (out == 8) return false;
      out = 0; for (var i = 0; i < 8; i++) out += ((points[i][2] > box[1][2]) ? 1 : 0); if (out == 8) return false;
      out = 0; for (var i = 0; i < 8; i++) out += ((points[i][2] < box[0][2]) ? 1 : 0); if (out == 8) return false;
  }

  return true;
}

function distanceFromAABBToPoint(aabb, p) {
  function distance_aux(p, lower, upper) {
      if (p < lower) return lower - p;
      if (p > upper)  return p - upper;
      return 0
  }

  var dx = distance_aux(p[0], aabb[0][0], aabb[1][0]);
  var dy = distance_aux(p[1], aabb[0][1], aabb[1][1]);
  var dz = distance_aux(p[2], aabb[0][2], aabb[1][2]);

  if (isPointInsideAABB(aabb, p))
      return Math.min(dx, dy, dz);    // or 0 in case of distance from the area
  else
      return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function isPointInsideAABB(aabb, p) {
  var result = p[0] > aabb[0][0] && p[0] < aabb[1][0] &&
      p[1] > aabb[0][1] && p[1] < aabb[1][1] &&
      p[2] > aabb[0][2] && p[2] < aabb[1][2];
  return result;
}

function getBarycentric(p, a, b, c) {
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
  if ((denom < 0.0001) && (denom > -0.0001)) {
      return vec3.fromValues(-1, -1, -1)
  };

  var v = (d11 * d20 - d01 * d21) / denom;
  var w = (d00 * d21 - d01 * d20) / denom;
  var u = 1.0 - v - w;
  return vec3.fromValues(u, v, w)
}

function createPlaneFromEyeAndVertexes(eye, vertex1, vertex2) {
  var edgeDir1 = vec4.create();
  (vec3 as any).subtract(edgeDir1, vertex1, eye);

  var edgeDir2 = vec4.create();
  (vec3 as any).subtract(edgeDir2, vertex2, eye);

  //planeNorm=cross(viewDir, edgeDir)
  var planeNorm = vec4.create();
  (vec3 as any).cross(planeNorm, edgeDir2, edgeDir1);
  (vec3 as any).normalize(planeNorm, planeNorm);

  //Plane fpl(planeNorm, dot(planeNorm, vertexA))
  var distToPlane = (vec3 as any).dot(planeNorm, eye);
  planeNorm[3] = -distToPlane;

  return planeNorm;
}

export interface BSPTreeNode {
  faceStart: number;
  flags: number;
  nFaces: number;
  negChild: number;
  planeDist: number;
  posChild: number
}

class BSPTree {
  nodes: BSPTreeNode[] = [];
  indices = {
    plane: [],
    face: []
  };
  vertices = [];
  normals = [];
  constructor(nodes: BSPTreeNode[], planeIndices: number[], faceIndices: number[], vertices: number[]) {
    this.nodes = nodes;
    this.indices = {
      plane: planeIndices,
      face: faceIndices
    };
    this.vertices = vertices;
  }

  query(subject, startingNodeIndex) {
    const leafNodeIds = [];
    this.queryBox(subject, startingNodeIndex, leafNodeIds);
    // console.log(leafNodeIds);
    return leafNodeIds;
  }
  
  queryBox(bbox, nodeIndex, bspLeafIdList) {
    if (nodeIndex === -1) {
      // console.debug("Node is empty", nodeIndex)
      return;
    }
    
    const node = this.nodes[nodeIndex]

    if ((node.flags & 0x4)) {
      bspLeafIdList.push(nodeIndex);
    } else if ((node.flags == 0)) {
      var leftSide = checkFrustum([[-1, 0, 0, this.nodes[nodeIndex].planeDist]], bbox, 1, null);
      var rightSide = checkFrustum([[1, 0, 0, -this.nodes[nodeIndex].planeDist]], bbox, 1, null);

      if (leftSide) {
          this.queryBox(bbox, this.nodes[nodeIndex].posChild, bspLeafIdList)
      }
      if (rightSide) {
          this.queryBox(bbox, this.nodes[nodeIndex].negChild, bspLeafIdList)
      }
    } else if ((node.flags == 1)) {
      var leftSide = checkFrustum([[0, -1, 0, this.nodes[nodeIndex].planeDist]], bbox, 1, null);
      var rightSide = checkFrustum([[0, 1, 0, -this.nodes[nodeIndex].planeDist]], bbox, 1, null);

      if (leftSide) {
        this.queryBox(bbox, node.posChild, bspLeafIdList)
      }
      if (rightSide) {
        this.queryBox(bbox, node.negChild, bspLeafIdList)
      }
    } else if ((node.flags == 2)) {
      var leftSide = checkFrustum([[0, 0, -1, node.planeDist]], bbox, 1, null);
      var rightSide = checkFrustum([[0, 0, 1, -node.planeDist]], bbox, 1, null);

      if (leftSide) {
        this.queryBox(bbox, node.posChild, bspLeafIdList)
      }
      if (rightSide) {
        this.queryBox(bbox, node.negChild, bspLeafIdList)
      }
    }
  }

  checkIfInsidePortals(point, groupFile, parentWmoFile) {
    var moprIndex = groupFile.mogp.moprIndex;
    var numItems = groupFile.mogp.numItems;

    var insidePortals = true;
    for (var j = moprIndex; j < moprIndex+numItems; j++) {
        var relation = parentWmoFile.portalRelations[j];
        var portalInfo = parentWmoFile.portalInfos[relation.portal_index];

        var nextGroup = relation.group_index;
        var plane = portalInfo.plane;

        var minX = 99999;
        var minY = 99999;
        var minZ = 99999;
        var maxX = -99999;
        var maxY = -99999;
        var maxZ = -99999;


        var base_index = portalInfo.base_index;
        var portalVerticles = parentWmoFile.portalVerticles;
        for (var k = 0; k < portalInfo.index_count; k++) {
            minX = Math.min(minX, portalVerticles[3 * (base_index + k)    ]);
            minY = Math.min(minY, portalVerticles[3 * (base_index + k) + 1]);
            minZ = Math.min(minZ, portalVerticles[3 * (base_index + k) + 2]);

            maxX = Math.max(maxX, portalVerticles[3 * (base_index + k)    ]);
            maxY = Math.max(maxX, portalVerticles[3 * (base_index + k) + 1]);
            maxZ = Math.max(maxZ, portalVerticles[3 * (base_index + k) + 2]);
        }

        var distanceToBB = distanceFromAABBToPoint([[minX, minY, minZ],[maxX, maxY, maxZ]], point);

        var dotResult = (vec4.dot(vec4.fromValues(plane.x, plane.y, plane.z, plane.w), point));
        var isInsidePortalThis = (relation.side < 0) ? (dotResult <= 0) : (dotResult >= 0);
        if (!isInsidePortalThis && (Math.abs(dotResult) < 0.1) && (Math.abs(distanceToBB) < 0.1)) {
            insidePortals = false;
            break;
        }
    }

    return insidePortals;
  }

  calculateFrustumPoints(planes, numPlanes) {
    var points = [];
    for (var i = 0; i < numPlanes-2; i++) {
        for (var j = i+1; j < numPlanes-1; j++) {
            for (var k = j + 1; k < numPlanes; k++) {
                //Using Cramer's rule
                var detMat3 = mat3.fromValues(
                    planes[i][0],planes[j][0],planes[k][0],
                    planes[i][1],planes[j][1],planes[k][1],
                    planes[i][2],planes[j][2],planes[k][2]
                );
                var det = mat3.determinant(detMat3);
                if ((det > -0.0001) && (det < 0.0001)) continue;

                var det1Mat3 = mat3.fromValues(
                    -planes[i][3],-planes[j][3],-planes[k][3],
                    planes[i][1],planes[j][1],planes[k][1],
                    planes[i][2],planes[j][2],planes[k][2]
                );
                var det2Mat3 = mat3.fromValues(
                    planes[i][0],planes[j][0],planes[k][0],
                    -planes[i][3],-planes[j][3],-planes[k][3],
                    planes[i][2],planes[j][2],planes[k][2]
                );
                var det3Mat3 = mat3.fromValues(
                    planes[i][0],planes[j][0],planes[k][0],
                    planes[i][1],planes[j][1],planes[k][1],
                    -planes[i][3],-planes[j][3],-planes[k][3]
                );
                var x = mat3.determinant(det1Mat3) / det;
                var y = mat3.determinant(det2Mat3) / det;
                var z = mat3.determinant(det3Mat3) / det;

                points.push(vec3.fromValues(x,y,z))
            }
        }
    }

    return points;
  }

  calculateFrustumPointsFromMat(perspectiveViewMat) {
    var perspectiveViewMatInv = mat4.create();
    mat4.invert(perspectiveViewMatInv, perspectiveViewMat);

    const vertices = [
        [-1, -1, -1, 1], //0
        [ 1, -1, -1, 1],  //1
        [ 1, -1,  1, 1],   //2
        [-1, -1,  1, 1],  //3
        [-1,  1,  1, 1],   //4
        [ 1,  1,  1, 1],    //5
        [ 1,  1, -1, 1],   //6
        [-1,  1, -1, 1],  //7
    ] as ReadonlyVec4[];
    var points = new Array();
    for (var i = 0; i < vertices.length; i++) {
        var vert = vertices[i];
        var resVec4 = vec4.create();
        vec4.transformMat4(resVec4, vert, perspectiveViewMatInv);
        vec4.scale(resVec4, resVec4, 1/resVec4[3]);
        //vec4.transformMat4(resVec4, vert, perspectiveViewMat);

        points.push(resVec4);
    }

    return points;
  }

//   getTopAndBottomTriangleFromBsp(cameraLocal, groupFile, parentWmoFile, bspLeafList) {
//     var result = 0;
//     var nodes = groupFile.nodes;
//     var topZ = -999999;
//     var bottomZ = 999999;
//     var minPositiveDistanceToCamera = 99999;

//     //1. Loop through bsp results
//     for (var i = 0; i < bspLeafList.length; i++) {
//         var node = nodes[bspLeafList[i]];

//         for (var j = node.firstFace; j < node.firstFace + node.numFaces; j++) {
//             var vertexInd1 = groupFile.indicies[3 * groupFile.mobr[j] + 0];
//             var vertexInd2 = groupFile.indicies[3 * groupFile.mobr[j] + 1];
//             var vertexInd3 = groupFile.indicies[3 * groupFile.mobr[j] + 2];

//             var vert1 = vec3.fromValues(
//                 groupFile.verticles[3 * vertexInd1 + 0],
//                 groupFile.verticles[3 * vertexInd1 + 1],
//                 groupFile.verticles[3 * vertexInd1 + 2]);

//             var vert2 = vec3.fromValues(
//                 groupFile.verticles[3 * vertexInd2 + 0],
//                 groupFile.verticles[3 * vertexInd2 + 1],
//                 groupFile.verticles[3 * vertexInd2 + 2]);

//             var vert3 = vec3.fromValues(
//                 groupFile.verticles[3 * vertexInd3 + 0],
//                 groupFile.verticles[3 * vertexInd3 + 1],
//                 groupFile.verticles[3 * vertexInd3 + 2]);

//             //1. Get if camera position inside vertex

//             var minX = Math.min(vert1[0], vert2[0], vert3[0]);
//             var minY = Math.min(vert1[1], vert2[1], vert3[1]);
//             var minZ = Math.min(vert1[2], vert2[2], vert3[2]);

//             var maxX = Math.max(vert1[0], vert2[0], vert3[0]);
//             var maxY = Math.max(vert1[1], vert2[1], vert3[1]);
//             var maxZ = Math.max(vert1[2], vert2[2], vert3[2]);

//             var testPassed = (
//                 (cameraLocal[0] > minX && cameraLocal[0] < maxX) &&
//                 (cameraLocal[1] > minY && cameraLocal[1] < maxY)
//             );
//             if (!testPassed) continue;

//             var plane = createPlaneFromEyeAndVertexes(vert1, vert2, vert3);
//             //var z = MathHelper.calcZ(vert1,vert2,vert3,cameraLocal[0],cameraLocal[1]);
//             if ((plane[2] < 0.0001) && (plane[2] > -0.0001)) continue;

//             var z = (-plane[3] - cameraLocal[0] * plane[0] - cameraLocal[1] * plane[1]) / plane[2];

//             //2. Get if vertex top or bottom
//             var normal1 = vec3.fromValues(
//                 groupFile.normals[3 * vertexInd1 + 0],
//                 groupFile.normals[3 * vertexInd1 + 1],
//                 groupFile.normals[3 * vertexInd1 + 2]
//             );
//             var normal2 = vec3.fromValues(
//                 groupFile.normals[3 * vertexInd2 + 0],
//                 groupFile.normals[3 * vertexInd2 + 1],
//                 groupFile.normals[3 * vertexInd2 + 2]
//             );
//             var normal3 = vec3.fromValues(
//                 groupFile.normals[3 * vertexInd3 + 0],
//                 groupFile.normals[3 * vertexInd3 + 1],
//                 groupFile.normals[3 * vertexInd3 + 2]
//             );

//             var suggestedPoint = vec3.fromValues(cameraLocal[0], cameraLocal[1], z);
//             var bary = getBarycentric(
//                 suggestedPoint,
//                 vert1,
//                 vert2,
//                 vert3
//             );

//             if ((bary[0] < 0) || (bary[1] < 0) || (bary[2] < 0)) continue;
//             if (!this.checkIfInsidePortals(suggestedPoint, groupFile, parentWmoFile)) continue;

//             var normal_avg = bary[0] * normal1[2] + bary[1] * normal2[2] + bary[2] * normal3[2];
//             if (normal_avg > 0) {
//                 //Bottom
//                 var distanceToCamera = cameraLocal[2] - z;
//                 if ((distanceToCamera > 0) && (distanceToCamera < minPositiveDistanceToCamera))
//                     bottomZ = z;
//             } else {
//                 //Top
//                 topZ = Math.max(z, topZ);
//             }
//         }
//     }
//     //2. Try to get top and bottom from portal planes
//     var moprIndex = groupFile.mogp.moprIndex;
//     var numItems = groupFile.mogp.numItems;

//     for (var j = moprIndex; j < moprIndex + numItems; j++) {
//         var relation = parentWmoFile.portalRelations[j];
//         var portalInfo = parentWmoFile.portalInfos[relation.portal_index];

//         var nextGroup = relation.group_index;
//         var plane = portalInfo.plane;
//         plane = [plane.x, plane.y, plane.z, plane.w];
//         var base_index = portalInfo.base_index;
//         var portalVerticles = parentWmoFile.portalVerticles;


//         var dotResult = (vec4.dot(plane, cameraLocal));
//         var isInsidePortalThis = (relation.side < 0) ? (dotResult <= 0) : (dotResult >= 0);
//         //If we are going to borrow z from this portal, we should be inside it
//         if (!isInsidePortalThis) continue;

//         if ((plane[2] < 0.0001) && (plane[2] > -0.0001)) continue;
//         var z = (-plane[3] - cameraLocal[0] * plane[0] - cameraLocal[1] * plane[1]) / plane[2];

//         for (var k =0; k < portalInfo.index_count-2; k++) {
//             var portalIndex;
//             portalIndex = base_index+0;
//             var point1 = vec3.fromValues(
//                 portalVerticles[3 * (portalIndex)],
//                 portalVerticles[3 * (portalIndex) + 1],
//                 portalVerticles[3 * (portalIndex) + 2]);
//             portalIndex = base_index+k+1;
//             var point2 = vec3.fromValues(
//                 portalVerticles[3 * (portalIndex)],
//                 portalVerticles[3 * (portalIndex) + 1],
//                 portalVerticles[3 * (portalIndex) + 2]);
//             portalIndex = base_index+k+2;
//             var point3 = vec3.fromValues(
//                 portalVerticles[3 * (portalIndex)],
//                 portalVerticles[3 * (portalIndex) + 1],
//                 portalVerticles[3 * (portalIndex) + 2]);

//             var bary = getBarycentric(
//                 vec3.fromValues(cameraLocal[0], cameraLocal[1], z),
//                 point1,
//                 point2,
//                 point3
//             );
//             if ((bary[0] < 0) || (bary[1] < 0) || (bary[2] < 0)) continue;
//             if (z > cameraLocal[2]) {
//                 if (topZ < -99999)
//                     topZ = z;
//             }
//             if (z < cameraLocal[2]) {
//                 if (bottomZ > 99999)
//                     bottomZ = z;
//             }
//         }
//     }
//     if ((bottomZ > 99999) && (topZ < -99999)) {
//         return null;
//     }

//     return {'topZ': topZ, 'bottomZ': bottomZ};
// }

  // queryBox(box, nodeIndex, leafIndices) {
  //   if (nodeIndex === -1 || !this.nodes) {
  //     console.error("Node is empty", nodeIndex)
  //     return;
  //   }

  //   const node = this.nodes[nodeIndex];
    
  //   /*
  //     interface Node {
  //       faceStart: 0
  //       flags: 0
  //       nFaces: 0
  //       negChild: 361
  //       planeDist: -161
  //       posChild: 1
  //     }
  //   */

  //   if (node.flags === 4) {
  //     leafIndices.push(nodeIndex);
  //     return;
  //   }

  //   const leftPlane = new THREE.Plane();
  //   const rightPlane = new THREE.Plane();
  //   if (node.flags === 0) {
  //     leftPlane.setComponents(-1.0, 0.0, 0.0, node.planeDist);
  //     rightPlane.setComponents(1.0, 0.0, 0.0, -node.planeDist);
  //   } else if (node.flags === 1) {
  //     leftPlane.setComponents(0.0, -1.0, 0.0, node.planeDist);
  //     rightPlane.setComponents(0.0, 1.0, 0.0, -node.planeDist);
  //   } else if (node.flags === 2) {
  //     leftPlane.setComponents(0.0, 0.0, -1.0, node.planeDist);
  //     rightPlane.setComponents(0.0, 0.0, 1.0, -node.planeDist);
  //   }

  //   const includeLeft = THREEUtil.planeContainsBox(leftPlane, box);
  //   const includeRight = THREEUtil.planeContainsBox(rightPlane, box);

  //   if (includeLeft) {
  //     this.queryBox(box, node.negChild, leafIndices);
  //   }
    
  //   if (includeRight) {
  //     this.queryBox(box, node.posChild, leafIndices);
  //   }
  // }
  
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
    const epsilon = Number.EPSILON;
    
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
    const zRange = this.getTopAndBottomTriangleFromBsp(point, leafIndices)
    // Determine upper and lower Z bounds of leaves
    // const zRange = this.calculateZRange(point, leafIndices);
    // debugger;
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
    // console.log("cameraLocal", cameraLocal, this)
    var result = 0;
    var nodes = this.nodes;
    var topZ = -999999;
    var bottomZ = 999999;
    var minPositiveDistanceToCamera = 99999;
    for (var i = 0; i < leafIndices.length; i++) {
      var node = nodes[leafIndices[i]];

      for (var j = node.faceStart
        ; j < node.faceStart
        +node.nFaces; j++) {
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
    return [topZ, bottomZ];
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
