// Local stand-in for Google Sheets + Apps Script, for testing without a Google account.
// Runs apps-script/Code.gs unchanged against in-memory "tabs" and serves the website.
//
//   node tools/emulator.mjs            → site on http://localhost:8787, API on http://localhost:8788/exec
//   STATE=/tmp/seva.json node tools/emulator.mjs   (keeps data between runs)
//
// Only what Code.gs uses is implemented. Not used in production.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_PORT = +(process.env.SITE_PORT || 8787), API_PORT = +(process.env.API_PORT || 8788);
const STATE = process.env.STATE || '';
const PHOTOS = process.env.PHOTOS || path.join(ROOT, 'tools/.emulator-photos');
fs.mkdirSync(PHOTOS, { recursive: true });

/* ---------- Sheets ---------- */
const tabs = new Map();   // name → { rows: string[][], maxRows }
if (STATE && fs.existsSync(STATE)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(STATE, 'utf8')).tabs || {})) tabs.set(k, v);
const props = new Map(STATE && fs.existsSync(STATE) ? Object.entries(JSON.parse(fs.readFileSync(STATE, 'utf8')).props || {}) : []);
const save = () => { if (STATE) fs.writeFileSync(STATE, JSON.stringify({ tabs: Object.fromEntries(tabs), props: Object.fromEntries(props) })); };

function Sheet(name) {
  const t = tabs.get(name);
  const lastRow = () => { for (let i = t.rows.length - 1; i >= 0; i--) if (t.rows[i] && t.rows[i].some((c) => c !== '' && c != null)) return i + 1; return 0; };
  const sheet = {
    getName: () => name,
    getLastRow: lastRow,
    getLastColumn: () => t.rows.reduce((m, r) => Math.max(m, r ? r.reduce((n, c, i) => (c !== '' && c != null ? i + 1 : n), 0) : 0), 0),
    getMaxRows: () => t.maxRows,
    insertRowsAfter: (_, n) => { t.maxRows += n; },
    setFrozenRows: () => {},
    deleteRow: (r) => { t.rows.splice(r - 1, 1); t.maxRows--; },
    clearContents: () => { t.rows = []; },
    getRange: (row, col, nr = 1, nc = 1) => {
      if (typeof row === 'string') return Range(t, 1, 1, 0, 0);   // A1 notation: only used for formatting
      return Range(t, row, col, nr, nc);
    },
  };
  return sheet;
}
function Range(t, row, col, nr, nc) {
  const r = {
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
      const v = (t.rows[row - 1 + i] || [])[col - 1 + j];
      return v == null ? '' : v;
    })),
    setValues: (vals) => {
      vals.forEach((rv, i) => {
        const ri = row - 1 + i;
        while (t.rows.length <= ri) t.rows.push([]);
        rv.forEach((v, j) => { t.rows[ri][col - 1 + j] = v; });
      });
      if (row - 1 + vals.length > t.maxRows) t.maxRows = row - 1 + vals.length;
      return r;
    },
    setNumberFormat: () => r, setFontWeight: () => r, setDataValidation: () => r, setNote: () => r,
  };
  return r;
}
const ss = {
  getId: () => 'sheet1', getName: () => 'ABS Seva',
  getSheetByName: (n) => (tabs.has(n) ? Sheet(n) : null),
  insertSheet: (n) => { tabs.set(n, { rows: [], maxRows: 1000 }); return Sheet(n); },
};
const SpreadsheetApp = {
  getActiveSpreadsheet: () => ss, getActive: () => ss, flush: () => save(),
  newDataValidation: () => { const b = { requireValueInList: () => b, setAllowInvalid: () => b, build: () => ({}) }; return b; },
  getUi: () => { throw new Error('no UI in the emulator'); },
};

