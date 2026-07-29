const raw = (value: string) => {
  return (value.split('').reverse().join('') + '\u0000').slice(0, 4);
}


class Config {

  serverhost = window.location.hostname;
  authport = '3724'

  game = 'Wow ';
  build = 12340;
  version = '3.3.5';
  majorVersion: number;
  minorVersion: number;
  patchVersion: number;
  timezone = 0;

  locale = 'enUS';
  os = 'Mac';
  platform = 'x86';
  
  raw = {
      locale: raw(this.locale),
      os: raw(this.os),
      platform: raw(this.platform)
    }
  
  constructor() {
    // parsing versions
    [this.majorVersion, this.minorVersion, this.patchVersion] = this.version.split('.').map(function(bit) {
      return parseInt(bit, 10);
    });
  }

}


export default new Config();