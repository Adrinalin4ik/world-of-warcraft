import { THREE } from 'enable3d';

import LiquidLayer from './layer';

class Liquid extends THREE.Group {

  constructor(data) {
    super();

    this.data = data;

    this.data.layers.forEach((layer) => {
      this.add(new LiquidLayer(layer));
    });
  }

 }

export default Liquid;
