/**
 * Zotero WebDAV -> flat-files bridge, for Koofr.
 *
 * WHAT THIS DOES
 * ---------------
 * Zotero's WebDAV file sync stores every attachment as a pair of files,
 * flat inside your WebDAV "zotero" folder:
 *   <itemKey>.zip    <- the actual attachment, zipped, with its ONE entry
 *                       named as the base64 of the original filename
 *   <itemKey>.prop    <- small XML with mtime/hash metadata (unused here)
 *
 * This script lists that folder, and for every .zip it hasn't already
 * processed, downloads it, unzips the single entry, base64-decodes the
 * entry name back into a real filename (e.g. "Smith 2019 - Some Paper.pdf"),
 * and PUTs the plain file into a separate flat destination folder on the
 * same Koofr account. Point any ordinary WebDAV/file browser (including
 * ones that run fine on old iOS) at the destination folder and you get
 * normal, readable files -- no Zotero client, no zip-diving required.
 *
 * IMPORTANT CAVEATS -- read before relying on this
 * -------------------------------------------------
 * - This has NOT been tested against Koofr's actual WebDAV server. Koofr's
 *   PROPFIND response format is assumed to be standard WebDAV multistatus
 *   XML; the regex-based parser below may need adjusting if Koofr's exact
 *   response shape differs. Test manually first (see "Testing" below).
 * - It only handles the common case: one file inside the zip. Zotero can
 *   in rare cases zip multiple files (e.g. HTML snapshots with resources);
 *   this script extracts the first entry and logs a warning if there's
 *   more than one, rather than silently dropping data.
 * - It marks processed items with a small marker file rather than
 *   re-diffing everything on every run, to keep it cheap to run often.
 *   If you ever re-run a full library, you can safely delete the
 *   ".processed" folder to force a full re-sync.
 * - This is one-directional (Zotero storage -> flat folder). It won't
 *   delete flat-folder files if you delete something from Zotero.
 *
 * SETUP
 * -----
 * 1. npm install fflate
 * 2. Set environment variables (e.g. in a .env file, or export them):
 *      KOOFR_USER       - your Koofr WebDAV username (usually your email)
 *      KOOFR_PASS       - a Koofr WebDAV app password (Koofr account settings
 *                         -> WebDAV -> generate one; don't use your main password)
 *      KOOFR_ZOTERO_URL - e.g. "https://app.koofr.net/dav/Koofr/zotero"
 *      KOOFR_FLAT_URL   - e.g. "https://app.koofr.net/dav/Koofr/zotero-flat"
 * 3. Run:  node zotero-koofr-flatten-worker.js
 * 4. To run on a schedule, add a cron entry:
 *      0 6 * * *  KOOFR_USER=you@example.com KOOFR_PASS=... KOOFR_ZOTERO_URL=... KOOFR_FLAT_URL=... node /path/to/zotero-koofr-flatten-worker.js
 *
 * TESTING
 * -------
 * Start with KOOFR_ZOTERO_URL pointed at a folder with just one or two
 * attachments so you can verify a single file round-trips correctly
 * before letting it loose on your whole library.
 */

const { unzipSync } = require('fflate');

