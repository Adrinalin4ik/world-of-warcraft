class Raw {
  constructor(config) {
    this.config = config;
  }

  raw(value) {
    return (value.split('').reverse().join('') + '\u0000').slice(0, 4);
  }

  get locale() {
    return this.raw(this.config.locale);
  }

  get os() {
    return this.raw(this.config.os);
  }

  get platform() {
    return this.raw(this.config.platform);
  }

}

class Config {

  constructor() {
    this.game = 'Wow ';
    this.build = 12340;
    this.version = '3.3.5';
    this.timezone = 0;

    this.locale = 'enUS';
    this.os = 'Mac';
    this.platform = 'x86';

    this.raw = new Raw(this);

    const CustomDef = require('../conf.js.dist');
    Object.assign(this, CustomDef);
    const Custom = require('./conf.js');
    Object.assign(this, Custom);

  }

  set version(version) {
    [
      this.majorVersion,
      this.minorVersion,
      this.patchVersion
    ] = version.split('.').map(function(bit) {
      return parseInt(bit, 10);
    });
  }

}

export default Config;
