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
 * entry name back into a filename. That decoded name is whatever the file
 * was ORIGINALLY called (e.g. "1-s2.0-S0092867420310783-main.pdf" straight
 * off a publisher site) -- it is NOT derived from Zotero's title/author/year
 * metadata, because that metadata was never in WebDAV storage to begin with.
 * It lives only in Zotero's own database, synced separately via zotero.org.
 *
 * To get useful names, this script additionally calls the Zotero Web API
 * (api.zotero.org) for each attachment key, walks up to its parent
 * bibliographic item, and builds a "LastName YYYY - Title.ext" filename from
 * real metadata. This works precisely because the API's *metadata* sync is
 * separate from *file* sync -- it's populated regardless of whether you use
 * WebDAV or Zotero's own storage for the actual bytes, so it's available to
 * us even though the files themselves aren't reachable through the API.
 * If the API lookup fails for any reason (rate limit, top-level attachment
 * with no parent, missing API credentials, network hiccup), it falls back
 * to the original filename rather than skipping the file.
 *
 * The result is PUT into a separate flat destination folder on the same
 * Koofr account. Point any ordinary WebDAV/file browser (including ones
 * that run fine on old iOS) at the destination folder and you get normal,
 * readable, sensibly-named files -- no Zotero client, no zip-diving required.
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
 * - IMPORTANT if you're updating an already-running deployment: items you've
 *   already imported are marked done under ".processed/" and will be
 *   SKIPPED, so they will NOT be retroactively renamed just by adding the
 *   Zotero API credentials below. To rename existing files, delete the
 *   corresponding marker(s) under ".processed/" (or the whole folder, to
 *   reprocess -- and re-rename -- everything) before the next run. This
 *   will re-upload/rename but won't remove the old, oddly-named copies
 *   already sitting in the flat folder -- clean those up by hand if wanted.
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
 *      ZOTERO_API_KEY   - (optional, but wanted for real filenames)
 *                         zotero.org/settings/keys -> create a private key,
 *                         read-only library access is enough
 *      ZOTERO_USER_ID   - (optional, required alongside ZOTERO_API_KEY)
 *                         your numeric userID, shown on the same settings
 *                         page (this is NOT your Zotero username/email)
 *      ZOTERO_LIBRARY_PREFIX - (optional) only set this if your attachments
 *                         live in a GROUP library instead of your personal
 *                         one, e.g. "groups/1234567". Overrides the default
 *                         "users/<ZOTERO_USER_ID>" prefix.
 *    If ZOTERO_API_KEY/ZOTERO_USER_ID are left unset, the script behaves
 *    exactly as before: files land under their original filename.
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
  const ZOTERO_API_KEY = process.env.ZOTERO_API_KEY;
  const ZOTERO_USER_ID = process.env.ZOTERO_USER_ID;
  const ZOTERO_LIBRARY_PREFIX =
    process.env.ZOTERO_LIBRARY_PREFIX ||
    (ZOTERO_USER_ID ? `users/${ZOTERO_USER_ID}` : null);

  if (!KOOFR_USER || !KOOFR_PASS || !KOOFR_ZOTERO_URL || !KOOFR_FLAT_URL) {
    throw new Error('Missing required env vars: KOOFR_USER, KOOFR_PASS, KOOFR_ZOTERO_URL, KOOFR_FLAT_URL');
  }
  if (!ZOTERO_API_KEY || !ZOTERO_LIBRARY_PREFIX) {
    log('(ZOTERO_API_KEY/ZOTERO_USER_ID not set -- files will keep their original filenames)');
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
      const originalName = decodeBase64Filename(encodedName) || encodedName;
      const fileBytes = unzipped[encodedName];
      const ext = (originalName.match(/\.[a-zA-Z0-9]+$/) || [''])[0];

      let uploadName = originalName;
      const niceTitle = await fetchNiceFilename(key, { apiKey: ZOTERO_API_KEY, libraryPrefix: ZOTERO_LIBRARY_PREFIX }, log);
      if (niceTitle) {
        uploadName = `${niceTitle}${ext}`;
      }

      const destUrl = `${destBase}/${encodeURIComponent(sanitizeFilename(uploadName))}`;
      const putResp = await fetch(destUrl, {
        method: 'PUT',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/octet-stream',
        },
        body: fileBytes,
      });

      if (!putResp.ok) {
        log(`  FAIL ${zipName} -> ${uploadName}: upload failed (${putResp.status})`);
        continue;
      }

      await fetch(markerUrl, {
        method: 'PUT',
        headers: { Authorization: authHeader },
        body: key,
      });

      log(`  OK   ${zipName} -> ${uploadName}`);
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
 * Look up an attachment's parent bibliographic item via the Zotero Web API
 * and build a "LastName YYYY - Title" filename (no extension) from real
 * metadata. Returns null on any failure -- including missing credentials --
 * so the caller falls back to the attachment's original filename instead of
 * losing the file.
 *
 * Chain: WebDAV .zip name == attachment item's own key. The attachment
 * item's `data.parentItem` points at the actual bibliographic item (the
 * journalArticle/book/etc. with the title and authors). Top-level
 * attachments (rare) have no parentItem -- we just use the attachment's
 * own title in that case.
 */
async function fetchNiceFilename(attachmentKey, { apiKey, libraryPrefix }, log) {
  if (!apiKey || !libraryPrefix) return null;

  const apiBase = `https://api.zotero.org/${libraryPrefix}`;
  const headers = { 'Zotero-API-Key': apiKey };

  try {
    const attResp = await fetch(`${apiBase}/items/${attachmentKey}?format=json`, { headers });
    if (!attResp.ok) {
      log(`    (metadata lookup skipped: attachment ${attachmentKey} -> ${attResp.status})`);
      return null;
    }
    const attJson = await attResp.json();
    const parentKey = attJson.data?.parentItem;

    let meta = attJson.data;
    if (parentKey) {
      const parentResp = await fetch(`${apiBase}/items/${parentKey}?format=json`, { headers });
      if (!parentResp.ok) {
        log(`    (metadata lookup skipped: parent ${parentKey} -> ${parentResp.status})`);
        return null;
      }
      meta = (await parentResp.json()).data;
    }

    return buildCitationName(meta);
  } catch (err) {
    log(`    (metadata lookup error for ${attachmentKey}: ${err.message})`);
    return null;
  }
}

/**
 * "LastName YYYY - Title", truncated so the total filename stays reasonable.
 * Falls back gracefully piece by piece if creators/date/title are missing.
 */
function buildCitationName(meta) {
  if (!meta) return null;

  const year = (meta.date || '').match(/\d{4}/)?.[0];
  const firstCreator = (meta.creators || [])[0];
  const author = firstCreator
    ? firstCreator.lastName || firstCreator.name || ''
    : '';
  const title = (meta.title || '').trim();

  if (!author && !title) return null;

  const authorYear = [author, year].filter(Boolean).join(' ');
  const full = [authorYear, title].filter(Boolean).join(' - ');

  return full.slice(0, 150).trim();
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