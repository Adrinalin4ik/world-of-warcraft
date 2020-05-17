import * as THREE from 'three';
import {vec4, vec3} from 'gl-matrix';

class THREEUtil {

  static planeContainsBox(plane, box) {
    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();

    p1.x = plane.normal.x > 0 ? box.min.x : box.max.x;
    p2.x = plane.normal.x > 0 ? box.max.x : box.min.x;
    p1.y = plane.normal.y > 0 ? box.min.y : box.max.y;
    p2.y = plane.normal.y > 0 ? box.max.y : box.min.y;
    p1.z = plane.normal.z > 0 ? box.min.z : box.max.z;
    p2.z = plane.normal.z > 0 ? box.max.z : box.min.z;

    const d1 = plane.distanceToPoint(p1);
    const d2 = plane.distanceToPoint(p2);

    if (d1 < 0 && d2 < 0) {
      return false;
    }

    return true;
  }

  static frustumContainsBox(frustum, box) {
    for (let pindex = 0, pcount = frustum.planes.length; pindex < pcount; ++pindex) {
      const plane = frustum.planes[pindex];

      if (!this.planeContainsBox(plane, box)) {
        return false;
      }
    }

    return true;
  }

  // static planeCull(vertices, planes) {
  //   const points = this.geometry.vertices;
  //   function intersection(p1, p2, k) {
  //       return vec4.fromValues(
  //           p1[0] + k * (p2[0] - p1[0]),
  //           p1[1] + k * (p2[1] - p1[1]),
  //           p1[2] + k * (p2[2] - p1[2]),
  //           1
  //       );
  //   }

  //   // check box outside/inside of frustum
  //   var vec4Points = new Array(points.length);
  //   for( var j = 0; j < points.length; j++) {
  //       vec4Points[j] = vec4.fromValues(points[j][0], points[j][1], points[j][2], 1.0)
  //   }

  //   for ( var i=0; i< planes.length; i++ ) {
  //       var out = 0;
  //       var epsilon = 0;

  //       for( var j = 0; j < vec4Points.length; j++) {
  //           out += ((vec4.dot(planes[i], vec4Points[j]) + epsilon < 0.0 ) ? 1 : 0);
  //       }

  //       if( out === vec4Points.length ) return false;

  //       //---------------------------------
  //       // Cull by points by current plane
  //       //---------------------------------
  //       var resultPoints = new Array();
  //       var pointO;
  //       if (planes[i][2] != 0) {
  //           pointO = vec3.fromValues(0,0,-planes[i][3]/planes[i][2]);
  //       } else if (planes[i][1] != 0) {
  //           pointO = vec3.fromValues(0,-planes[i][3]/planes[i][1],0);
  //       } else if (planes[i][0] != 0) {
  //           pointO = vec3.fromValues(-planes[i][3]/planes[i][0],0,0);
  //       } else {
  //           continue;
  //       }

  //       for (j = 0; j < vec4Points.length; j++) {
  //           var p1 = vec4Points[j];
  //           var p2 = vec4Points[(j + 1) % vec4Points.length];

  //           // InFront = plane.Distance( point ) > 0.0f
  //           // Behind  = plane.Distance( point ) < 0.0f

  //           var t1 = vec4.dot(p1, planes[i]);
  //           var t2 = vec4.dot(p2, planes[i]);

  //           if (t1 > 0 && t2 > 0) { //p1 InFront and p2 InFront
  //               resultPoints.push(p2)
  //           } else if (t1 > 0 && t2 < 0) { //p1 InFront and p2 Behind
  //               var k = t1/(t1 - t2);
  //               resultPoints.push(intersection(p1, p2, k))
  //           } else if (t1 < 0 && t2 > 0) { //p1 Behind and p2 Behind
  //               var k = t1/(t1 - t2);
  //               resultPoints.push(intersection(p1, p2, k))
  //               resultPoints.push(p2)
  //           }
  //       }
  //       vec4Points = resultPoints;
  //   }

  //   // for( var j = 0; j < vec4Points.length; j++) {
  //   //     points[j] = vec4Points[j];
  //   // }

  //   return vec4Points.length > 2;
  // }

  static createPlaneFromEyeAndVertexes(eye, vertex1, vertex2) {
    var edgeDir1 = vec4.create();
    vec3.subtract(edgeDir1, vertex1, eye);

    var edgeDir2 = vec4.create();
    vec3.subtract(edgeDir2, vertex2, eye);

    //planeNorm=cross(viewDir, edgeDir)
    var planeNorm = vec4.create();
    vec3.cross(planeNorm, edgeDir2, edgeDir1);
    vec3.normalize(planeNorm, planeNorm);

    //Plane fpl(planeNorm, dot(planeNorm, vertexA))
    var distToPlane = vec3.dot(planeNorm, eye);
    planeNorm[3] = -distToPlane;

    return planeNorm;
  }

