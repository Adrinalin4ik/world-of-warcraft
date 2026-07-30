import { Buffer } from 'buffer';
import { DecodeStream } from 'restructure';

import {
  BLP_COLOR_FORMAT,
  BLP_IMAGE_FORMAT,
  BLP_MAGIC,
  BLP_PIXEL_FORMAT,
  MAX_MIP_LEVELS,
} from './const';
import {
  dxt1ToAbgr8888,
  dxt3ToAbgr8888,
  dxt5ToAbgr8888,
  getDxt1Size,
  getDxt3Size,
  getDxt5Size,
} from './dxt';
import { palToAbgr8888 } from './pal';
import { rawArgb8888ToAbgr8888 } from './raw';
import * as blpIo from './io';
import { getResizedBytes, getSizeAtMipLevel } from './util';
import BlpImage from './blp-image';

/**
 * Decoder for Blizzard's BLP2 texture format.
 *
 * Ported from the pure-TypeScript decoder in the WowPlunderstorm scene library, itself derived from
 * dxtn and squish. Decode only: this replaced an ffi-napi binding to BLPConverter, which cannot run
 * in a browser now that textures are fetched as raw .blp files instead of server-converted PNGs.
 */
class BLP {
  private magic = BLP_MAGIC;
  private formatVersion = 1;
  private _colorFormat: BLP_COLOR_FORMAT = BLP_COLOR_FORMAT.COLOR_DXT;
  private alphaSize = 0;
  private preferredFormat: BLP_PIXEL_FORMAT = BLP_PIXEL_FORMAT.PIXEL_DXT5;
  private _width = 0;
  private _height = 0;
  private images: Uint8Array[] = [];
  private palette: Uint8Array;

  get colorFormat() {
    return this._colorFormat;
  }

  get width() {
    return this._width;
  }

  get height() {
    return this._height;
  }

  get mipLevelCount() {
    return this.images.length;
  }

  load(source: ArrayBuffer | Uint8Array): BLP {
    // restructure 0.5.0 reads scalars via Buffer methods (readUInt32LE and friends), so a plain
    // Uint8Array is not enough. Buffer.from over an existing view aliases its memory rather than
    // copying, which keeps mip subarrays pointing at the same bytes.
    const bytes =
      source instanceof Uint8Array
        ? Buffer.from(source.buffer, source.byteOffset, source.byteLength)
        : Buffer.from(source);
    const stream = new DecodeStream(bytes);
    const header = blpIo.header.decode(stream);

    if (header.magic !== BLP_MAGIC) {
      throw new Error(`Unsupported file format: ${header.magic}`);
    }

    if (header.formatVersion !== 1) {
      throw new Error(`Unsupported format version: ${header.formatVersion}`);
    }

    if (header.colorFormat >= BLP_COLOR_FORMAT.NUM_COLOR_FORMATS) {
      throw new Error(`Unsupported color format: ${header.colorFormat}`);
    }

    if (header.preferredFormat >= BLP_PIXEL_FORMAT.NUM_PIXEL_FORMATS) {
      throw new Error(`Unsupported pixel format: ${header.preferredFormat}`);
    }

    this.magic = header.magic;
    this.formatVersion = header.formatVersion;
    this._colorFormat = header.colorFormat;
    this.alphaSize = header.alphaSize;
    this.preferredFormat = header.preferredFormat;
    this._width = header.width;
    this._height = header.height;

    if (this._colorFormat === BLP_COLOR_FORMAT.COLOR_PAL) {
      this.palette = header.extended;
    }

    const mipOffsets = header.mipOffsets;
    const mipSizes = header.mipSizes;

    for (let level = 0; level < MAX_MIP_LEVELS; level++) {
      const offset = mipOffsets[level];
      const size = mipSizes[level];

      if (offset === 0 || size === 0) {
        break;
      }

      this.images[level] = bytes.subarray(offset, offset + size);
    }

    return this;
  }

  getImage(
    level: number = 0,
    outputFormat: BLP_IMAGE_FORMAT = BLP_IMAGE_FORMAT.IMAGE_UNSPECIFIED,
  ): BlpImage {
    if (level > this.images.length - 1) {
      throw new Error(`Requested level out of range: ${level} > ${this.images.length - 1}`);
    }

    if (outputFormat === BLP_IMAGE_FORMAT.IMAGE_UNSPECIFIED) {
      return this.getUnspecifiedImage(level);
    }

    switch (this._colorFormat) {
      case BLP_COLOR_FORMAT.COLOR_PAL:
        return this.getPalImage(level, outputFormat);

      case BLP_COLOR_FORMAT.COLOR_DXT:
        return this.getDxtImage(level, outputFormat);

      case BLP_COLOR_FORMAT.COLOR_RAW:
        return this.getRawImage(level, outputFormat);

      default:
        throw new Error(`Unsupported color format: ${this._colorFormat}`);
    }
  }

  getImages(
    startLevel: number = 0,
    outputFormat: BLP_IMAGE_FORMAT = BLP_IMAGE_FORMAT.IMAGE_UNSPECIFIED,
  ): BlpImage[] {
    if (startLevel > this.images.length - 1) {
      throw new Error(
        `Requested start level out of range: ${startLevel} > ${this.images.length - 1}`,
      );
    }

    const images: BlpImage[] = [];

    for (let level = startLevel; level < this.images.length; level++) {
      images.push(this.getImage(level, outputFormat));
    }

    return images;
  }