/* ---------- other Google services ---------- */
const cache = new Map();
const pad = (n) => String(n).padStart(2, '0');
const Utilities = {
  formatDate: (d, tz, fmt) => {
    const x = new Date(d.getTime() + (tz === 'Asia/Kolkata' ? 330 * 60e3 : 0));
    const p = { yyyy: x.getUTCFullYear(), MM: pad(x.getUTCMonth() + 1), dd: pad(x.getUTCDate()), HH: pad(x.getUTCHours()), mm: pad(x.getUTCMinutes()), ss: pad(x.getUTCSeconds()) };
    return fmt.replace(/yyyy|MM|dd|HH|mm|ss/g, (k) => p[k]);
  },
  getUuid: () => crypto.randomUUID(),
  sleep: () => {},
  base64EncodeWebSafe: (v) => Buffer.from(typeof v === 'string' ? v : Uint8Array.from(v, (b) => b & 255)).toString('base64url'),
  base64DecodeWebSafe: (s) => [...Buffer.from(s, 'base64url')],
  base64Decode: (s) => [...Buffer.from(s, 'base64')],
  computeHmacSha256Signature: (v, key) => [...crypto.createHmac('sha256', key).update(v).digest()],
  newBlob: (bytes, type, name) => {
    const buf = Buffer.from(Uint8Array.from(bytes, (b) => b & 255));
    const blob = { getDataAsString: () => buf.toString('utf8'), getBytes: () => [...buf], getContentType: () => type, getName: () => name, setName: (n) => { name = n; return blob; }, _buf: buf };
    return blob;
  },
};
const files = new Map();
const folders = new Map();
function folder(id) {
  return { getId: () => id, isTrashed: () => false,
    getFoldersByName: (n) => { const hit = [...folders].find(([, v]) => v.parent === id && v.name === n); let used = false; return { hasNext: () => !!hit && !used, next: () => { used = true; return folder(hit[0]); } }; },
    createFolder: (n) => { const fid = 'd' + crypto.randomBytes(4).toString('hex'); folders.set(fid, { name: n, parent: id }); return folder(fid); },
    getFiles: () => ({ hasNext: () => false }),
    createFile: (blob) => {
    const fid = 'f' + crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(path.join(PHOTOS, fid), blob._buf);
    files.set(fid, { type: blob.getContentType() });
    return { getId: () => fid, setSharing: () => {}, setTrashed: () => { try { fs.unlinkSync(path.join(PHOTOS, fid)); } catch (e) {} } };
  } };
}
const DriveApp = {
  Access: { ANYONE_WITH_LINK: 'A' }, Permission: { VIEW: 'V' },
  getFolderById: (id) => folder(id),
  getFileById: (fid) => ({ moveTo: () => {}, makeCopy: () => {}, setTrashed: () => { try { fs.unlinkSync(path.join(PHOTOS, fid)); } catch (e) {} } }),
};
const sandbox = {
  console, Date, JSON, Math, Object, Array, String, Number, RegExp, Error, isNaN,
  SpreadsheetApp, Utilities, DriveApp,
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, String(v)),
    setProperties: (o) => Object.entries(o).forEach(([k, v]) => props.set(k, String(v))), getProperties: () => Object.fromEntries(props) }) },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => 503, getContentText: () => '' }) },   // offline: translation falls back
  LanguageApp: { translate: () => { throw new Error('offline'); } },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ content: s, setMimeType() { return this; } }) },
  ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => { const b = { timeBased: () => b, everyMinutes: () => b, everyDays: () => b, atHour: () => b, after: () => b, create: () => ({}) }; return b; } },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps-script/Code.gs'), 'utf8') + '\n;globalThis.__api = { doGet, doPost, setup, refreshReadable };', sandbox, { filename: 'Code.gs' });
const api = sandbox.__api;
if (!tabs.has('Volunteers')) console.log(api.setup());
// ADMIN_PASS=... sets a known password for the first admin (for tests)
if (process.env.ADMIN_PASS) { const a = tabs.get('Admins'); if (!/^hash:/.test(a.rows[1][1] || '')) a.rows[1][1] = process.env.ADMIN_PASS; }
export function admins() { return tabs.get('Admins').rows; }

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.binarypb': 'application/octet-stream', '.data': 'application/octet-stream' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let file = path.join(ROOT, 'docs', decodeURIComponent(u.pathname));
  if (u.pathname.startsWith('/photos/')) {   // stand-in for Drive's public photo links
    file = path.join(PHOTOS, path.basename(u.pathname));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(fs.readFileSync(file));
  }
  if (u.pathname === '/config.js') {   // point the site at the emulated Apps Script URL
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(`window.SEVA_API = 'http://${req.headers.host.split(':')[0]}:${API_PORT}/exec'; window.SEVA_PHOTO_URL = '/photos/{id}';`);
  }
  if (!file.startsWith(path.join(ROOT, 'docs') + path.sep) && file !== path.join(ROOT, 'docs')) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
}).listen(SITE_PORT, '127.0.0.1');

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') { res.writeHead(405, cors); return res.end(); }   // Apps Script has no preflight: the site must not trigger one
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const e = { parameter: Object.fromEntries(u.searchParams), postData: req.method === 'POST' ? { contents: body } : undefined };
    const out = req.method === 'POST' ? api.doPost(e) : api.doGet(e);
    save();
    res.writeHead(200, cors); res.end(out.content);
  });
}).listen(API_PORT, '127.0.0.1');
console.log(`site http://localhost:${SITE_PORT}  api http://localhost:${API_PORT}/exec`);
