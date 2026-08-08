'use strict';

// This is a custom Jest transformer turning style imports into empty objects.
// http://facebook.github.io/jest/docs/en/webpack.html

module.exports = {
  process() {
    // Jest 28 changed the transformer contract: process() must return { code }, not a bare string.
    // https://jestjs.io/docs/28.x/upgrading-to-jest28#transformer
    return { code: 'module.exports = {};' };
  },
  getCacheKey() {
    // The output is always the same.
    return 'cssTransform';
  },
};
