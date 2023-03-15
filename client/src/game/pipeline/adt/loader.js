import { DecodeStream } from 'restructure';
import ADT from '../../../wow-data-parser/adt';

import Loader from '../../net/loader';

const loader = new Loader();

export default function(path, wdtFlags) {
  return loader.load(path).then((raw) => {
    const buffer = new Buffer(new Uint8Array(raw));
    const stream = new DecodeStream(buffer);

    const data = new ADT(wdtFlags).decode(stream);
    return data;
  });
}
