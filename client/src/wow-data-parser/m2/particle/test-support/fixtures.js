const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_URI = process.env.REACT_APP_DATA_URI || 'https://data-direct.spelunkerdb.com/12340';
const CACHE_DIR = path.join(__dirname, '.fixture-cache');

const normalize = (assetPath) => assetPath.trim().toLowerCase().replace(/\\/g, '/');

const download = (url) => new Promise((resolve) => {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      resolve(null);
      return;
    }

    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks)));
  }).on('error', () => resolve(null));
});

/**
 * Fetch a game asset for use as a test fixture, caching it on disk.
 *
 * Returns null when the asset host cannot be reached, so that an offline checkout skips the
 * fixture-backed assertions rather than failing them.
 */
const fetchFixture = async (assetPath) => {
  const normalized = normalize(assetPath);
  const cached = path.join(CACHE_DIR, normalized.replace(/\//g, '_'));

  if (fs.existsSync(cached)) {
    return fs.readFileSync(cached);
  }

  const buffer = await download(`${DATA_URI}/${normalized}`);

  if (!buffer) {
    return null;
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cached, buffer);

  return buffer;
};

module.exports = { fetchFixture, DATA_URI };
