import React from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import App from './app';
import './index.scss';
import * as serviceWorker from './serviceWorker';
import './styles/ui/index.scss';

window['THREE'] = THREE;

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: https://bit.ly/CRA-PWA
serviceWorker.unregister();
