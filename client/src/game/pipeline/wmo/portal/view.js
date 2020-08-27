import { THREE } from 'enable3d';
import { PlaneHelper } from '../../../utils/plane-helper';
import { FrustumHelper } from '../../../utils/frustum-helper';
import THREEUtil from '../../../utils/three-util';
import {vec4, vec3} from 'gl-matrix';
import DebugPanel from '../../../../pages/game/debug/debug'
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

  portalCull(camera, frustum, flip) {
    const frustumPlanes = [];
    const vertices = [];
    const origin = camera.position.clone();
    // let local = this.worldToLocal(origin);
    // local = new THREE.Vector3(-local.x, -local.y, local.z)
    // Obtain vertices in world space
    for (let vindex = 0, vcount = this.geometry.vertices.length; vindex < vcount; ++vindex) {
      const local = this.geometry.vertices[vindex].clone();
      const world = this.localToWorld(local);
      const {x, y, z} = world;
      vertices.push([x, y, z, 1]);
    }

    for (const plane of frustum.planes) {
      const {x, y, z} = plane.normal;
      frustumPlanes.push([x, y, z, plane.constant])
    }
    var thisPortalVertices = vertices;
    var thisPortalVerticesCopy = thisPortalVertices.slice(0);
    for (var i = 0; i < thisPortalVerticesCopy.length; i++)
        thisPortalVerticesCopy[i] = vec4.clone(thisPortalVerticesCopy[i]);

    var visible = true;
    for (var i = 0; visible && i < frustumPlanes.length; i++) {
        visible = visible && THREEUtil.planeCull(thisPortalVerticesCopy, frustumPlanes);
    }
    DebugPanel.test3 = visible.toString();
    if (!visible) return null;

    const {x, y, z} = this.portal.plane.normal;
    const plane = [x, y, z, this.portal.plane.constant]
    THREEUtil.sortVec3ArrayAgainstPlane(thisPortalVerticesCopy, plane);

    // var lastFrustumPlanesLen = frustumPlanes.length;

    //3. Construct frustum planes for this portal
    var thisPortalPlanes = [];
    
    const cameraVec4 = [origin.x, origin.y, origin.z]
    for (var i = 0; i < thisPortalVerticesCopy.length; ++i) {
        var i2 = (i + 1) % thisPortalVerticesCopy.length;

        var n = THREEUtil.createPlaneFromEyeAndVertexes(cameraVec4, thisPortalVerticesCopy[i], thisPortalVerticesCopy[i2]);

        if (flip) {
            vec4.scale(n, n, -1)
        }

        const plane = new THREE.Plane(new THREE.Vector3(n[0], n[1], n[2]), n[3])
        thisPortalPlanes.push(plane);
    }
    // console.log(thisPortalPlanes)
    return { planes: thisPortalPlanes }
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
    // let local = this.worldToLocal(origin);
    // local = new THREE.Vector3(-local.x, -local.y, local.z)
    // Obtain vertices in world space
    for (let vindex = 0, vcount = this.geometry.vertices.length; vindex < vcount; ++vindex) {
      const local = this.geometry.vertices[vindex].clone();
      const world = this.localToWorld(local);
      vertices.push(world);
    }

    // for (var i = 0; i < vertices.length; ++i) {
    //     var i2 = (i + 1) % vertices.length;

    //     // var n = mathHelper.createPlaneFromEyeAndVertexes(cameraVec4, thisPortalVerticesCopy[i], thisPortalVerticesCopy[i2]);
    //     const eye = origin;
    //     const vertex1 = vertices[i]
    //     const vertex2 = vertices[i2]
    //     var edgeDir1 = new THREE.Vector3();
    //     edgeDir1.subVectors(vertex1, eye)
        
    //     var edgeDir2 = new THREE.Vector3();
    //     edgeDir2.subVectors(vertex2, eye)
        
    //     const normVector = new THREE.Vector3();
    //     normVector.cross(edgeDir2, edgeDir1);
    //     normVector.normalize();
    //     const distToPlane = normVector.distanceTo(eye);
    //     normVector.z = -distToPlane;

    //     const planeNorm = new THREE.Plane(normVector);

    //     if (flip) {
    //       planeNorm.negate();
    //     }
    //     // console.warn('here', planeNorm)
    //     planes.push(planeNorm);
    // }

    // Check distance to portal
    const distance = this.portal.plane.distanceToPoint(this.worldToLocal(origin));
    const close = distance > 1.0 && distance < -1.0;
    DebugPanel.test1 = distance.toString();
    // console.log(distance)
    /* 
      If the portal is very close, use the portal vertices unedited; otherwise, clip the portal
      vertices by the provided frustum.
    */
    const clipped = THREEUtil.clipVerticesByFrustum(vertices, frustum)//close ? vertices : THREEUtil.clipVerticesByFrustum(vertices, frustum);

    // If clipping the portal vertices resulted in a polygon with fewer than 3 vertices, return
    // null to indicate a new frustum couldn't be produced.
    DebugPanel.test2 = clipped.length;
    if (clipped.length < 3) {
      return null;
    }

    // Produce side planes for new frustum
    for (let vindex = 0, vcount = clipped.length; vindex < vcount; ++vindex) {
      const vertex1 = clipped[vindex];
      const vertex2 = clipped[(vindex + 1) % vcount];

      const plane = new THREE.Plane().setFromCoplanarPoints(vertex1, vertex2, origin);
      // if (flip) plane.negate();
      planes.push(plane);
    }

    // Copy the original far plane (index: last - 1)
    const farPlaneIndex = frustum.planes.length - 1;
    const farPlane = frustum.planes[farPlaneIndex];
    planes.push(farPlane);
    // this.add(new THREE.PlaneHelper( farPlane, 1, 0xff0000 ));
    // Create a near plane matching the portal
    const nearPlane = new THREE.Plane().setFromCoplanarPoints(clipped[0], clipped[1], clipped[2]);
    // if (flip) nearPlane.negate();
    planes.push(nearPlane);
    // let h = new PlaneHelper( nearPlane, 10, 0x0000ff );
    // this.add(h);
    // const planeHelper = new PlaneHelper( nearPlane, 10, 0xff0000 );
    // planeHelper.position.set(
    //   this.parent.position.x, 
    //   this.parent.position.y, 
    //   this.parent.position.z)
    // console.log(this.parent.parent.parent)
    // this.add(planeHelper);
    DebugPanel.test3 = planes.length;
    const newFrustum = { planes };
    // DebugPanel.test3 = DebugPanel.frustumToString(newFrustum.planes);
    // const fr = new THREE.Frustum(...planes);
    // const h = new FrustumHelper(fr);
    // console.log(h)
    // this.parent.add(h)
    this.material.color = new THREE.Color(0xff0000);
    // this.material.opacity = 1;
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
}

export default WMOPortalView;