  static sortVec3ArrayAgainstPlane(thisPortalVertices, plane) {
    var center = vec3.fromValues(0, 0, 0);
    for (var j = 0; j < thisPortalVertices.length; j++) {
        vec3.add(center, thisPortalVertices[j], center);
    }
    vec3.scale(center, 1 / thisPortalVertices.length);
    thisPortalVertices.sort(function (a, b) {
        var ac = vec3.create();
        vec3.subtract(ac, a, center);

        var bc = vec3.create();
        vec3.subtract(bc, b, center);

        var cross = vec3.create();
        vec3.cross(cross, ac, bc);

        var dotResult = vec3.dot(cross, [plane.x, plane.y, plane.z]);

        return dotResult;
    });
  }

  static planeCull (points, planes) {
    // console.log(points, planes)
    function intersection(p1, p2, k) {
        return vec4.fromValues(
            p1[0] + k * (p2[0] - p1[0]),
            p1[1] + k * (p2[1] - p1[1]),
            p1[2] + k * (p2[2] - p1[2]),
            1
        );
    }

    // check box outside/inside of frustum
    var vec4Points = new Array(points.length);
    for( var j = 0; j < points.length; j++) {
        vec4Points[j] = vec4.fromValues(points[j][0], points[j][1], points[j][2], 1.0)
    }

    for ( var i=0; i< planes.length; i++ ) {
        var out = 0;
        var epsilon = 0;

        for( var j = 0; j < vec4Points.length; j++) {
            out += ((vec4.dot(planes[i], vec4Points[j]) + epsilon < 0.0 ) ? 1 : 0);
        }

        if( out==vec4Points.length ) return false;

        //---------------------------------
        // Cull by points by current plane
        //---------------------------------
        var resultPoints = new Array();
        var pointO;
        if (planes[i][2] != 0) {
            pointO = vec3.fromValues(0,0,-planes[i][3]/planes[i][2]);
        } else if (planes[i][1] != 0) {
            pointO = vec3.fromValues(0,-planes[i][3]/planes[i][1],0);
        } else if (planes[i][0] != 0) {
            pointO = vec3.fromValues(-planes[i][3]/planes[i][0],0,0);
        } else {
            continue;
        }

        for (j = 0; j < vec4Points.length; j++) {
            var p1 = vec4Points[j];
            var p2 = vec4Points[(j + 1) % vec4Points.length];

            // InFront = plane.Distance( point ) > 0.0f
            // Behind  = plane.Distance( point ) < 0.0f

            var t1 = vec4.dot(p1, planes[i]);
            var t2 = vec4.dot(p2, planes[i]);

            if (t1 > 0 && t2 > 0) { //p1 InFront and p2 InFront
                resultPoints.push(p2)
            } else if (t1 > 0 && t2 < 0) { //p1 InFront and p2 Behind
                var k = t1/(t1 - t2);
                resultPoints.push(intersection(p1, p2, k))
            } else if (t1 < 0 && t2 > 0) { //p1 Behind and p2 Behind
                var k = t1/(t1 - t2);
                resultPoints.push(intersection(p1, p2, k))
                resultPoints.push(p2)
            }
        }
        vec4Points = resultPoints;
    }

    for( var j = 0; j < vec4Points.length; j++) {
        points[j] = vec4Points[j];
    }

    return vec4Points.length > 2;
  }

  static clipVerticesByPlane(vertices, plane) {
    const clipped = [];

    for (let vindex = 0, vcount = vertices.length; vindex < vcount; ++vindex) {
      const v1 = vertices[vindex];
      const v2 = vertices[(vindex + 1) % vcount];

      const d1 = plane.distanceToPoint(v1);
      const d2 = plane.distanceToPoint(v2);

      const line = new THREE.Line3(v1, v2);
      const intersection = d1 / (d1 - d2);

      if (d1 < 0 && d2 < 0) {
        continue;
      } else if (d1 > 0 && d2 > 0) {
        clipped.push(v1);
      } else if (d1 > 0) {
        clipped.push(v1);
        clipped.push(line.at(intersection));
      } else {
        clipped.push(line.at(intersection));
      }

      // if (d1 > 0 && d2 > 0) {
      //   clipped.push(v2);
      // } else if (d1 > 0 && d2 < 0) {
      //   // clipped.push(v1);
      //   clipped.push(line.at(intersection));
      // } else if (d1 < 0 && d2 > 0) {
      //   clipped.push(line.at(intersection));
      //   clipped.push(v2)
      // }
    }

    return clipped;
  }

  static clipVerticesByFrustum(vertices, frustum) {
    const planes = frustum.planes;

    let clipped = vertices;

    for (const plane of planes) {

      if (!plane) {
        continue;
      }

      clipped = this.clipVerticesByPlane(clipped, plane);
    }

    return clipped;
  }

}

export default THREEUtil;
