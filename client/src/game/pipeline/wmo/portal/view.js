import * as THREE from 'three';

import THREEUtil from '../../../utils/three-util';
import {vec4, vec3} from 'gl-matrix';

class WMOPortalView extends THREE.Mesh {

  constructor(portal, geometry, material) {
    super();

    this.matrixAutoUpdate = false;

    this.portal = portal;
    this.geometry = geometry;
    this.material = material;
  }

  clone() {
    return this.portal.createView();
  }

  /**
   * Projects a new frustum from this portal using an origin point and restricting the new
   * frustum to include only the spill from the given frustum.
   *
   * @param origin - Position to use when projecting new frustum
   * @param frustum - Previous frustum (used to clip portal vertices)
   * @param flip - Optional, specify that the new frustum sides should be flipped
   *
   * @returns - Frustum clipped by this portal
   *
   */
  createFrustum(camera, frustum, flip = false) {
    // return frustum
    const planes = [];
    const vertices = [];

    const origin = camera.position.clone();

    // Obtain vertices in world space
    for (let vindex = 0, vcount = this.geometry.vertices.length; vindex < vcount; ++vindex) {
      const local = this.geometry.vertices[vindex].clone();
      const world = this.localToWorld(local);
      vertices.push(world);
    }

    // Check distance to portal
    const distance = this.portal.plane.distanceToPoint(this.worldToLocal(origin));
    const close = distance < 1.0 && distance > -1.0;

    // If the portal is very close, use the portal vertices unedited; otherwise, clip the portal
    // vertices by the provided frustum.
    const clipped = close ? vertices : THREEUtil.clipVerticesByFrustum(vertices, frustum);

    // If clipping the portal vertices resulted in a polygon with fewer than 3 vertices, return
    // null to indicate a new frustum couldn't be produced.
    // console.log(clipped.length)
    if (clipped.length < 3) {
      return null;
    }

    // // Produce side planes for new frustum
    for (let vindex = 0, vcount = clipped.length; vindex < vcount; ++vindex) {
      const vertex1 = clipped[vindex];
      const vertex2 = clipped[(vindex + 1) % vcount];

      const plane = new THREE.Plane().setFromCoplanarPoints(origin, vertex1, vertex2);
      // if (flip) plane.negate();
      planes.push(plane);
    }

    // // Copy the original far plane (index: last - 1)
    // const farPlaneIndex = frustum.planes.length - 1;
    // const farPlane = frustum.planes[farPlaneIndex];
    // planes.push(farPlane);

    // // Create a near plane matching the portal
    // const nearPlane = new THREE.Plane().setFromCoplanarPoints(clipped[0], clipped[1], clipped[2]);
    // if (flip) nearPlane.negate();
    // planes.push(nearPlane);

    const newFrustum = { planes };

    return newFrustum;
  }

  /**
   * Check if a given frustum contains or intersects with this portal view.
   *
   * @param frustum - Frustum object containing planes to check for portal inclusion / intersection
   *
   * @returns {Boolean} - Boolean indicating if the given frustum contained or intersected with
   * this portal view
   *
   */
  intersectFrustum(frustum) {
    const planes = frustum.planes;
    const vertices = this.geometry.vertices;

    for (let pindex = 0, pcount = planes.length; pindex < pcount; ++pindex) {
      const plane = planes[pindex];

      if (!plane) {
        continue;
      }

      let inside = 0;

      for (let vindex = 0, vcount = vertices.length; vindex < vcount; ++vindex) {
        const vertex = this.localToWorld(vertices[vindex].clone());
        const distance = plane.distanceToPoint(vertex);

        if (distance >= 0.0) {
          inside++;
        }
      }

      if (inside === 0) {
        return false;
      }
    }

    return true;
  }

  planeCull(planes) {
    const points = this.geometry.vertices;
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

    // for( var j = 0; j < vec4Points.length; j++) {
    //     points[j] = vec4Points[j];
    // }

    return vec4Points.length > 2;
}

}

export default WMOPortalView;
