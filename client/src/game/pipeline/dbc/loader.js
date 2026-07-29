import { DecodeStream } from 'restructure';
import * as DBC from '../../../wow-data-parser/dbc/entities';

import Loader from '../../net/loader';

const loader = new Loader();

export default function(name) {
  const path = `DBFilesClient\\${name}.dbc`;
  const entity = DBC[name];

  return loader.load(path).then((raw) => {
    const buffer = new Buffer(new Uint8Array(raw));
    const stream = new DecodeStream(buffer);

    const data = entity.default.dbc.decode(stream);
    // TODO: This property breaks web worker communication for some reason!
    delete data.entity;
    return data;
  });
}
