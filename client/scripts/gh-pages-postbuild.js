'use strict';

// Post-build step for GitHub Pages. Run after `scripts/build.js`; see `yarn build:gh-pages`.
//
// GitHub Pages is a static file server with no rewrite rules, so a request for a client-side route
// -- `/world-of-warcraft/game`, or any reload/deep link that is not `index.html` -- has no file to
// match and returns a 404. Pages does serve a `404.html` for those, so copying `index.html` to
// `404.html` makes it hand back the app instead of an error page; the router then reads the URL and
// renders the right screen. This is the standard SPA-on-Pages arrangement.
//
// `.nojekyll` is deliberately NOT written here. It matters when publishing from a branch, where
// Pages runs Jekyll and drops paths beginning with an underscore. The workflow uploads a build
// artifact and deploys it directly (`actions/deploy-pages`), which never invokes Jekyll -- so the
// file would be cargo cult. If this repo ever switches back to branch-based publishing, add it.

const fs = require('fs');
const path = require('path');

const paths = require('../config/paths');

const indexHtml = path.join(paths.appBuild, 'index.html');
const notFoundHtml = path.join(paths.appBuild, '404.html');

if (!fs.existsSync(indexHtml)) {
  console.error(
    `gh-pages-postbuild: no index.html at ${indexHtml} -- run the build first (yarn build).`
  );
  process.exit(1);
}

fs.copyFileSync(indexHtml, notFoundHtml);

console.log(`gh-pages-postbuild: wrote ${path.relative(process.cwd(), notFoundHtml)} (SPA fallback)`);
