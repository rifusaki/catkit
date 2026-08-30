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
 * This worker lists that folder, and for every .zip it hasn't already
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
 * 1. npm install -D wrangler
 * 2. npm install fflate   (pure-JS zip lib, Workers-compatible)
 * 3. Fill in wrangler.toml (see companion file) with your account details
 *    and a cron trigger, e.g. daily: "0 6 * * *"
 * 4. Set secrets (never hardcode credentials):
 *      wrangler secret put KOOFR_USER
 *      wrangler secret put KOOFR_PASS       # Koofr WebDAV app password,
 *                                            # not your main account password
 *      wrangler secret put TRIGGER_SECRET   # random string, for manual runs
 * 5. Set vars in wrangler.toml (not secret, just config):
 *      KOOFR_ZOTERO_URL = "https://app.koofr.net/dav/Koofr/zotero"
 *      KOOFR_FLAT_URL   = "https://app.koofr.net/dav/Koofr/zotero-flat"
 *    (adjust paths to match wherever your Zotero WebDAV folder actually is
 *    in your Koofr account -- check Zotero's sync preferences for the
 *    exact URL you gave it.)
 * 6. wrangler deploy
 *
 * TESTING
 * -------
 * Before trusting the cron, trigger it manually and watch the logs:
 *   curl "https://<your-worker>.workers.dev/?key=<TRIGGER_SECRET>"
 *   wrangler tail
 * Start with a KOOFR_ZOTERO_URL pointed at a folder with just one or two
 * attachments so you can verify a single file round-trips correctly
 * before letting it loose on your whole library.
 */

import { unzipSync } from 'fflate';

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get('key') !== env.TRIGGER_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }
    const log = [];
    await runSync(env, (msg) => log.push(msg));
    return new Response(log.join('\n') || 'No new items.\n', {
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};

async function runSync(env, log = console.log) {
  const authHeader = 'Basic ' + btoa(`${env.KOOFR_USER}:${env.KOOFR_PASS}`);
  const sourceBase = env.KOOFR_ZOTERO_URL.replace(/\/$/, '');
  const destBase = env.KOOFR_FLAT_URL.replace(/\/$/, '');

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
 *
 * This is a minimal, regex-based parser rather than a full XML parser,
 * since Workers don't ship DOMParser for XML. It looks for <D:href> or
 * <d:href> (or unprefixed <href>) tags, which is how every WebDAV server
 * reports children in a multistatus response. If Koofr's XML uses a
 * different namespace prefix, adjust the regex below.
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
  // MKCOL on an already-existing collection returns an error on most
  // servers -- that's fine, we just want it to exist afterward either way.
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
  // Keep it WebDAV-path-safe: strip characters that would otherwise need
  // their own escaping headaches, without mangling normal titles.
  return name.replace(/[\/\\]/g, '-').trim();
}
