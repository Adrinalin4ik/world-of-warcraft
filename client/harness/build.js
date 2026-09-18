/**
 * Offline reproduction rig for the abbey's portal visibility -- NO browser, NO dev server, NO ADT.
 *
 * Why this exists: portal work on this project has now cost a round of screenshot-reading and six
 * reverted fixes. Every finding that survived came from the game's own bytes. This rig runs the
 * CLIENT'S OWN decoders, `WMORoot`, `WMOGroup`, `LocationManager` and `VisibilityManager` over the
 * real `nsabbey` files, in local WMO space with an identity placement, so a question about a
 * position is answered by the same code the browser runs.
 *
 * Files are the ones served to the client, fetched from the asset host into the scratchpad.
 */
const fs = require('fs');
const path = require('path');

const WMO_DIR = process.env.WMO_DIR;

const { DecodeStream } = require('restructure');
const WMOParser = require('../src/wow-data-parser/wmo').default;
const WMOGroupParser = require('../src/wow-data-parser/wmo/group').default;
const WMORootDefinition = require('../src/game/pipeline/wmo/root/loader/definition').default;
const WMOGroupDefinition = require('../src/game/pipeline/wmo/group/loader/definition').default;
const WMORoot = require('../src/game/pipeline/wmo/root').default;
const WMOGroup = require('../src/game/pipeline/wmo/group').default;

function decode(file, parser) {
  const raw = fs.readFileSync(path.join(WMO_DIR, file));
  return parser.decode(new DecodeStream(raw));
}

/** The real root plus every group the root declares, built through the client's own constructors. */
function buildAbbey() {
  // `WMORoot`'s constructor still carries a stray `console.log('WMOROOT', def)`. `def` holds the
  // building's whole geometry as typed arrays, and node's inspector walks it: printing one root took
  // this rig past a five-minute timeout. Silenced here rather than edited out of src, because the dev
  // server the owner is running recompiles on a src write.
  const quiet = console.log;
  console.log = () => {};
  try {
    return build();
  } finally {
    console.log = quiet;
  }
}

function build() {
  const rootDef = new WMORootDefinition('NSABBEY.WMO', decode('nsabbey.wmo', WMOParser));
  const root = new WMORoot(rootDef);

  const groups = new Map();
  for (let index = 0; index < root.groupCount; index++) {
    const suffix = `000${index}`.slice(-3);
    const file = `nsabbey_${suffix}.wmo`;
    const def = new WMOGroupDefinition(
      `NSABBEY_${suffix}.WMO`, index, root.header, decode(file, WMOGroupParser),
    );
    groups.set(index, new WMOGroup(root, def));
  }

  return { root, groups };
}

module.exports = { buildAbbey };
