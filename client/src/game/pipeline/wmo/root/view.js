import { THREE } from 'enable3d';

class WMORootView extends THREE.Group {

  constructor(root) {
    super();

    this.matrixAutoUpdate = false;

    this.root = root;
  }

  clone() {
    return this.root.createView();
  }

}

export default WMORootView;
