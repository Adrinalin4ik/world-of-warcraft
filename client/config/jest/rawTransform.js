'use strict';

// This is a custom Jest transformer turning shader-source imports (.glsl/.frag/.vert) into the raw
// file text, matching what webpack hands back for the same extensions (`type: 'asset/source'` in
// config/webpack.config.js). Without this, Jest's catch-all fileTransform.js takes over and stubs the
// import as just the file's basename -- fine for most assets, but the M2 shader assembly in
// game/pipeline/m2/material/index.ts inspects the actual text (looking for the
// `// GLSLIFY_COMMON_MAIN` marker and splicing chunks together), so a filename stub makes that
// assembly throw or silently produce garbage under test.
module.exports = {
  process(src) {
    // Jest 28 changed the transformer contract: process() must return { code }, not a bare string.
    // https://jestjs.io/docs/28.x/upgrading-to-jest28#transformer
    return { code: `module.exports = ${JSON.stringify(src)};` };
  },
  getCacheKey(src, filename) {
    return `${filename}:${src.length}`;
  },
};
