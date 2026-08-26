// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom/extend-expect';

/**
 * `TextDecoder` -- jsdom's environment does not provide it, and the browser and Node both do.
 *
 * Not a shim for our code: `network/game/object/chat.ts` decodes a chat body as UTF-8 and
 * `protocol/wotlk/world-wire.ts` decodes a character name, and both run against the platform's own
 * decoder everywhere the app actually runs. Under the default `jsdom` test environment the global is
 * simply absent (a suite that declares `@jest-environment node` has it), so five suites failed at
 * IMPORT time on a module-scope construction. Taken from Node`s own `util` rather than hand-written,
 * so the tests decode through the same implementation the dev server does.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { TextDecoder, TextEncoder } = require('util');

if (global.TextDecoder === undefined) {
  global.TextDecoder = TextDecoder;
}
if (global.TextEncoder === undefined) {
  global.TextEncoder = TextEncoder;
}