async function runSync(log = console.log) {
  const KOOFR_USER = process.env.KOOFR_USER;
  const KOOFR_PASS = process.env.KOOFR_PASS;
  const KOOFR_ZOTERO_URL = process.env.KOOFR_ZOTERO_URL;
  const KOOFR_FLAT_URL = process.env.KOOFR_FLAT_URL;

  if (!KOOFR_USER || !KOOFR_PASS || !KOOFR_ZOTERO_URL || !KOOFR_FLAT_URL) {
    throw new Error('Missing required env vars: KOOFR_USER, KOOFR_PASS, KOOFR_ZOTERO_URL, KOOFR_FLAT_URL');
  }

  const authHeader = 'Basic ' + Buffer.from(`${KOOFR_USER}:${KOOFR_PASS}`).toString('base64');
  const sourceBase = KOOFR_ZOTERO_URL.replace(/\/$/, '');
  const destBase = KOOFR_FLAT_URL.replace(/\/$/, '');

  await ensureCollection(`${destBase}`, authHeader);
  await ensureCollection(`${destBase}/.processed`, authHeader);

  const names = await listWebDavFiles(sourceBase, authHeader);
  const zipNames = names.filter((n) => n.toLowerCase().endsWith('.zip'));

  log(`Found ${zipNames.length} .zip attachment(s) in source folder.`);

  let processed = 0;
  for (const zipName of zipNames) {
    const key = zipName.replace(/\.zip$/i, '');
    const markerUrl = `${destBase}/.processed/${encodeURIComponent(key)}.done`;

    if (await exists(markerUrl, authHeader)) continue;

    try {
      const zipResp = await fetch(`${sourceBase}/${encodeURIComponent(zipName)}`, {
        headers: { Authorization: authHeader },
      });
      if (!zipResp.ok) {
        log(`  SKIP ${zipName}: download failed (${zipResp.status})`);
        continue;
      }

      const zipBuf = new Uint8Array(await zipResp.arrayBuffer());
      const unzipped = unzipSync(zipBuf);
      const entryNames = Object.keys(unzipped);

      if (entryNames.length === 0) {
        log(`  SKIP ${zipName}: zip was empty`);
        continue;
      }
      if (entryNames.length > 1) {
        log(`  WARN ${zipName}: ${entryNames.length} entries inside, using the first -- check this one manually`);
      }

      const encodedName = entryNames[0];
      const realName = decodeBase64Filename(encodedName) || encodedName;
      const fileBytes = unzipped[encodedName];

      const destUrl = `${destBase}/${encodeURIComponent(sanitizeFilename(realName))}`;
      const putResp = await fetch(destUrl, {
        method: 'PUT',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/octet-stream',
        },
        body: fileBytes,
      });

      if (!putResp.ok) {
        log(`  FAIL ${zipName} -> ${realName}: upload failed (${putResp.status})`);
        continue;
      }

      await fetch(markerUrl, {
        method: 'PUT',
        headers: { Authorization: authHeader },
        body: key,
      });

      log(`  OK   ${zipName} -> ${realName}`);
      processed++;
    } catch (err) {
      log(`  ERROR ${zipName}: ${err.message}`);
    }
  }

  log(`Done. Newly processed: ${processed}/${zipNames.length}.`);
}

/**
 * PROPFIND the given WebDAV collection (Depth: 1) and return the file
 * names (not full paths) of its immediate children.
 */
async function listWebDavFiles(collectionUrl, authHeader) {
  const resp = await fetch(collectionUrl, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader,
      Depth: '1',
      'Content-Type': 'application/xml',
    },
    body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`,
  });

  if (!resp.ok) {
    throw new Error(`PROPFIND ${collectionUrl} failed: ${resp.status}`);
  }

  const xml = await resp.text();
  const hrefRegex = /<(?:[a-zA-Z0-9]+:)?href>([^<]+)<\/(?:[a-zA-Z0-9]+:)?href>/g;
  const hrefs = [...xml.matchAll(hrefRegex)].map((m) => decodeURIComponent(m[1]));

  const collectionPath = new URL(collectionUrl).pathname.replace(/\/$/, '');

  return hrefs
    .map((h) => (h.startsWith('http') ? new URL(h).pathname : h))
    .filter((path) => path.replace(/\/$/, '') !== collectionPath) // drop self-entry
    .map((path) => path.replace(/\/$/, '').split('/').pop())
    .filter(Boolean);
}

async function exists(url, authHeader) {
  const resp = await fetch(url, { method: 'HEAD', headers: { Authorization: authHeader } });
  return resp.ok;
}

async function ensureCollection(url, authHeader) {
  try {
    await fetch(url, { method: 'MKCOL', headers: { Authorization: authHeader } });
  } catch {
    /* ignore */
  }
}

/**
 * The zip entry name is the original filename, base64-encoded (this is
 * documented by Zotero's own devs on the forums, and is in storage.js).
 * atob() gives us a binary string; the extra decodeURIComponent/escape
 * dance re-interprets that binary string as UTF-8, since filenames can
 * contain non-ASCII characters.
 */
function decodeBase64Filename(encoded) {
  try {
    const binary = atob(encoded);
    return decodeURIComponent(escape(binary));
  } catch {
    return null;
  }
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\]/g, '-').trim();
}

// --- entry point ---
runSync()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
