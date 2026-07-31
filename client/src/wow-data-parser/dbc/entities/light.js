import * as r from 'restructure';

import { Vec3Float } from '../../types';
import Entity from '../entity';

export default Entity({
  id: r.uint32le,
  mapID: r.uint32le,
  position: Vec3Float,
  fallOffStart: r.floatle,
  fallOffEnd: r.floatle,
  skyFogID: r.uint32le,
  waterID: r.uint32le,
  sunsetID: r.uint32le,
  otherID: r.uint32le,
  deathID: r.uint32le,
  // Previously `unknowns: new r.Reserved(r.uint32le, 3)` -- Reserved fields are skipped by
  // restructure's decoder (see restructure/src/Reserved.js: it advances the stream and returns
  // `undefined`), so their values were never readable. Read as plain fields instead so the debug
  // readout (diagnostic 1: "which LightParams slot are we actually reading?") can print all eight
  // Light.dbc slot ids, including the three reserved words -- a shifted field order would otherwise
  // be invisible. Nothing consumes these three for lighting; they are exposed for inspection only.
  reserved5: r.uint32le,
  reserved6: r.uint32le,
  reserved7: r.uint32le,
});
