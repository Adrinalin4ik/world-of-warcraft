import * as THREE from 'three';

import WMOLiquidLayer from './wmo-layer';

class WMOLiquid extends THREE.Group {

  constructor(data) {
    super();

    this.data = data;

    // Create liquid layers from MLIQ data
    if (data.layers && data.layers.length > 0) {
      data.layers.forEach((layer) => {
        // Add MLIQ-specific data to the layer
        const wmoLayerData = {
          ...layer,
          // Add MLIQ-specific fields
          liquidCorner: data.liquidCorner,
          liquidVerts: data.liquidVerts,
          liquidTiles: data.liquidTiles,
          vertices: data.vertices,
          tiles: data.tiles
        };
        
        this.add(new WMOLiquidLayer(wmoLayerData));
      });
    }
  }

}

export default WMOLiquid;
