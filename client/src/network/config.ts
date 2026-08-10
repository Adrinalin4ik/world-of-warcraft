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
  // Exactly `Win` or `OSX` -- no other value works, and the failure is remote and silent.
  //
  // The logon server stores this string on the account row; the WORLD server then checks it, and
  // with Warden enabled rejects anything else outright: `if (wardenActive && account.OS != "Win" &&
  // account.OS != "OSX")` -> SMSG_AUTH_RESPONSE 0x0E AUTH_REJECT (AzerothCore/TrinityCore
  // WorldSocket::HandleAuthSessionCallback). This read `Mac` -- which is not what the real 3.3.5a
  // Mac client sends -- and cost a long hunt, because the rejection arrives at the world handshake
  // with no diagnostic while the fault was planted one server and one connection earlier. The
  // handshake itself was correct the whole time; it never got as far as the digest.
  os = 'OSX';
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