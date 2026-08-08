/**
 * The one thing about `config` that a remote server silently enforces.
 *
 * With Warden enabled the world server rejects any account whose stored OS string is not exactly
 * `Win` or `OSX` (`WorldSocket::HandleAuthSessionCallback` -> AUTH_REJECT 0x0E). The string is
 * planted at LOGON and only read at the WORLD handshake, so a wrong value fails far from its cause,
 * with no client-side symptom and a correct-looking digest. It read `Mac` once and cost a long hunt.
 */
import config from '../config';

// The wire form is reversed and null-padded to four bytes -- `OSX` goes out as `XSO\0` -- so asserting
// the raw field is what proves the value the SERVER reconstructs, not just the one we typed here.
const unraw = (value: string) => value.replace(/\0/g, '').split('').reverse().join('');

it('sends an OS string the world server accepts', () => {
  expect(['Win', 'OSX']).toContain(unraw(config.raw.os));
});
