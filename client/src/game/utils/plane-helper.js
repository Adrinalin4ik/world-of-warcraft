/**
 * @author WestLangley / http://github.com/WestLangley
 */

import { 
  Line, 
  Mesh, 
  LineBasicMaterial, 
  MeshBasicMaterial,
  BufferAttribute,
  BufferGeometry,
  Object3D,
  FrontSide,
	BackSide ,
	Float32BufferAttribute
} from 'three';
// import { Line } from '../objects/Line.js';
// import { Mesh } from '../objects/Mesh.js';
// import { LineBasicMaterial } from '../materials/LineBasicMaterial.js';
// import { MeshBasicMaterial } from '../materials/MeshBasicMaterial.js';
// import { Float32BufferAttribute } from '../core/BufferAttribute.js';
// import { BufferGeometry } from '../core/BufferGeometry.js';
// import { Object3D } from '../core/Object3D.js';
// import { FrontSide, BackSide } from '../constants.js';

function PlaneHelper( plane, size, hex ) {

	this.type = 'PlaneHelper';

	this.plane = plane;

	this.size = size;

	var color = ( hex !== undefined ) ? hex : 0xffff00;

	if ( size === undefined ) size = 1;

	var positions = new Float32BufferAttribute([ 1, - 1, 1, - 1, 1, 1, - 1, - 1, 1, 1, 1, 1, - 1, 1, 1, - 1, - 1, 1, 1, - 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0 ]);

	var geometry = new BufferGeometry();

	geometry.setAttribute( 'position', new BufferAttribute( positions, 3 ) );

	Line.call( this, geometry, new LineBasicMaterial( { color: color } ) );

	this.geometry.computeBoundingSphere();

	this.update();

}

PlaneHelper.prototype = Object.create( Line.prototype );
PlaneHelper.prototype.constructor = PlaneHelper;

PlaneHelper.prototype.update = function () {

	var scale = - this.plane.constant;

	if ( Math.abs( scale ) < 1e-8 ) scale = 1e-8; // sign does not matter

	this.scale.set( 0.5 * this.size, 0.5 * this.size, scale );

	this.lookAt( this.plane.normal );

};

export { PlaneHelper };
