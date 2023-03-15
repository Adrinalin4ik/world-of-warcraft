import ffi from 'ffi-napi';
import ref from 'ref-napi';

const { bool, uint8, uint32 } = ref.types;
const voidPtr = ref.refType(ref.types.void);

const BLP = voidPtr;
const FILE = voidPtr;

const lib = new ffi.Library('libblp', {
  blp_convert:     [voidPtr, [FILE, BLP, uint8]],
  blp_height:      [uint32, [BLP, uint8]],
  blp_nbMipLevels: [uint32, [BLP]],
  blp_processFile: [BLP, [FILE]],
  blp_release:     [bool, [BLP]],
  blp_version:     [uint8, [BLP]],
  blp_width:       [uint32, [BLP, uint8]]
});

export default lib;
