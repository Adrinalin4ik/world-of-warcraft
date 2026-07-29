import * as THREE from 'three';
import { Face3, Geometry } from '../../../utils/geometry';
import WMOPortalView from './view';

class WMOPortal {
  public index: number;
  public vertices = [];
  public parent: THREE.Object3D;
  public boundingBox =  new THREE.Box3();
  public normal: THREE.Vector3;
  public plane: THREE.Plane;
  public constant: number;
  public legacyGeometry: Geometry;
  public geometry: THREE.BufferGeometry;
  public material: THREE.MeshBasicMaterial;
  constructor(def, parent) {
    this.index = def.index;
    // console.log(this, def)
    const vertexCount = def.vertices.length / 3;

    const vertices = this.vertices = [];
    this.parent = parent;

    for (let vindex = 0; vindex < vertexCount; ++vindex) {
      const vertex = new THREE.Vector3(
        def.vertices[vindex * 3],
        def.vertices[vindex * 3 + 1],
        def.vertices[vindex * 3 + 2]
      );

      // Stretch bounding box
      this.boundingBox.expandByPoint(vertex);
        
      vertices.push(vertex);
    }

    // this.boundingBox.setFromPoints(this.vertices)
    const normal = this.normal = new THREE.Vector3(def.normal[0], def.normal[1], def.normal[2]);
    const constant = this.constant = def.constant;
    this.plane = new THREE.Plane(normal, constant);

    this.createGeometry(vertices);
    this.createMaterial();

    setInterval(() => {
      this.material.color = new THREE.Color(0xff0000);
    }, 1000)
  }

  createView() {
    return new WMOPortalView(this, this.legacyGeometry, this.material);
  }

  createGeometry(vertices) {
    const geometry = this.legacyGeometry = new Geometry();

    const vertexCount = vertices.length;

    for (let vindex = 0; vindex < vertexCount; ++vindex) {
      geometry.vertices.push(vertices[vindex]);
    }

    const faceCount = vertexCount - 2;

    for (let findex = 0; findex < faceCount; ++findex) {
      geometry.faces.push(new Face3(findex + 1, findex + 2, 0));
    }

    this.geometry = geometry.toBufferGeometry();
    // this.geometry.computeBoundsTree();
  }

  createMaterial() {
    const material = this.material = new THREE.MeshBasicMaterial();

    material.color = new THREE.Color(0xff0000);
    material.side = THREE.DoubleSide;
    material.opacity = 0.2;
    material.transparent = true;
    material.depthWrite = true;
    material.visible = false;
    material.wireframe = false
  }

}

export default WMOPortal;
