import * as THREE from 'three';
import { Geometry } from './geometry';

export default function geometryToBufferGeometry( geometry: Geometry ) {
  // var bufferGeometry = new THREE.BufferGeometry();

  // var positions = new Float32Array( geometry.vertices.length * 3 );

  // bufferGeometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ).copyVector3sArray( geometry.vertices ) );

  // if ( geometry.normals && geometry.normals.length > 0 ) {

  //   var normals = new Float32Array( geometry.normals.length * 3 );
  //   bufferGeometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ).copyVector3sArray( geometry.normals ) );

  // }

  // if ( geometry.colors && geometry.colors.length > 0 ) {

  //   var colors = new Float32Array( geometry.colors.length * 3 );
  //   bufferGeometry.setAttribute( 'color', new THREE.BufferAttribute( colors, 3 ).copyColorsArray( geometry.colors ) );

  // }

  // if ( geometry.uvs && geometry.uvs.length > 0 ) {

  //   var uvs = new Float32Array( geometry.uvs.length * 2 );
  //   bufferGeometry.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ).copyVector2sArray( geometry.uvs ) );

  // }

  // if ( geometry.uvs2 && geometry.uvs2.length > 0 ) {

  //   var uvs2 = new Float32Array( geometry.uvs2.length * 2 );
  //   bufferGeometry.setAttribute( 'uv2', new THREE.BufferAttribute( uvs2, 2 ).copyVector2sArray( geometry.uvs2 ) );

  // }

  // if ( geometry.indices && geometry.indices.length > 0 ) {

  //   var TypeArray = ArrayUtil.arrayMax( geometry.indices ) > 65535 ? Uint32Array : Uint16Array;
  //   var indices = new TypeArray( geometry.indices.length * 3 );
  //   bufferGeometry.setIndex( new THREE.BufferAttribute( indices, 1 ).copyIndicesArray( geometry.indices ) );

  // }

  // // groups

  // bufferGeometry.groups = geometry.groups;

  // // morphs

  // for ( var name in geometry.morphTargets ) {

  //   var array = [];
  //   var morphTargets = geometry.morphTargets[ name ];

  //   for ( var i = 0, l = morphTargets.length; i < l; i ++ ) {

  //     var morphTarget = morphTargets[ i ];

  //     var attribute = new THREE.Float32BufferAttribute( morphTarget.length * 3, 3 );

  //     array.push( attribute.copyVector3sArray( morphTarget ) );

  //   }

  //   bufferGeometry.morphAttributes[ name ] = array;

  // }

  // // skinning

  // if ( geometry.skinIndices.length > 0 ) {
  //   let arr = [];
  //   for (const skinIndex of geometry.skinIndices) {
  //     arr.push(skinIndex.x, skinIndex.y, skinIndex.z, skinIndex.w)
  //   }
  //   var skinIndices = new THREE.BufferAttribute( new Float32Array(arr), 4 );
  //   bufferGeometry.setAttribute( 'skinIndex', skinIndices);

  // }

  // if ( geometry.skinWeights.length > 0 ) {

  //   let arr = [];
  //   for (const skinWeight of geometry.skinWeights) {
  //     arr.push(skinWeight.x, skinWeight.y, skinWeight.z, skinWeight.w)
  //   }
  //   var skinWeights = new THREE.BufferAttribute( new Float32Array(arr), 4 );

  //   bufferGeometry.setAttribute( 'skinWeight', skinWeights );

  // }

  // //

  // if ( geometry.boundingSphere !== null ) {

  //   bufferGeometry.boundingSphere = geometry.boundingSphere.clone();

  // }

  // if ( geometry.boundingBox !== null ) {

  //   bufferGeometry.boundingBox = geometry.boundingBox.clone();

  // }
  
  // ... add vertices and faces to the geometry ...

  // create a new BufferGeometry object
  const bufferGeometry = new THREE.BufferGeometry();

  // create a Float32Array to hold the vertex positions
  const positions = new Float32Array(geometry.vertices.length * 3);

  // loop through each vertex and store its position in the positions array
  for (let i = 0; i < geometry.vertices.length; i++) {
    positions[i * 3] = geometry.vertices[i].x;
    positions[i * 3 + 1] = geometry.vertices[i].y;
    positions[i * 3 + 2] = geometry.vertices[i].z;
  }

  // create a new BufferAttribute for the positions
  const positionAttribute = new THREE.BufferAttribute(positions, 3);

  // set the position attribute on the buffer geometry
  bufferGeometry.addAttribute('position', positionAttribute);

  // create a Uint16Array to hold the face indices
  const indices = new Uint16Array(geometry.faces.length * 3);

  // loop through each face and store its indices in the indices array
  for (let i = 0; i < geometry.faces.length; i++) {
    indices[i * 3] = geometry.faces[i].a;
    indices[i * 3 + 1] = geometry.faces[i].b;
    indices[i * 3 + 2] = geometry.faces[i].c;
  }

  // create a new BufferAttribute for the indices
  const indexAttribute = new THREE.BufferAttribute(indices, 1);

  // set the index attribute on the buffer geometry
  bufferGeometry.setIndex(indexAttribute);

  return bufferGeometry;

}