import React from 'react';
import { render } from '@testing-library/react';

import App from './app';

// Renders the whole app shell, which transitively imports the engine — session, player, unit,
// M2Blueprint, collider-manager, three.js. That makes it a genuine smoke test: if any module in that
// chain throws at import time, this fails.
//
// It was skipped for a while on a diagnosis that turned out to be wrong. The symptom was
// "THREE.Mesh is not a constructor", and that was attributed to Jest resolving three's `exports` map
// differently from webpack under jsdom's export conditions. The real cause was much simpler: CRA's Jest
// `transform` catch-all was `^(?!.*\.(js|jsx|ts|tsx|css|json)$)`, which does not exclude `.cjs`. three
// r185's `exports.require` points at `three.cjs`, so `require('three')` was routed through the *static
// asset* transformer and came back as the string "three.cjs" rather than the module — hence every
// property on it, including Mesh, was undefined. Adding `mjs|cjs` to that exclusion list fixed it.
test('renders the app shell', () => {
  render(<App />);
});
