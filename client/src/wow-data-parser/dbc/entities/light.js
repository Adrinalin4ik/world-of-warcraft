import * as r from 'restructure';

import { Vec3Float } from '../../types';
import Entity from '../entity';

export default Entity({
  id: r.uint32le,
  mapID: r.uint32le,
  position: Vec3Float,
  fallOffStart: r.floatle,
  fallOffEnd: r.floatle,
  // The eight LightParams slots, in the order Light.dbc actually stores them -- confirmed against
  // `LIGHT_PARAM` (constants.ts) and against a live map-571 record, where slot 0 and slot 2 share an
  // id (871) and slot 1 and slot 3 share a different one (648): a zone that authors no distinct storm
  // look still points both the standard and stormy slots at the same LightParams row. The previous
  // names for slots 2 and 3 -- `sunsetID` and `otherID` -- were positionally WRONG: slot 2 is the
  // STORMY params and slot 3 is stormy underwater. Anyone reaching for "the storm params" could not
  // find them, and anyone using `sunsetID` for a sunset effect would have been handed storm data.
  paramsStandard: r.uint32le,
  paramsUnderwater: r.uint32le,
  paramsStormy: r.uint32le,
  paramsStormyUnderwater: r.uint32le,
  paramsDeath: r.uint32le,
  // Previously `unknowns: new r.Reserved(r.uint32le, 3)` -- Reserved fields are skipped by
  // restructure's decoder (see restructure/src/Reserved.js: it advances the stream and returns
  // `undefined`), so their values were never readable. Read as plain fields instead so the debug
  // readout (diagnostic 1: "which LightParams slot are we actually reading?") can print all eight
  // Light.dbc slot ids, including the three reserved words -- a shifted field order would otherwise
  // be invisible. Nothing consumes these three for lighting (map 571's `reserved7` is non-zero, but
  // there is no documented sixth semantic slot, so this is treated as leftover/default data rather
  // than a real param); they are exposed for inspection only.
  reserved5: r.uint32le,
  reserved6: r.uint32le,
  reserved7: r.uint32le,
});
