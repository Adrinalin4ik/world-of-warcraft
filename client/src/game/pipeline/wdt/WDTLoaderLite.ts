import { DecodeStream } from 'restructure';
import WDT from '../../../wow-data-parser/wdt';
import Loader from '../../net/loader';

type WDTDataLite = {
  flags: number;
  tiles: number[];
};

class WDTLoaderLite {
  private loader: Loader;
  private cache = new Map<string, WDTDataLite>();

  constructor() {
    this.loader = new Loader();
  }

  /**
   * Load WDT data from path (with simple caching)
   */
  async load(path: string): Promise<WDTDataLite> {
    // Check cache first
    if (this.cache.has(path)) {
      return this.cache.get(path)!;
    }

    try {
      const raw = await this.loader.load(path);
      const buffer = new Buffer(new Uint8Array(raw));
      const stream = new DecodeStream(buffer);
      const wdtData = WDT.decode(stream);

      const data: WDTDataLite = {
        flags: wdtData.flags || 0,
        tiles: wdtData.tiles || []
      };

      // Cache the result
      this.cache.set(path, data);
      
      return data;
    } catch (error) {
      console.error(`Failed to load WDT from ${path}:`, error);
      throw error;
    }
  }

  /**
   * Get tile flags for a specific area
   */
  getTileFlags(data: WDTDataLite, areaX: number, areaY: number): number {
    if (areaX < 0 || areaX >= 64 || areaY < 0 || areaY >= 64) {
      return 0;
    }

    const tileIndex = areaY * 64 + areaX;
    return data.tiles[tileIndex] || 0;
  }

  /**
   * Check if an area has data
   */
  hasData(data: WDTDataLite, areaX: number, areaY: number): boolean {
    return this.getTileFlags(data, areaX, areaY) !== 0;
  }

  /**
   * Get all areas that have data (simplified)
   */
  getActiveAreas(data: WDTDataLite): Array<{ areaX: number; areaY: number }> {
    const areas: Array<{ areaX: number; areaY: number }> = [];

    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (this.hasData(data, x, y)) {
          areas.push({ areaX: x, areaY: y });
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
}

export default WDTLoaderLite;


