import { DecodeStream } from 'restructure';
import WDT from '../../../wow-data-parser/wdt';
import Loader from '../../net/loader';

type WDTData = {
  flags: number;
  tiles: number[];
  wmoRefs: any[];
  doodadRefs: any[];
  liquidTypes: any[];
};

type WDTLoadOptions = {
  cache?: boolean;
  timeout?: number;
};

class WDTLoader {
  private loader: Loader;
  private cache = new Map<string, WDTData>();
  private loading = new Map<string, Promise<WDTData>>();

  constructor() {
    this.loader = new Loader();
  }

  /**
   * Load WDT data from path
   */
  async load(path: string, options: WDTLoadOptions = {}): Promise<WDTData> {
    const cacheKey = path;
    
    // Check cache first
    if (options.cache !== false && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Check if already loading
    if (this.loading.has(cacheKey)) {
      return this.loading.get(cacheKey)!;
    }

    // Start loading
    const promise = this._load(path, options);
    this.loading.set(cacheKey, promise);

    try {
      const data = await promise;
      
      // Cache the result
      if (options.cache !== false) {
        this.cache.set(cacheKey, data);
      }
      
      return data;
    } finally {
      this.loading.delete(cacheKey);
    }
  }

  /**
   * Internal load method
   */
  private async _load(path: string, options: WDTLoadOptions): Promise<WDTData> {
    try {
      const raw = await this.loader.load(path);
      const buffer = new Buffer(new Uint8Array(raw));
      const stream = new DecodeStream(buffer);
      const wdtData = WDT.decode(stream);

      return this.processWDTData(wdtData);
    } catch (error) {
      console.error(`Failed to load WDT from ${path}:`, error);
      throw error;
    }
  }

  /**
   * Process raw WDT data into a more usable format
   */
  private processWDTData(rawData: any): WDTData {
    const data: WDTData = {
      flags: rawData.flags || 0,
      tiles: rawData.tiles || [],
      wmoRefs: rawData.MWMO?.refs || [],
      doodadRefs: rawData.MDDF?.refs || [],
      liquidTypes: rawData.MLHD?.liquidTypes || []
    };

    // Validate tile data
    if (data.tiles.length !== 4096) {
      console.warn(`WDT has ${data.tiles.length} tiles, expected 4096`);
    }

    return data;
  }

  /**
   * Get tile flags for a specific area
   */
  getTileFlags(data: WDTData, areaX: number, areaY: number): number {
    if (areaX < 0 || areaX >= 64 || areaY < 0 || areaY >= 64) {
      return 0;
    }

    const tileIndex = areaY * 64 + areaX;
    return data.tiles[tileIndex] || 0;
  }

  /**
   * Check if an area has terrain
   */
  hasTerrain(data: WDTData, areaX: number, areaY: number): boolean {
    const flags = this.getTileFlags(data, areaX, areaY);
    return (flags & 0x1) !== 0; // ADT_HAS_MCCV
  }

  /**
   * Check if an area has height data
   */
  hasHeight(data: WDTData, areaX: number, areaY: number): boolean {
    const flags = this.getTileFlags(data, areaX, areaY);
    return (flags & 0x2) !== 0; // ADT_HAS_MHDR
  }

  /**
   * Check if an area has liquid data
   */
  hasLiquid(data: WDTData, areaX: number, areaY: number): boolean {
    const flags = this.getTileFlags(data, areaX, areaY);
    return (flags & 0x4) !== 0; // ADT_HAS_MH2O
  }

  /**
   * Get WMO references for an area
   */
  getWMORefs(data: WDTData, areaX: number, areaY: number): any[] {
    if (!data.wmoRefs) return [];

    return data.wmoRefs.filter(ref => {
      // Check if WMO is in this area
      const refAreaX = Math.floor((ref.position.x + 17066.666) / 533.333);
      const refAreaY = Math.floor((ref.position.z + 17066.666) / 533.333);
      
      return refAreaX === areaX && refAreaY === areaY;
    });
  }

  /**
   * Get doodad references for an area
   */
  getDoodadRefs(data: WDTData, areaX: number, areaY: number): any[] {
    if (!data.doodadRefs) return [];

    return data.doodadRefs.filter(ref => {
      // Check if doodad is in this area
      const refAreaX = Math.floor((ref.position.x + 17066.666) / 533.333);
      const refAreaY = Math.floor((ref.position.z + 17066.666) / 533.333);
      
      return refAreaX === areaX && refAreaY === areaY;
    });
  }

  /**
   * Get liquid types for an area
   */
  getLiquidTypes(data: WDTData, areaX: number, areaY: number): any[] {
    if (!data.liquidTypes) return [];

    return data.liquidTypes.filter(liquid => {
      // Check if liquid is in this area
      const liquidAreaX = Math.floor((liquid.position.x + 17066.666) / 533.333);
      const liquidAreaY = Math.floor((liquid.position.z + 17066.666) / 533.333);
      
      return liquidAreaX === areaX && liquidAreaY === areaY;
    });
  }

  /**
   * Get all areas that have data
   */
  getActiveAreas(data: WDTData): Array<{ areaX: number; areaY: number; flags: number }> {
    const areas: Array<{ areaX: number; areaY: number; flags: number }> = [];

    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const flags = this.getTileFlags(data, x, y);
        if (flags !== 0) {
          areas.push({ areaX: x, areaY: y, flags });
        }
      }
    }

    return areas;
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache size
   */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * Preload WDT data
   */
  async preload(paths: string[]): Promise<void> {
    const promises = paths.map(path => this.load(path));
    await Promise.all(promises);
  }
}

export default WDTLoader;


