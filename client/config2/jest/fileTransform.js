'use strict';

const path = require('path');

// camelcase became ESM-only in v7, and this file is loaded by Jest with require(). That threw
// ERR_REQUIRE_ESM while the transformer module was still loading, which killed every test suite in the
// project before a single test ran. It was only ever used to name SVG mock components, so a local
// helper removes the dependency rather than pinning the package back.
const pascalCase = (name) =>
  name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');

// This is a custom Jest transformer turning file imports into filenames.
// http://facebook.github.io/jest/docs/en/webpack.html

module.exports = {
  process(src, filename) {
    const assetFilename = JSON.stringify(path.basename(filename));

    if (filename.match(/\.svg$/)) {
      // Based on how SVGR generates a component name:
      // https://github.com/smooth-code/svgr/blob/01b194cf967347d43d4cbe6b434404731b87cf27/packages/core/src/state.js#L6
      const pascalCaseFilename = pascalCase(path.parse(filename).name);
      const componentName = `Svg${pascalCaseFilename}`;
      // Jest 28 changed the transformer contract: process() must return { code }, not a bare string.
      // https://jestjs.io/docs/28.x/upgrading-to-jest28#transformer
      return { code: `const React = require('react');
      module.exports = {
        __esModule: true,
        default: ${assetFilename},
        ReactComponent: React.forwardRef(function ${componentName}(props, ref) {
          return {
            $$typeof: Symbol.for('react.element'),
            type: 'svg',
            ref: ref,
            key: null,
            props: Object.assign({}, props, {
              children: ${assetFilename}
            })
          };
        }),
      };` };
    }

    return { code: `module.exports = ${assetFilename};` };
  },
};
