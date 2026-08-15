import React from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import App from './app';
import installAssetCache from './game/net/asset-cache-install';
import './index.scss';
import * as serviceWorker from './serviceWorker';
import './styles/ui/index.scss';

window['THREE'] = THREE;

// Persistent asset cache. Requests persistent storage and publishes `window.assetCache`; the store
// itself is consulted from `game/net/loader.js`, the one place every asset URL is built.
//
// Installed before the app renders because the first assets are requested during the first render,
// and a `persist()` that lands after them would leave that batch evictable.
installAssetCache();

// three r152 turned colour management on by default and switched the renderer's output to sRGB. Every
// shader, every light-database colour and every DXT texture in this client was authored and tuned
// against r150's behaviour -- colour management off, linear output -- so both are pinned back to it
// here and in the renderer setup (see pages/game/index.tsx).
//
// Adopting managed colour would change the appearance of the entire game: Color.setHex would convert
// sRGB to linear, and the renderer would convert linear to sRGB on the way out, so the fog colours,
// water tints and sun bands read out of Light.dbc would all shift. That is a deliberate visual project
// with its own before/after pass, not a side effect of a dependency upgrade.
//
// Set before anything constructs a Color, because the flag is read at construction time.
THREE.ColorManagement.enabled = false;

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}

// Stays UNREGISTERED, and now deliberately rather than by CRA default. Asset persistence is handled
// by the store in `game/net/asset-cache.ts`, which is consulted from ONE place -- `net/loader.js`,
// the single path that builds an asset URL. A service worker would instead sit in front of EVERY
// request the page makes, including the dev server's hot-reload channel and the game connection, so
// getting its scope wrong breaks things that have nothing to do with assets. Nothing needs it:
// `workbox-webpack-plugin` is still in `package.json` and is still unused.
serviceWorker.unregister();

window['safePrintTimer'] = null;
window['safePrint'] = function(...log) {
  if (window['safePrintTimer'] === null) {
    window['safePrintTimer'] = setTimeout(() => {
      console.log(...log);
      window['safePrintTimer'] = null;
    }, 1000)
  }
}