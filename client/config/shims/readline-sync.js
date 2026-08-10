/**
 * A browser stand-in for `readline-sync`, which fengari's `ldblib` (Lua's `debug.debug()`) reads a
 * terminal line with.
 *
 * An EMPTY module is not enough: webpack hoists the `require` into `ldblib`'s factory, so
 * `readlineSync.setDefaultOptions(...)` runs the moment `lualib` is imported -- which is to say, the
 * moment the FrameXML runtime imports fengari at all. The real package cannot be bundled (it reads
 * `process.binding` at module scope), and there is no terminal here to read from anyway, so these are
 * the two calls that have to exist and answer plausibly.
 *
 * `debug.debug()` from Lua therefore returns immediately instead of prompting. No glue file calls it.
 */
exports.setDefaultOptions = function setDefaultOptions() {};

exports.prompt = function prompt() {
  return '';
};

exports.question = function question() {
  return '';
};
