import BLP, { BLP_COLOR_FORMAT, BLP_IMAGE_FORMAT } from '../../../wow-data-parser/blp';

import Loader from '../../net/loader';

const loader = new Loader();

/**
 * Fetch and decode a BLP texture, off the main thread.
 *
 * Returns a spec rather than a texture because THREE objects cannot cross a worker boundary. DXT
 * levels come back still compressed so they can be handed straight to the GPU; everything else is
 * decoded to ABGR8888, whose bytes are in RGBA order and map to THREE.RGBAFormat.
 *
 * `decompress` overrides that for the one consumer that cannot use a compressed level: the character
 * body-texture bake (`ui/scene/body-composite.ts`) is a CPU source-over blit over 8-bit RGBA, so a
 * DXT level is not "already GPU-ready", it is unreadable. The decoder has always been able to do this
 * (`wow-data-parser/blp/dxt.ts`, wired into `getImages` for `IMAGE_ABGR8888`); nothing asked. It is a
 * per-request flag rather than a new loader so the two consumers share `Loader`'s HTTP cache -- the
 * same .blp fetched once, decoded two ways.
 */
export default function(path, decompress = false) {
  return loader.load(path).then((raw) => {
    const blp = new BLP().load(raw);

    // COLOR_RAW's native format is ARGB8888, which has no THREE equivalent, and palettized images
    // are only useful decoded. Ask for ABGR8888 for both; leave DXT alone so it stays compressed --
    // unless the caller says it is blitting on the CPU.
    const outputFormat = blp.colorFormat === BLP_COLOR_FORMAT.COLOR_DXT && !decompress
      ? BLP_IMAGE_FORMAT.IMAGE_UNSPECIFIED
      : BLP_IMAGE_FORMAT.IMAGE_ABGR8888;

    const images = blp.getImages(0, outputFormat);

    const mipmaps = [];
    const transferable = [];

    images.forEach((image) => {
      // Copy each level into its own tightly-fitted buffer. Mip data starts life as a view into the
      // whole downloaded file, and transferring that shared buffer would ship the entire .blp to the
      // main thread and leave every level aliasing it.
      const data = new Uint8Array(image.data);

      mipmaps.push({
        width: image.width,
        height: image.height,
        data: data
      });

      transferable.push(data.buffer);
    });

    return {
      width: blp.width,
      height: blp.height,
      format: images[0].format,
      mipmaps: mipmaps,
      transferable: transferable
    };
  });
}
