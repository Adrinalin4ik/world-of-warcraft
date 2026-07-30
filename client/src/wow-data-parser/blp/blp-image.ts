import { BLP_IMAGE_FORMAT } from './const';

class BlpImage {
  private _width: number;
  private _height: number;
  private _data: Uint8Array;
  private _format: BLP_IMAGE_FORMAT;

  constructor(width: number, height: number, data: Uint8Array, format: BLP_IMAGE_FORMAT) {
    this._width = width;
    this._height = height;
    this._data = data;
    this._format = format;
  }

  get width() {
    return this._width;
  }

  get height() {
    return this._height;
  }

  get data() {
    return this._data;
  }

  get format() {
    return this._format;
  }
}

export default BlpImage;