  /**
   * For a given mip level, return a BlpImage containing the unconverted image data. DXT levels are
   * left compressed so they can be handed straight to the GPU; palettized levels are only useful
   * decoded, so they come back as ABGR8888.
   */
  private getUnspecifiedImage(level: number): BlpImage {
    switch (this._colorFormat) {
      case BLP_COLOR_FORMAT.COLOR_PAL:
        return this.getPalImage(level, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);

      case BLP_COLOR_FORMAT.COLOR_DXT:
        switch (this.preferredFormat) {
          case BLP_PIXEL_FORMAT.PIXEL_DXT1:
            return this.getDxt1Image(level, BLP_IMAGE_FORMAT.IMAGE_DXT1);

          case BLP_PIXEL_FORMAT.PIXEL_DXT3:
            return this.getDxt3Image(level, BLP_IMAGE_FORMAT.IMAGE_DXT3);

          case BLP_PIXEL_FORMAT.PIXEL_DXT5:
            return this.getDxt5Image(level, BLP_IMAGE_FORMAT.IMAGE_DXT5);

          default:
            throw new Error(`Unsupported pixel format: ${this.preferredFormat}`);
        }

      case BLP_COLOR_FORMAT.COLOR_RAW:
        return this.getRawImage(level, BLP_IMAGE_FORMAT.IMAGE_ARGB8888);

      default:
        throw new Error(`Unsupported color format: ${this._colorFormat}`);
    }
  }

  private getDxtImage(level: number, outputFormat: BLP_IMAGE_FORMAT): BlpImage {
    switch (this.preferredFormat) {
      case BLP_PIXEL_FORMAT.PIXEL_DXT1:
        return this.getDxt1Image(level, outputFormat);

      case BLP_PIXEL_FORMAT.PIXEL_DXT3:
        return this.getDxt3Image(level, outputFormat);

      case BLP_PIXEL_FORMAT.PIXEL_DXT5:
        return this.getDxt5Image(level, outputFormat);

      default:
        throw new Error(`Unsupported pixel format: ${this.preferredFormat}`);
    }
  }

  private getDxt1Image(level: number, outputFormat: BLP_IMAGE_FORMAT): BlpImage {
    const width = getSizeAtMipLevel(this._width, level);
    const height = getSizeAtMipLevel(this._height, level);

    if (width === 0 || height === 0) {
      return new BlpImage(width, height, new Uint8Array(0), outputFormat);
    }

    const data = getResizedBytes(this.images[level], getDxt1Size(width, height));

    switch (outputFormat) {
      case BLP_IMAGE_FORMAT.IMAGE_DXT1:
        return new BlpImage(width, height, data, outputFormat);

      case BLP_IMAGE_FORMAT.IMAGE_ABGR8888:
        return new BlpImage(width, height, dxt1ToAbgr8888(width, height, data), outputFormat);

      default:
        throw new Error(`Unsupported output format: ${outputFormat}`);
    }
  }

  private getDxt3Image(level: number, outputFormat: BLP_IMAGE_FORMAT): BlpImage {
    const width = getSizeAtMipLevel(this._width, level);
    const height = getSizeAtMipLevel(this._height, level);

    if (width === 0 || height === 0) {
      return new BlpImage(width, height, new Uint8Array(0), outputFormat);
    }

    const data = getResizedBytes(this.images[level], getDxt3Size(width, height));

    switch (outputFormat) {
      case BLP_IMAGE_FORMAT.IMAGE_DXT3:
        return new BlpImage(width, height, data, outputFormat);

      case BLP_IMAGE_FORMAT.IMAGE_ABGR8888:
        return new BlpImage(width, height, dxt3ToAbgr8888(width, height, data), outputFormat);

      default:
        throw new Error(`Unsupported output format: ${outputFormat}`);
    }
  }

  private getDxt5Image(level: number, outputFormat: BLP_IMAGE_FORMAT): BlpImage {
    const width = getSizeAtMipLevel(this._width, level);
    const height = getSizeAtMipLevel(this._height, level);

    if (width === 0 || height === 0) {
      return new BlpImage(width, height, new Uint8Array(0), outputFormat);
    }

    const data = getResizedBytes(this.images[level], getDxt5Size(width, height));

    switch (outputFormat) {
      case BLP_IMAGE_FORMAT.IMAGE_DXT5:
        return new BlpImage(width, height, data, outputFormat);

      case BLP_IMAGE_FORMAT.IMAGE_ABGR8888:
        return new BlpImage(width, height, dxt5ToAbgr8888(width, height, data), outputFormat);

      default:
        throw new Error(`Unsupported output format: ${outputFormat}`);
    }
  }

  private getPalImage(level: number, outputFormat: BLP_IMAGE_FORMAT): BlpImage {
    const width = getSizeAtMipLevel(this._width, level);
    const height = getSizeAtMipLevel(this._height, level);
    const data = this.images[level];

    switch (outputFormat) {
      case BLP_IMAGE_FORMAT.IMAGE_ABGR8888:
        return new BlpImage(
          width,
          height,
          palToAbgr8888(width, height, data, this.palette, this.alphaSize),
          outputFormat,
        );

      default:
        throw new Error(`Unsupported output format: ${outputFormat}`);
    }
  }

  private getRawImage(level: number, outputFormat: BLP_IMAGE_FORMAT): BlpImage {
    const width = getSizeAtMipLevel(this._width, level);
    const height = getSizeAtMipLevel(this._height, level);
    const data = this.images[level];

    switch (outputFormat) {
      case BLP_IMAGE_FORMAT.IMAGE_ARGB8888:
        return new BlpImage(width, height, data, outputFormat);

      case BLP_IMAGE_FORMAT.IMAGE_ABGR8888:
        return new BlpImage(
          width,
          height,
          rawArgb8888ToAbgr8888(width, height, data),
          outputFormat,
        );

      default:
        throw new Error(`Unsupported output format: ${outputFormat}`);
    }
  }
}

export default BLP;
export { BlpImage, BLP_COLOR_FORMAT, BLP_IMAGE_FORMAT, BLP_PIXEL_FORMAT };
