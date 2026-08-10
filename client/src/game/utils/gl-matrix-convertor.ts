import { vec3 } from 'gl-matrix';
import * as THREE from 'three';

export const convert = {
  vector3: {
    gl: function(v: THREE.Vector3) {
      return vec3.fromValues(v.x, v.y, v.z);
    },
    three: function(v: vec3) {
      return new THREE.Vector3(v[0], v[1], v[2]);
    }
  }
}