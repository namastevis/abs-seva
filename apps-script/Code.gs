/**
 * Sammilani Volunteer Registration — backend on Google Sheets (Apps Script web app).
 *
 * The Google Sheet this script is attached to IS the database: one tab per table
 * (Volunteers, Ashrams, Lists, Groups, Remarks, Admins, NotDuplicates). Photos go
 * into a Google Drive folder. The website (GitHub Pages) talks to this script
 * through its Web App URL.
 *
 * Setup (once): Extensions → Apps Script → paste this file → run `setup` →
 * Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * Full steps: README.md in the repository.
 */

const CONFIG = {
  REG_PREFIX: 'ABSM',
  EVENT_YEAR: '2026',
  DRIVE_FOLDER_ID: '1wWWglxkZE_Zmq5V8lEhy1LDrEpx0ZaaU',   // main Google Drive folder; sub-folders are created inside it
  FOLDERS: { photos: 'Volunteer photos', backups: 'Backups (daily copy of the Sheet)' },
  KEEP_BACKUPS: 21,
  MAX_PHOTO_BYTES: 3 * 1024 * 1024,
  TOKEN_HOURS: 12,          // admin login lasts this long
  EDIT_TOKEN_HOURS: 2,      // a volunteer's edit session
};
const LANGS = ['en', 'or', 'bn', 'hi', 'as'];
const GENDERS = ['Male', 'Female'];
const I18N = ['or', 'bn', 'hi', 'as'];

/* Tabs and their columns. Columns can be re-ordered in the Sheet, and extra columns
   can be added for your own notes: the script finds columns by their header name. */
const TABLES = {
  Volunteers: ['id', 'reg_no', 'name', 'mobile', 'whatsapp', 'email', 'age', 'gender', 'sangha_id', 'ashram_other',
    'lsangha_id', 'lsangha_other', 'seva_id', 'seva_other', 'bs_id', 'bs_other', 'zs_id', 'zs_other', 'group_id',
    'address', 'language', 'photo', 'original', 'needs_review', 'printed_at', 'printed_by', 'print_count',
    'edited_at', 'edit_count', 'client_id', 'created_at', 'updated_at'],
  Ashrams: ['id', 'name', 'name_or', 'name_bn', 'name_hi', 'name_as', 'location', 'active', 'created_at'],
  Lists: ['id', 'kind', 'name', 'name_or', 'name_bn', 'name_hi', 'name_as', 'location', 'sort_order', 'active', 'created_at'],
  Groups: ['id', 'sangha_id', 'name', 'leader_id', 'created_at'],
  Remarks: ['id', 'entity_type', 'entity_id', 'body', 'author', 'created_at'],
  Admins: ['username', 'password', 'role', 'ashram', 'active', 'note'],
  NotDuplicates: ['a', 'b', 'created_at'],
};
const NUMERIC = ['id', 'age', 'sangha_id', 'lsangha_id', 'seva_id', 'bs_id', 'zs_id', 'group_id', 'needs_review', 'print_count',
  'edit_count', 'active', 'sort_order', 'leader_id', 'entity_id', 'a', 'b'];
// Lists tab kinds → the Volunteers columns that point at them
const KINDS = { sangha: ['lsangha_id', 'lsangha_other'], seva: ['seva_id', 'seva_other'], bs: ['bs_id', 'bs_other'], zs: ['zs_id', 'zs_other'] };

/* Admin roles (Admins tab, "role" column) */
const ROLES = {
  super: ['view', 'edit', 'print', 'lists', 'delete'],   // Super admin
  coordinator: ['view', 'edit', 'print'],                 // Coordinator
  desk: ['view', 'print'],                                // Card desk
  viewer: ['view'],                                       // Viewer
};
function roleOf_(text) {
  const r = String(text || '').toLowerCase();
  if (/super/.test(r)) return 'super';
  if (/coord|manager|editor/.test(r)) return 'coordinator';
  if (/desk|print|card/.test(r)) return 'desk';
  return 'viewer';
}

/* =================================================================
   HTTP entry points
   ================================================================= */
class ApiFail extends Error {
  constructor(message, status, extra) { super(message); this.status = status || 400; this.extra = extra || {}; }
}
function fail_(message, status, extra) { throw new ApiFail(message, status, extra); }

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.r) return ContentService.createTextOutput('Sammilani API is running. Use the website to register.');
  return handle_(p.r, p);
}
function doPost(e) {
  let b = {};
  try { b = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { b = {}; }
  const route = (e && e.parameter && e.parameter.r) || b.r || '';
  return handle_(route, b);
}
function handle_(route, b) {
  let out;
  try {
    out = route_(String(route).replace(/[^a-z_]/g, ''), b || {});
  } catch (err) {
    if (err instanceof ApiFail) out = Object.assign({ ok: false, status: err.status, error: err.message }, err.extra);
    else { console.error(err && err.stack || err); out = { ok: false, status: 500, error: 'Server error. Please try again.' }; }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* =================================================================
   Sheet storage
   ================================================================= */
let _db = {};   // per-request cache of each tab
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function table_(name) {
  if (_db[name]) return _db[name];
  const cols = TABLES[name];
  let sh = ss_().getSheetByName(name);
  if (!sh) sh = createTab_(name, cols);
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const lastRow = sh.getLastRow();
  let head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h).trim());
  // add any column the script needs that the tab doesn't have yet
  const missing = cols.filter((c) => head.indexOf(c) < 0);
  if (missing.length) {
    sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    head = head.concat(missing);
  }
  const data = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, head.length).getValues() : [];
  const rows = [];
  data.forEach((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { if (h) o[h] = cellIn_(h, r[j]); });
    if (name === 'Admins' ? o.username : (o.id !== null && o.id !== undefined) || name === 'NotDuplicates') rows.push(o);
  });
  return (_db[name] = { name: name, sh: sh, head: head, rows: rows });
}
function createTab_(name, cols) {
  const sh = ss_().insertSheet(name);
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(1, 1, sh.getMaxRows(), cols.length + 5).setNumberFormat('@');   // keep text as typed (no auto dates/numbers)
  return sh;
}
function cellIn_(h, v) {
  if (v instanceof Date) v = Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd HH:mm:ss');
  if (NUMERIC.indexOf(h) >= 0) {
    if (v === '' || v === null || v === undefined) return null;
    if (h === 'active') return /^(0|false|no|n)$/i.test(String(v).trim()) ? 0 : 1;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  return v === null || v === undefined ? '' : String(v);
}
function cellOut_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function writeRow_(t, rowNo, obj) {
  const sh = t.sh;
  if (rowNo > sh.getMaxRows()) {
    sh.insertRowsAfter(sh.getMaxRows(), 500);
    sh.getRange(sh.getMaxRows() - 499, 1, 500, t.head.length).setNumberFormat('@');
  }
  sh.getRange(rowNo, 1, 1, t.head.length).setNumberFormat('@').setValues([t.head.map((h) => cellOut_(obj[h]))]);
}
function insert_(name, obj) {
  const t = table_(name);
  if (t.head.indexOf('id') >= 0) {
    // ids are never reused (a deleted volunteer's number is not handed to someone else): a counter per tab
    const key = 'NEXT_ID_' + name;
    const maxId = t.rows.reduce((m, r) => Math.max(m, r.id || 0), 0);
    if (!obj.id) obj.id = Math.max(Number(props_().getProperty(key)) || 0, maxId + 1);
    props_().setProperty(key, String(Math.max(Number(props_().getProperty(key)) || 0, obj.id + 1)));
  }
  const rowNo = Math.max(t.sh.getLastRow(), 1) + 1;
  writeRow_(t, rowNo, obj);
  obj._row = rowNo;
  t.rows.push(obj);
  return obj;
}
function update_(name, obj, patch) {
  Object.assign(obj, patch || {});
  writeRow_(table_(name), obj._row, obj);
  return obj;
}
/** Append many rows with one write (used where a request may add many). */
function insertMany_(name, objs) {
  if (!objs.length) return;
  const t = table_(name);
  const start = Math.max(t.sh.getLastRow(), 1) + 1;
  if (start + objs.length - 1 > t.sh.getMaxRows()) t.sh.insertRowsAfter(t.sh.getMaxRows(), objs.length + 100);
  t.sh.getRange(start, 1, objs.length, t.head.length).setNumberFormat('@').setValues(objs.map((o) => t.head.map((h) => cellOut_(o[h]))));
  objs.forEach((o, i) => { o._row = start + i; t.rows.push(o); });
}
function remove_(name, obj) {
  const t = table_(name);
  t.sh.deleteRow(obj._row);
  t.rows = t.rows.filter((r) => r !== obj);
  t.rows.forEach((r) => { if (r._row > obj._row) r._row--; });
}
function byId_(name, id) { id = Number(id); return table_(name).rows.find((r) => r.id === id) || null; }
/** Every change happens inside this lock, after re-reading the tabs, so two people saving at once never clash. */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { _db = {}; return fn(); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}

/* =================================================================
   Helpers
   ================================================================= */
function now_() { return Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd HH:mm:ss'); }
function str_(v, max) {
  let s = String(v === null || v === undefined ? '' : v).trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return s.slice(0, max || 500);
}
function toAscii_(s) {
  return String(s || '').replace(/[୦-୯০-৯०-९]/g, (c) => {
    const cp = c.charCodeAt(0);
    return String(cp - (cp >= 0x0B66 ? 0x0B66 : cp >= 0x09E6 ? 0x09E6 : 0x0966));
  });
}
/** Simple counters in CacheService for rate limits. throttle_ → false when the limit is reached. */
function throttle_(key, limit, seconds, peek) {
  const n = Number(CacheService.getScriptCache().get('rl:' + key) || 0);
  return n < limit;
}
function hit_(key, seconds) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get('rl:' + key) || 0) + 1;
  c.put('rl:' + key, String(n), seconds);
  return n;
}
function regNo_(id) { return CONFIG.REG_PREFIX + '-' + CONFIG.EVENT_YEAR + '-' + ('0000' + id).slice(-Math.max(4, String(id).length)); }
function i18nOf_(row) {
  const o = {};
  I18N.forEach((l) => { if (row && row['name_' + l]) o[l] = row['name_' + l]; });
  return o;
}
function props_() { return PropertiesService.getScriptProperties(); }
function secret_() {
  let s = props_().getProperty('SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props_().setProperty('SECRET', s); }
  return s;
}
function sign_(payload) {
  const body = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, secret_()));
  return body + '.' + sig;
}
function editToken_(v, exp) { return sign_({ kind: 'edit', id: v.id, c: v.created_at, m: String(v.mobile), exp: exp }); }
function verify_(token) {
  const p = String(token || '').split('.');
  if (p.length !== 2) return null;
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(p[0], secret_()));
  if (sig !== p[1]) return null;
  let data;
  try { data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(p[0])).getDataAsString()); } catch (e) { return null; }
  return data && data.exp > Date.now() ? data : null;
}

/* ---------- admins (Admins tab) ----------
   Passwords: type a new password into the Admins tab and it is replaced by a salted hash
   within seconds (onEdit), so the Sheet and its backups never hold readable passwords. */
const MIN_PASSWORD = 8;
function hashPassword_(plain, salt) {
  salt = salt || Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  let h = plain;
  for (let i = 0; i < 1000; i++) h = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(h, salt));
  return 'hash:' + salt + ':' + h;
}
function passwordOk_(stored, given) {
  stored = String(stored || ''); given = String(given || '');
  if (given.length < MIN_PASSWORD) return false;
  const m = /^hash:([^:]+):(.+)$/.exec(stored);
  if (m) return hashPassword_(given, m[1]) === stored;
  return stored.length >= MIN_PASSWORD && stored === given;   // not hashed yet: login hashes it (below)
}
/** Replace any plain-text password in the Admins tab by its hash. */
function hashAdminPasswords() {
  const t = table_('Admins');
  t.rows.forEach((a) => {
    const pw = String(a.password || '');
    if (pw && !/^hash:/.test(pw)) update_('Admins', a, { password: pw.length >= MIN_PASSWORD ? hashPassword_(pw) : '', note: pw.length >= MIN_PASSWORD ? a.note : 'Password too short (min ' + MIN_PASSWORD + ' characters) — type a longer one' });
  });
}
/** Simple trigger: runs when someone edits the Sheet by hand. */
function onEdit(e) {
  try {
    if (e && e.range && e.range.getSheet().getName() === 'Admins') { _db = {}; hashAdminPasswords(); }
    else if (e && e.range && e.range.getSheet().getName() === 'Lists' || e && e.range && e.range.getSheet().getName() === 'Ashrams') clearConfigCache_();
  } catch (err) { console.warn(err); }
}
function pwVersion_(a) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(String(a.password), secret_())).slice(0, 12); }
function admins_() {
  const ashrams = table_('Ashrams').rows;
  return table_('Admins').rows.map((a) => {
    const scopeName = String(a.ashram || '').trim().toLowerCase();
    let scope = null;
    if (scopeName && scopeName !== 'all') {
      const m = ashrams.find((s) => s.name.toLowerCase() === scopeName) || ashrams.find((s) => s.name.toLowerCase().indexOf(scopeName) >= 0);
      scope = m ? m.id : -1;   // unknown ashram name → sees nobody (safer than everybody)
    }
    const active = a.active === '' || a.active === undefined || !/^(0|false|no|n)$/i.test(String(a.active).trim());
    return { username: String(a.username).trim(), password: String(a.password), role: roleOf_(a.role), scope: scope,
             scope_name: scope ? (ashrams.find((s) => s.id === scope) || {}).name || a.ashram : '', active: active };
  }).filter((a) => a.username && a.active);
}
function adminPublic_(a) {
  return { user: a.username, role: a.role, can: ROLES[a.role], scope: a.scope, scope_name: a.scope_name };
}
function requireAdmin_(b, perm) {
  const t = verify_(b.token);
  if (!t || t.kind !== 'admin') fail_('Please log in', 401);
  const a = admins_().find((x) => x.username.toLowerCase() === String(t.u).toLowerCase());
  if (!a) fail_('Please log in', 401);   // removed or deactivated in the Admins tab
  if (t.pv !== pwVersion_(a)) fail_('Please log in', 401);   // password changed since this login
  if (perm && ROLES[a.role].indexOf(perm) < 0) fail_('Your role does not allow this', 403);
  return a;
}
function inScope_(admin, v) { return !!v && (!admin.scope || v.sangha_id === admin.scope); }
function entityInScope_(admin, type, id) {
  if (type === 'volunteer') return inScope_(admin, byId_('Volunteers', id));
  if (type === 'group') { const g = byId_('Groups', id); return !!g && (!admin.scope || g.sangha_id === admin.scope); }
  if (type === 'sangha') return !!byId_('Ashrams', id) && (!admin.scope || id === admin.scope);
  return false;
}

/* =================================================================
   Routes
   ================================================================= */
function route_(r, b) {
  switch (r) {

  /* ---------------- public ---------------- */
  case 'health':
    return { ok: true, tabs: Object.keys(TABLES).every((n) => !!ss_().getSheetByName(n)) };

  case 'config': {
    const cache = CacheService.getScriptCache();
    const hit = cache.get('config');
    if (hit) return JSON.parse(hit);
    const out = { ok: true, event_year: CONFIG.EVENT_YEAR,
      sanghas: table_('Ashrams').rows.filter((s) => s.active !== 0)
        .map((s) => ({ id: s.id, name: s.name, name_i18n: i18nOf_(s), location: s.location }))
        .sort((x, y) => x.name.localeCompare(y.name)),
      lsanghas: optionsList_('sangha', true), sevas: optionsList_('seva', true), bs: optionsList_('bs', true), zs: optionsList_('zs', true) };
    try { cache.put('config', JSON.stringify(out), 120); } catch (e) { /* too big to cache: fine */ }
    return out;
  }

  case 'translate': {
    const from = LANGS.indexOf(b.from) >= 0 ? b.from : 'en';
    const en = toEnglish_(str_(b.text, 1000), from, b.mode === 'name' ? 'name' : 'text');
    return { ok: en !== null, english: en };
  }

  case 'register':
    return withLock_(() => {
      const vols = table_('Volunteers').rows;
      const clientId = str_(b.client_id, 64);
      if (clientId) {   // idempotent retries from the offline outbox
        const dupe = vols.find((v) => v.client_id === clientId);
        if (dupe) return { ok: true, id: dupe.id, reg_no: dupe.reg_no, replayed: true };
      }
      const v = volunteerInput_(b);
      if (!throttle_('reg:all', 120, 60)) fail_('Too many registrations right now. Please try again in a minute.', 429);
      const same = vols.filter((x) => String(x.mobile) === v.mobile).length;
      if (same && !b.force) fail_('duplicate_mobile', 409, { duplicate: true });
      if (same >= 3) fail_('This mobile number is already used by 3 registrations. Please contact the organisers.', 429);
      hit_('reg:all', 60);
      v.photo = savePhoto_(b.photo, null);
      v.client_id = clientId;
      v.created_at = v.updated_at = now_();
      v.print_count = 0; v.edit_count = 0;
      insert_('Volunteers', v);
      v.reg_no = regNo_(v.id);
      update_('Volunteers', v);
      return { ok: true, id: v.id, reg_no: v.reg_no, name_en: v.name, photo: v.photo };
    });

  /* ---------- volunteers edit their own registration: registration number + mobile ---------- */
  case 'self_lookup': {
    const m = /(\d+)\D*$/.exec(toAscii_(b.reg_no));
    const id = m ? Number(m[1]) : 0;
    const mobile = toAscii_(b.mobile).replace(/\D/g, '').slice(-10);
    if (!throttle_('lk:id:' + id, 8, 3600) || !throttle_('lk:m:' + mobile, 8, 3600) || !throttle_('lk:all', 300, 3600)) fail_('too_many_attempts', 429);
    const v = id && mobile.length === 10 ? byId_('Volunteers', id) : null;
    if (!v || String(v.mobile) !== mobile) { hit_('lk:id:' + id, 3600); hit_('lk:m:' + mobile, 3600); hit_('lk:all', 3600); fail_('not_found', 404); }
    return { ok: true, item: publicVolunteer_(shapeVolunteer_(v)), token: editToken_(v, Date.now() + CONFIG.EDIT_TOKEN_HOURS * 3600e3) };
  }

  case 'self_update': {
    const t = verify_(b.token);
    if (!t || t.kind !== 'edit') fail_('expired', 401);
    return withLock_(() => {
      const before = byId_('Volunteers', t.id);
      // the token belongs to one registration: same record (created_at) and the mobile it was opened with
      if (!before || before.created_at !== t.c || String(before.mobile) !== t.m) fail_('expired', 401);
      const prev = Object.assign({}, before);
      const v = volunteerInput_(b);
      if (b.photo) {
        v.photo = savePhoto_(b.photo, null);
        if (v.photo && prev.photo) trashPhoto_(prev.photo);
      }
      const changed = Object.keys(v).filter((k) => ['original', 'needs_review', 'language'].indexOf(k) < 0 && cellOut_(prev[k]) !== cellOut_(v[k]));
      if (changed.length) {
        v.updated_at = v.edited_at = now_();
        v.edit_count = (prev.edit_count || 0) + 1;
        if (v.sangha_id !== prev.sangha_id) { v.group_id = null; clearLeader_(prev.id); }   // groups belong to an ashram
        update_('Volunteers', before, v);
        const labels = changed.map(fieldLabel_).filter((x, i, a) => a.indexOf(x) === i);
        insert_('Remarks', { entity_type: 'volunteer', entity_id: prev.id, author: 'volunteer', created_at: now_(),
          body: 'Volunteer updated their details: ' + labels.join(', ') + (prev.printed_at ? ' (ID card was already printed)' : '') });
      }
      return { ok: true, changed: changed, item: publicVolunteer_(shapeVolunteer_(before)), token: editToken_(before, t.exp) };   // never extended
    });
  }

  /* ---------------- admin: session ---------------- */
  case 'login': {
    const u = str_(b.username, 80).toLowerCase();
    if (!throttle_('login:' + u, 10, 900) || !throttle_('login:all', 100, 900, true)) fail_('Too many attempts. Try again in 15 minutes.', 429);
    let a = admins_().find((x) => x.username.toLowerCase() === u);
    if (!a || !passwordOk_(a.password, b.password)) { hit_('login:' + u, 900); hit_('login:all', 900); Utilities.sleep(500); fail_('Wrong username or password', 401); }
    if (!/^hash:/.test(a.password)) {   // first login with a typed password: store its hash instead
      withLock_(() => hashAdminPasswords());
      a = admins_().find((x) => x.username.toLowerCase() === u);
    }
    return Object.assign({ ok: true, token: sign_({ kind: 'admin', u: a.username, pv: pwVersion_(a), exp: Date.now() + CONFIG.TOKEN_HOURS * 3600e3 }) }, adminPublic_(a));
  }
  case 'me': {
    const t = verify_(b.token);
    const a = t && t.kind === 'admin' ? admins_().find((x) => x.username.toLowerCase() === String(t.u).toLowerCase()) : null;
    return a && t.pv === pwVersion_(a) ? Object.assign({ ok: true }, adminPublic_(a)) : { ok: false, user: null };
  }
  case 'logout':
    return { ok: true };

  case 'admin_bootstrap': {   // everything the dashboard needs except the volunteer list, in one call
    requireAdmin_(b, 'view');
    const lists = {};
    Object.keys(KINDS).forEach((k) => { lists[k] = optionsList_(k, false); });
    return { ok: true, sanghas: route_('structure', b).sanghas, lists: lists, stats: route_('stats', b) };
  }

  /* ---------------- admin: volunteers ---------------- */
  case 'volunteers': {
    const a = requireAdmin_(b, 'view');
    const items = filterVolunteers_(b, a).map(shapeVolunteer_).sort((x, y) => y.id - x.id);
    return { ok: true, items: items };
  }
  case 'volunteer': {
    const a = requireAdmin_(b, 'view');
    const v = byId_('Volunteers', b.id);
    if (!v || !inScope_(a, v)) fail_('Not found', 404);
    const item = shapeVolunteer_(v);
    item.remarks = remarksOf_('volunteer', v.id);
    return { ok: true, item: item };
  }
  case 'volunteer_update':
    return withLock_(() => {
      const a = requireAdmin_(b, 'edit');
      const v = byId_('Volunteers', b.id);
      if (!v || !inScope_(a, v)) fail_('Not found', 404);
      const p = {};
      [['name', 200], ['email', 200], ['mobile', 20], ['whatsapp', 20], ['address', 1000]].forEach(([f, max]) => { if (f in b) p[f] = str_(b[f], max); });
      if ('age' in b) p.age = Number(b.age) || null;
      if (GENDERS.indexOf(b.gender) >= 0) p.gender = b.gender;
      if ('sangha_id' in b) {
        const sid = Number(b.sangha_id) || null;
        if (a.scope && sid !== a.scope) fail_('You can only manage your own ashram', 403);
        if (sid !== v.sangha_id) { p.group_id = null; clearLeader_(v.id); }
        p.sangha_id = sid; if (sid) p.ashram_other = '';
      }
      Object.keys(KINDS).forEach((k) => {
        const [col, oth] = KINDS[k];
        if (!(col in b)) return;
        p[col] = Number(b[col]) || null;
        if (p[col]) p[oth] = '';
      });
      [['ashram_other', 200], ['lsangha_other', 200], ['seva_other', 300], ['bs_other', 200], ['zs_other', 200]].forEach(([f, max]) => { if (f in b) p[f] = str_(b[f], max); });
      if ('needs_review' in b) p.needs_review = b.needs_review ? 1 : 0;
      p.updated_at = now_();
      update_('Volunteers', v, p);
      return { ok: true };
    });
  case 'volunteer_delete':
    return withLock_(() => {
      const a = requireAdmin_(b, 'delete');
      const v = byId_('Volunteers', b.id);
      if (!v || !inScope_(a, v)) fail_('Not found', 404);
      if (v.photo) trashPhoto_(v.photo);
      clearLeader_(v.id);
      table_('Remarks').rows.filter((x) => x.entity_type === 'volunteer' && x.entity_id === v.id).reverse().forEach((x) => remove_('Remarks', x));
      remove_('Volunteers', v);
      return { ok: true };
    });
  case 'assign':   // move volunteers into a group (or out of it: group_id null)
    return withLock_(() => {
      const a = requireAdmin_(b, 'edit');
      const ids = (b.ids || []).map(Number).filter(Boolean);
      if (!ids.length) fail_('No volunteers selected');
      const gid = b.group_id ? Number(b.group_id) : null;
      let sid = null;
      if (gid) {
        const g = byId_('Groups', gid) || fail_('Group not found', 404);
        sid = g.sangha_id;
        if (a.scope && sid !== a.scope) fail_('You can only manage your own ashram', 403);
      }
      ids.forEach((id) => {
        const v = byId_('Volunteers', id);
        if (!v || !inScope_(a, v)) return;
        update_('Volunteers', v, { group_id: gid, sangha_id: sid || v.sangha_id, updated_at: now_() });
        table_('Groups').rows.filter((g) => g.leader_id === id && g.id !== gid).forEach((g) => update_('Groups', g, { leader_id: null }));
      });
      return { ok: true, count: ids.length };
    });

  /* ---------------- admin: ashrams, groups, remarks ---------------- */
  case 'structure': {
    const a = requireAdmin_(b, 'view');
    const vols = table_('Volunteers').rows;
    const groups = table_('Groups').rows;
    const rem = table_('Remarks').rows.filter((x) => x.entity_type === 'sangha' || x.entity_type === 'group').sort((x, y) => y.id - x.id);
    const remOf = (type, id) => rem.filter((x) => x.entity_type === type && x.entity_id === id).map(shapeRemark_);
    const sanghas = table_('Ashrams').rows.filter((s) => !a.scope || s.id === a.scope).sort((x, y) => x.name.localeCompare(y.name)).map((s) => ({
      id: s.id, name: s.name, location: s.location, active: s.active === 0 ? 0 : 1, name_i18n: i18nOf_(s),
      volunteers: vols.filter((v) => v.sangha_id === s.id).length,
      unassigned: vols.filter((v) => v.sangha_id === s.id && !v.group_id).length,
      remarks: remOf('sangha', s.id),
      groups: groups.filter((g) => g.sangha_id === s.id).sort((x, y) => x.name.localeCompare(y.name)).map((g) => {
        const l = g.leader_id ? byId_('Volunteers', g.leader_id) : null;
        return { id: g.id, sangha_id: g.sangha_id, name: g.name, leader_id: g.leader_id || null,
          members: vols.filter((v) => v.group_id === g.id).length,
          leader_name: l ? l.name : null, leader_mobile: l ? l.mobile : null, leader_reg: l ? l.reg_no : null, leader_photo: l ? l.photo : null,
          remarks: remOf('group', g.id) };
      }),
    }));
    return { ok: true, sanghas: sanghas };
  }
  case 'sangha_save':
    return withLock_(() => {
      requireAdmin_(b, 'lists');
      const name = str_(b.name, 200);
      if (name.length < 2) fail_('Name required');
      const p = { name: name, location: str_(b.location, 200), active: b.active === undefined ? 1 : (b.active ? 1 : 0) };
      I18N.forEach((l) => { p['name_' + l] = str_((b.name_i18n || {})[l], 200); });
      let s = b.id ? byId_('Ashrams', b.id) : null;
      if (s) update_('Ashrams', s, p); else s = insert_('Ashrams', Object.assign(p, { created_at: now_() }));
      clearConfigCache_();
      return { ok: true, id: s.id };
    });
  case 'group_save':
    return withLock_(() => {
      const a = requireAdmin_(b, 'edit');
      let g = b.id ? byId_('Groups', b.id) : null;
      if (b.id && !g) fail_('Not found', 404);
      const sid = g ? g.sangha_id : (Number(b.sangha_id) || 0);   // an existing group stays in its ashram
      if (!sid) fail_('Ashram required');
      if (a.scope && sid !== a.scope) fail_('You can only manage your own ashram', 403);
      const name = str_(b.name, 120);
      if (!g) {
        if (!name) fail_('Name required');
        g = insert_('Groups', { sangha_id: sid, name: name, leader_id: null, created_at: now_() });
      } else if (name) update_('Groups', g, { name: name });
      if ('leader_id' in b) {
        const lid = b.leader_id ? Number(b.leader_id) : null;
        if (lid) {   // a leader is always a member of their group (and its ashram)
          const v = byId_('Volunteers', lid);
          if (!v || !inScope_(a, v)) fail_('Not found', 404);
          if (a.scope && v.sangha_id !== sid) fail_('You can only manage your own ashram', 403);
          clearLeader_(lid);
          update_('Volunteers', v, { group_id: g.id, sangha_id: sid, updated_at: now_() });
        }
        update_('Groups', g, { leader_id: lid });
      }
      return { ok: true, id: g.id };
    });
  case 'group_delete':
    return withLock_(() => {
      const a = requireAdmin_(b, 'edit');
      const g = byId_('Groups', b.id) || fail_('Not found', 404);
      if (a.scope && g.sangha_id !== a.scope) fail_('You can only manage your own ashram', 403);
      table_('Volunteers').rows.filter((v) => v.group_id === g.id).forEach((v) => update_('Volunteers', v, { group_id: null }));
      table_('Remarks').rows.filter((x) => x.entity_type === 'group' && x.entity_id === g.id).reverse().forEach((x) => remove_('Remarks', x));
      remove_('Groups', g);
      return { ok: true };
    });
  case 'remark_add':
    return withLock_(() => {
      const a = requireAdmin_(b, 'edit');
      if (['sangha', 'group', 'volunteer'].indexOf(b.entity_type) < 0) fail_('Bad type');
      if (!entityInScope_(a, b.entity_type, Number(b.entity_id))) fail_('Not found', 404);
      const body = str_(b.body, 2000);
      if (!body) fail_('Remark is empty');
      const r = insert_('Remarks', { entity_type: b.entity_type, entity_id: Number(b.entity_id) || 0, body: body, author: a.username, created_at: now_() });
      return { ok: true, id: r.id };
    });
  case 'remark_delete':
    return withLock_(() => {
      const a = requireAdmin_(b, 'edit');
      const r = byId_('Remarks', b.id);
      if (!r || !entityInScope_(a, r.entity_type, r.entity_id)) fail_('Not found', 404);
      // coordinators remove only their own notes; the automatic history (volunteer edits, merges) only a super admin
      if (a.role !== 'super' && r.author !== a.username) fail_('You can only delete your own remarks', 403);
      remove_('Remarks', r);
      return { ok: true };
    });

  /* ---------------- admin: numbers ---------------- */
  case 'stats': {
    const a = requireAdmin_(b, 'view');
    const vols = table_('Volunteers').rows.filter((v) => inScope_(a, v));
    const ist = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
    const startUtc = Utilities.formatDate(new Date(new Date(ist + 'T00:00:00+05:30').getTime()), 'UTC', 'yyyy-MM-dd HH:mm:ss');
    const groups = table_('Groups').rows.filter((g) => !a.scope || g.sangha_id === a.scope);
    const count = (key) => { const m = {}; vols.forEach((v) => { m[v[key] || ''] = (m[v[key] || ''] || 0) + 1; }); return Object.keys(m).map((k) => ({ k: k, n: m[k] })); };
    return { ok: true, total: vols.length,
      today: vols.filter((v) => v.created_at >= startUtc).length,
      unassigned: vols.filter((v) => !v.group_id).length,
      groups: groups.length, groups_without_leader: groups.filter((g) => !g.leader_id).length,
      needs_review: vols.filter((v) => v.needs_review === 1).length,
      printed: vols.filter((v) => v.printed_at).length,
      edited_after_print: vols.filter((v) => v.printed_at && v.edited_at > v.printed_at).length,
      duplicates: dupCount_(a),
      by_gender: count('gender'), by_language: count('language') };
  }

  /* ---------------- admin: lists (Seva, Sangha, Bibhagiya / Zilla Sadasya) ---------------- */
  case 'options':
    requireAdmin_(b, 'view');
    return { ok: true, items: optionsList_(kindOf_(b.kind), false) };
  case 'option_save':
    return withLock_(() => {
      requireAdmin_(b, 'lists');
      const kind = kindOf_(b.kind);
      const name = str_(b.name, 200);
      if (name.length < 2) fail_('Name required');
      const p = { name: name, location: str_(b.location, 200), active: b.active === undefined ? 1 : (b.active ? 1 : 0) };
      I18N.forEach((l) => { if (b.name_i18n && l in b.name_i18n) p['name_' + l] = str_(b.name_i18n[l], 200); });
      let o = b.id ? table_('Lists').rows.find((x) => x.id === Number(b.id) && x.kind === kind) : null;
      if (o) update_('Lists', o, p);
      else {
        const max = table_('Lists').rows.filter((x) => x.kind === kind).reduce((m, x) => Math.max(m, x.sort_order || 0), 0);
        o = insert_('Lists', Object.assign(p, { kind: kind, sort_order: max + 10, created_at: now_() }));
      }
      clearConfigCache_();
      return { ok: true, id: o.id };
    });
  case 'option_move':
    return withLock_(() => {
      requireAdmin_(b, 'lists');
      const o = byId_('Lists', b.id) || fail_('Not found', 404);
      const list = table_('Lists').rows.filter((x) => x.kind === o.kind).sort(byOrder_);
      const i = list.indexOf(o), j = i + (Number(b.dir) < 0 ? -1 : 1);
      if (j >= 0 && j < list.length) { list[i] = list[j]; list[j] = o; }
      list.forEach((x, n) => { if (x.sort_order !== (n + 1) * 10) update_('Lists', x, { sort_order: (n + 1) * 10 }); });
      clearConfigCache_();
      return { ok: true };
    });
  case 'option_delete':   // only if nobody chose it; otherwise hide it instead
    return withLock_(() => {
      requireAdmin_(b, 'lists');
      const o = byId_('Lists', b.id) || fail_('Not found', 404);
      const col = KINDS[o.kind] ? KINDS[o.kind][0] : null;
      if (col && table_('Volunteers').rows.some((v) => v[col] === o.id)) fail_('in_use', 409);
      remove_('Lists', o);
      clearConfigCache_();
      return { ok: true };
    });
  case 'others': {   // free-text "Other" answers, grouped, so admins can add them to a list
    const a = requireAdmin_(b, 'view');
    const [idCol, oth] = b.kind === 'ashram' ? ['sangha_id', 'ashram_other'] : (KINDS[b.kind] || fail_('Bad kind'));
    const m = {};
    table_('Volunteers').rows.filter((v) => inScope_(a, v) && !v[idCol] && v[oth]).forEach((v) => {
      const k = v[oth].trim().toLowerCase();
      if (!m[k]) m[k] = { text: v[oth].trim(), n: 0 };
      m[k].n++;
    });
    return { ok: true, items: Object.keys(m).map((k) => m[k]).sort((x, y) => y.n - x.n || x.text.localeCompare(y.text)) };
  }
  case 'promote':   // add an "Other" answer to the list and link everyone who typed it
    return withLock_(() => {
      requireAdmin_(b, 'lists');
      const text = str_(b.text, 200), name = str_(b.name, 200) || text;
      if (name.length < 2) fail_('Name required');
      let newId, idCol, oth;
      if (b.kind === 'ashram') {
        newId = insert_('Ashrams', { name: name, location: '', active: 1, created_at: now_() }).id;
        idCol = 'sangha_id'; oth = 'ashram_other';
      } else if (KINDS[b.kind]) {
        const max = table_('Lists').rows.filter((x) => x.kind === b.kind).reduce((m, x) => Math.max(m, x.sort_order || 0), 0);
        newId = insert_('Lists', { kind: b.kind, name: name, location: str_(b.location, 200), sort_order: max + 10, active: 1, created_at: now_() }).id;
        [idCol, oth] = KINDS[b.kind];
      } else fail_('Bad kind');
      let linked = 0;
      table_('Volunteers').rows.forEach((v) => {
        if (!v[idCol] && v[oth] && v[oth].trim().toLowerCase() === text.trim().toLowerCase()) {
          const p = { updated_at: now_() }; p[idCol] = newId; p[oth] = '';
          update_('Volunteers', v, p); linked++;
        }
      });
      clearConfigCache_();
      return { ok: true, id: newId, linked: linked };
    });

  /* ---------------- admin: ID cards ---------------- */
  case 'mark_printed':
    return withLock_(() => {
      const a = requireAdmin_(b, 'print');
      const ids = (b.ids || []).map(Number).filter(Boolean);
      if (!ids.length) fail_('No volunteers selected');
      ids.forEach((id) => {
        const v = byId_('Volunteers', id);
        if (!v || !inScope_(a, v)) return;
        if (b.undo) update_('Volunteers', v, { printed_at: '', printed_by: '', print_count: Math.max(0, (v.print_count || 0) - 1) });
        else update_('Volunteers', v, { printed_at: now_(), printed_by: a.username, print_count: (v.print_count || 0) + 1 });
      });
      return { ok: true, count: ids.length };
    });

  /* ---------------- admin: duplicates ---------------- */
  case 'duplicates': {
    const a = requireAdmin_(b, 'view');
    return { ok: true, groups: findDuplicates_(a, true) };
  }
  case 'dup_dismiss':   // "not the same person"
    return withLock_(() => {
      const a = requireAdmin_(b, 'edit');
      const ids = (b.ids || []).map(Number).filter(Boolean).sort((x, y) => x - y);
      if (ids.length < 2 || ids.length > 20) fail_('Choose 2 to 20 registrations');
      if (!ids.every((id) => inScope_(a, byId_('Volunteers', id)))) fail_('Not found', 404);
      const have = {};
      table_('NotDuplicates').rows.forEach((d) => { have[d.a + '-' + d.b] = true; });
      const add = [];
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++)
        if (!have[ids[i] + '-' + ids[j]]) add.push({ a: ids[i], b: ids[j], created_at: now_() });
      insertMany_('NotDuplicates', add);
      return { ok: true };
    });
  case 'merge':   // keep one registration, move remarks/leadership over, delete the rest
    return withLock_(() => {
      const a = requireAdmin_(b, 'delete');
      const keep = byId_('Volunteers', b.keep);
      if (!inScope_(a, keep)) fail_('Not found', 404);
      const drop = (b.remove || []).map(Number).filter((x) => x && x !== keep.id);
      if (!drop.length) fail_('Nothing to merge');
      drop.forEach((d) => {
        const o = byId_('Volunteers', d);
        if (!o || !inScope_(a, o)) return;
        const fill = {};
        ['email', 'whatsapp', 'photo', 'group_id', 'seva_id', 'seva_other', 'lsangha_id', 'lsangha_other', 'bs_id', 'bs_other', 'zs_id', 'zs_other', 'printed_at']
          .forEach((f) => { if (!keep[f] && o[f]) fill[f] = o[f]; });
        if (Object.keys(fill).length) update_('Volunteers', keep, fill);
        table_('Remarks').rows.filter((x) => x.entity_type === 'volunteer' && x.entity_id === d).forEach((x) => update_('Remarks', x, { entity_id: keep.id }));
        table_('Groups').rows.filter((g) => g.leader_id === d).forEach((g) => update_('Groups', g, { leader_id: keep.id }));
        if (o.photo && o.photo !== keep.photo) trashPhoto_(o.photo);
        remove_('Volunteers', o);
      });
      insert_('Remarks', { entity_type: 'volunteer', entity_id: keep.id, body: 'Merged duplicate registration(s): ' + drop.length, author: a.username, created_at: now_() });
      return { ok: true };
    });

  default:
    fail_('Unknown route', 404);
  }
}

/* =================================================================
   Volunteers
   ================================================================= */
/** Validate and normalise a registration (new or edited). Free text is stored in English;
    what the volunteer typed in their own script is kept in `original`. */
function volunteerInput_(b) {
  const lang = LANGS.indexOf(b.language) >= 0 ? b.language : 'en';
  const name = str_(b.name, 200);
  const email = str_(b.email, 200).toLowerCase();
  const mobile = toAscii_(b.mobile).replace(/\D/g, '');
  const wa = toAscii_(b.whatsapp).replace(/\D/g, '') || mobile;
  const age = Number(toAscii_(b.age)) || 0;
  const gender = GENDERS.indexOf(b.gender) >= 0 ? b.gender : '';
  const addr = str_(b.address, 1000);
  const [ashramId, ashramOther] = picked_(b, 'sangha_id', 'ashram_other', 'ashram');
  const [lsId, lsOther] = picked_(b, 'lsangha_id', 'lsangha_other', 'sangha');
  const [sevaId, sevaOther] = picked_(b, 'seva_id', 'seva_other', 'seva');
  const [bsId, bsOther] = picked_(b, 'bs_id', 'bs_other', 'bs');     // reference persons (optional)
  const [zsId, zsOther] = picked_(b, 'zs_id', 'zs_other', 'zs');

  const errors = {};
  if (name.length < 2) errors.name = 'required';
  if (!/^[6-9]\d{9}$/.test(mobile.slice(-10))) errors.mobile = 'invalid';
  if (wa && !/^\d{10,13}$/.test(wa)) errors.whatsapp = 'invalid';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'invalid';
  if (age < 10 || age > 100) errors.age = 'invalid';
  if (!gender) errors.gender = 'required';
  if (!ashramId && ashramOther.length < 2) errors.sangha_id = 'required';
  if (!sevaId && sevaOther.length < 2) errors.seva = 'required';
  if (addr.length < 3) errors.address = 'required';
  if (Object.keys(errors).length) fail_('Please check the form', 422, { fields: errors });

  const en = b.english && typeof b.english === 'object' ? b.english : {};
  const fields = { name: [name, 200, 'name'], address: [addr, 1000, 'text'], ashram_other: [ashramOther, 200, 'name'],
    lsangha_other: [lsOther, 200, 'name'], seva_other: [sevaOther, 300, 'text'], bs_other: [bsOther, 200, 'name'], zs_other: [zsOther, 200, 'name'] };
  const original = {};
  let review = 0;
  Object.keys(fields).forEach((k) => {
    const [val, max, mode] = fields[k];
    if (!val || !/[^\x00-\x7F]/.test(val)) return;
    original[k] = val;
    let eng = str_(en[k], max) || toEnglish_(val, lang === 'en' ? scriptLang_(val) : lang, mode);
    if (!eng || /[^\x00-\x7F]/.test(eng)) review = 1;
    fields[k][0] = eng || val;
  });
  const f = (k) => fields[k][0];
  return { name: f('name'), email: email, mobile: mobile.slice(-10), whatsapp: wa, age: age, gender: gender,
    sangha_id: ashramId, ashram_other: f('ashram_other'), lsangha_id: lsId, lsangha_other: f('lsangha_other'),
    seva_id: sevaId, seva_other: f('seva_other'), bs_id: bsId, bs_other: f('bs_other'), zs_id: zsId, zs_other: f('zs_other'),
    address: f('address'), language: lang, original: Object.keys(original).length ? JSON.stringify(original) : '', needs_review: review };
}
/** A list picker's answer: [id, ''] when chosen from the list, [null, text] for "Other". */
function picked_(b, idKey, otherKey, kind) {
  const raw = b[idKey];
  let id = (raw === 'other' || raw === '' || raw === null || raw === undefined) ? 0 : Number(raw) || 0;
  if (id) {
    const ok = kind === 'ashram'
      ? table_('Ashrams').rows.some((s) => s.id === id && s.active !== 0)
      : table_('Lists').rows.some((o) => o.id === id && o.kind === kind && o.active !== 0);
    if (!ok) id = 0;
  }
  return [id || null, id ? '' : str_(b[otherKey], 300)];
}
function scriptLang_(s) {
  if (/[଀-୿]/.test(s)) return 'or';
  if (/[ঀ-৿]/.test(s)) return 'bn';
  if (/[ऀ-ॿ]/.test(s)) return 'hi';
  return 'auto';
}
/** Names are transliterated ("ଲୋପାମୁଦ୍ରା" → "Lopamudra"), other text is translated. */
function toEnglish_(text, from, mode) {
  text = String(text || '').trim();
  if (!text || from === 'en' || !/[^\x00-\x7F]/.test(text)) return text;
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + encodeURIComponent(from) +
      '&tl=en&dt=t&dt=rm&q=' + encodeURIComponent(text);
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      const j = JSON.parse(res.getContentText());
      let translated = '', roman = '';
      (j[0] || []).forEach((seg) => {
        if (typeof seg[0] === 'string') translated += seg[0];
        if (typeof seg[3] === 'string') roman += seg[3];
      });
      if (mode === 'name' && roman) return tidyRoman_(roman);
      if (translated) return translated;
    }
  } catch (e) { /* fall through */ }
  if (mode !== 'name') { try { return LanguageApp.translate(text, from === 'auto' ? '' : from, 'en'); } catch (e) {} }
  return null;
}
function tidyRoman_(s) {
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z .'-]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/* ---------- photos (Google Drive) ---------- */
/* ---------- Google Drive folders ----------
   <main folder>/                        (CONFIG.DRIVE_FOLDER_ID; the Sheet is moved here by setup)
     Volunteer photos/                   one image per volunteer, viewable by link
     Backups (daily copy of the Sheet)/  a dated copy of the whole Sheet every night        */
function rootFolder_() {
  try { return DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID); }
  catch (e) { throw new Error('Cannot open the Drive folder ' + CONFIG.DRIVE_FOLDER_ID + '. Use the Google account that owns it, or change DRIVE_FOLDER_ID at the top of Code.gs.'); }
}
function subFolder_(key) {
  const prop = 'FOLDER_' + key.toUpperCase();
  const id = props_().getProperty(prop);
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* deleted: find or make again */ } }
  const root = rootFolder_();
  const it = root.getFoldersByName(CONFIG.FOLDERS[key]);
  const f = it.hasNext() ? it.next() : root.createFolder(CONFIG.FOLDERS[key]);
  props_().setProperty(prop, f.getId());
  return f;
}
function photoFolder_() { return subFolder_('photos'); }

/** Nightly: a dated copy of the whole Sheet in the Backups folder (older ones are removed). */
function backupSheet() {
  const folder = subFolder_('backups');
  const file = DriveApp.getFileById(ss_().getId());
  file.makeCopy(ss_().getName() + ' — backup ' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm'), folder);
  const copies = [];
  const it = folder.getFiles();
  while (it.hasNext()) copies.push(it.next());
  copies.sort((a, b) => b.getDateCreated() - a.getDateCreated()).slice(CONFIG.KEEP_BACKUPS).forEach((f) => f.setTrashed(true));
}
function savePhoto_(dataUrl, name) {
  if (!dataUrl) return '';
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(String(dataUrl));
  if (!m) return '';
  const bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > CONFIG.MAX_PHOTO_BYTES) fail_('Photo too large', 413);
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const file = photoFolder_().createFile(Utilities.newBlob(bytes, 'image/' + m[1], (name || Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 8)) + '.' + ext));
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { console.warn('Could not share photo: ' + e); }
  return 'drive:' + file.getId();
}
function trashPhoto_(photo) {
  const m = /^drive:(.+)$/.exec(String(photo || ''));
  if (m) { try { DriveApp.getFileById(m[1]).setTrashed(true); } catch (e) {} }
}

/* ---------- shaping ---------- */
function shapeVolunteer_(v) {
  const o = Object.assign({}, v);
  delete o._row; delete o.client_id;
  const s = v.sangha_id ? byId_('Ashrams', v.sangha_id) : null;
  const g = v.group_id ? byId_('Groups', v.group_id) : null;
  const opt = (id) => (id ? byId_('Lists', id) : null);
  const ls = opt(v.lsangha_id), sv = opt(v.seva_id), bs = opt(v.bs_id), zs = opt(v.zs_id);
  o.sangha_name = s ? s.name : null; o.sangha_i18n = i18nOf_(s);
  o.group_name = g ? g.name : null;
  o.lsangha_name = ls ? ls.name : null; o.lsangha_i18n = i18nOf_(ls);
  o.seva_name = sv ? sv.name : null; o.seva_i18n = i18nOf_(sv);
  o.bs_name = bs ? bs.name : null; o.bs_area = bs ? bs.location : null;
  o.zs_name = zs ? zs.name : null; o.zs_area = zs ? zs.location : null;
  o.is_leader = table_('Groups').rows.some((x) => x.leader_id === v.id);
  o.changed_after_print = !!(v.printed_at && v.edited_at && v.edited_at > v.printed_at);
  try { o.original = v.original ? JSON.parse(v.original) : null; } catch (e) { o.original = null; }
  ['ashram_other', 'lsangha_other', 'seva_other', 'bs_other', 'zs_other', 'printed_at', 'edited_at', 'email', 'whatsapp', 'photo']
    .forEach((k) => { if (o[k] === '') o[k] = null; });
  return o;
}
/** What a volunteer may see of their own record (no admin remarks, groups or print status). */
function publicVolunteer_(v) {
  const keep = ['id', 'reg_no', 'name', 'email', 'mobile', 'whatsapp', 'age', 'gender', 'address', 'language', 'photo', 'original',
    'sangha_id', 'ashram_other', 'lsangha_id', 'lsangha_other', 'seva_id', 'seva_other', 'bs_id', 'bs_other', 'zs_id', 'zs_other'];
  const o = {};
  keep.forEach((k) => { o[k] = v[k] === undefined ? null : v[k]; });
  return o;
}
function remarksOf_(type, id) {
  return table_('Remarks').rows.filter((r) => r.entity_type === type && r.entity_id === id).sort((x, y) => y.id - x.id).map(shapeRemark_);
}
function shapeRemark_(r) { return { id: r.id, entity_type: r.entity_type, entity_id: r.entity_id, body: r.body, author: r.author, created_at: r.created_at }; }
function clearLeader_(vid) { table_('Groups').rows.filter((g) => g.leader_id === vid).forEach((g) => update_('Groups', g, { leader_id: null })); }
function fieldLabel_(k) {
  return ({ sangha_id: 'Bibhagiya Ashram', ashram_other: 'Bibhagiya Ashram', lsangha_id: 'Sangha', lsangha_other: 'Sangha', seva_id: 'Seva',
    seva_other: 'Seva', bs_id: 'Bibhagiya Sadasya', bs_other: 'Bibhagiya Sadasya', zs_id: 'Zilla Sadasya', zs_other: 'Zilla Sadasya',
    whatsapp: 'WhatsApp' })[k] || (k.charAt(0).toUpperCase() + k.slice(1));
}

function filterVolunteers_(q, admin) {
  let rows = table_('Volunteers').rows.filter((v) => inScope_(admin, v));
  const s = String(q.q || '').trim().toLowerCase();
  if (s) {
    const lists = table_('Lists').rows;
    const nameOf = (id) => { const o = id ? lists.find((x) => x.id === id) : null; return o ? o.name : ''; };
    rows = rows.filter((v) => [v.name, v.mobile, v.whatsapp, v.email, v.reg_no, v.address, v.original, v.seva_other, v.lsangha_other,
      v.ashram_other, v.bs_other, v.zs_other, nameOf(v.bs_id), nameOf(v.zs_id)].some((x) => String(x || '').toLowerCase().indexOf(s) >= 0));
  }
  const pick = { sangha: ['sangha_id', 'ashram_other'], lsangha: ['lsangha_id', 'lsangha_other'], seva: ['seva_id', 'seva_other'], bs: ['bs_id', 'bs_other'], zs: ['zs_id', 'zs_other'] };
  Object.keys(pick).forEach((key) => {
    const val = q[key]; if (!val) return;
    const [col, oth] = pick[key];
    if (val === 'other') rows = rows.filter((v) => !v[col] && v[oth]);
    else if (val === 'none') rows = rows.filter((v) => !v[col] && !v[oth]);
    else rows = rows.filter((v) => v[col] === Number(val));
  });
  if (q.printed === 'yes') rows = rows.filter((v) => v.printed_at);
  if (q.printed === 'no') rows = rows.filter((v) => !v.printed_at);
  if (q.printed === 'changed') rows = rows.filter((v) => v.printed_at && v.edited_at > v.printed_at);
  if (q.edited) rows = rows.filter((v) => v.edited_at);
  if (q.ids) { const ids = String(q.ids).split(',').map(Number); rows = rows.filter((v) => ids.indexOf(v.id) >= 0); }
  if (q.group === 'none') rows = rows.filter((v) => !v.group_id);
  else if (q.group) rows = rows.filter((v) => v.group_id === Number(q.group));
  if (GENDERS.indexOf(q.gender) >= 0) rows = rows.filter((v) => v.gender === q.gender);
  if (LANGS.indexOf(q.lang) >= 0) rows = rows.filter((v) => v.language === q.lang);
  if (q.age_min) rows = rows.filter((v) => v.age >= Number(q.age_min));
  if (q.age_max) rows = rows.filter((v) => v.age <= Number(q.age_max));
  if (q.leaders) { const leaders = table_('Groups').rows.map((g) => g.leader_id); rows = rows.filter((v) => leaders.indexOf(v.id) >= 0); }
  if (q.review) rows = rows.filter((v) => v.needs_review === 1);
  if (q.photo === 'no') rows = rows.filter((v) => !v.photo);
  if (q.photo === 'yes') rows = rows.filter((v) => v.photo);
  return rows;
}

/* ---------- lists ---------- */
function kindOf_(k) { return KINDS[k] ? k : 'sangha'; }
function byOrder_(x, y) { return (x.sort_order || 0) - (y.sort_order || 0) || x.name.localeCompare(y.name); }
function optionsList_(kind, activeOnly) {
  const col = KINDS[kind][0];
  const used = {};
  if (!activeOnly) table_('Volunteers').rows.forEach((v) => { if (v[col]) used[v[col]] = (used[v[col]] || 0) + 1; });
  return table_('Lists').rows.filter((o) => o.kind === kind && (!activeOnly || o.active !== 0)).sort(byOrder_).map((o) => ({
    id: o.id, name: o.name, location: o.location, active: o.active === 0 ? 0 : 1, sort_order: o.sort_order || 0,
    used: used[o.id] || 0, name_i18n: i18nOf_(o) }));
}
function clearConfigCache_() { try { CacheService.getScriptCache().remove('config'); } catch (e) {} }

/* ---------- duplicates ---------- */
/** Possible duplicate registrations, grouped: same mobile, same email, or a very similar
    name in the same Bibhagiya Ashram / with ages within 2 years. "Not the same person" pairs are skipped. */
function findDuplicates_(admin, withPeople) {
  const rows = table_('Volunteers').rows.filter((v) => inScope_(admin, v));
  const dismissed = {};
  table_('NotDuplicates').rows.forEach((d) => { dismissed[d.a + '-' + d.b] = true; });
  const norm = (n) => {
    n = String(n || '').toLowerCase().replace(/\b(dr|mr|mrs|ms|sri|shri|smt|kumari)\b\.?/g, ' ').replace(/[^a-z ]/g, ' ').replace(/(.)\1+/g, '$1');
    [['sh', 's'], ['th', 't'], ['dh', 'd'], ['bh', 'b'], ['ph', 'f'], ['kh', 'k'], ['gh', 'g'], ['ch', 'c'], ['jh', 'j'], ['w', 'b'], ['v', 'b']]
      .forEach(([a, b]) => { n = n.split(a).join(b); });
    return n.split(' ').filter(Boolean).sort().join(' ');
  };
  const key = rows.map((r) => norm(r.name));
  const parent = rows.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const reasons = {};
  const link = (i, j, why) => {
    const a = Math.min(rows[i].id, rows[j].id), b = Math.max(rows[i].id, rows[j].id);
    if (dismissed[a + '-' + b]) return;
    parent[find(i)] = find(j);
    (reasons[a + '-' + b] = reasons[a + '-' + b] || []).push(why);
  };
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const A = rows[i], B = rows[j];
      if (A.mobile && String(A.mobile) === String(B.mobile)) { link(i, j, 'same_mobile'); continue; }
      if (A.email && B.email && A.email.toLowerCase() === B.email.toLowerCase()) { link(i, j, 'same_email'); continue; }
      if (!key[i] || !key[j]) continue;
      const same = key[i] === key[j];
      const close = same || (Math.abs(key[i].length - key[j].length) <= 2 && key[i].length >= 6 && lev_(key[i], key[j]) <= 2);
      if (!close) continue;
      if ((A.sangha_id && A.sangha_id === B.sangha_id) || (A.age && B.age && Math.abs(A.age - B.age) <= 2)) link(i, j, same ? 'same_name' : 'similar_name');
    }
  }
  const groups = {};
  rows.forEach((r, i) => { const k = find(i); (groups[k] = groups[k] || []).push(r.id); });
  const list = Object.keys(groups).map((k) => groups[k]).filter((g) => g.length > 1);
  if (!withPeople) return list;
  return list.map((ids) => {
    ids.sort((x, y) => x - y);
    const why = {};
    for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) (reasons[ids[x] + '-' + ids[y]] || []).forEach((w) => { why[w] = true; });
    return { ids: ids, reasons: Object.keys(why), people: ids.map((id) => shapeVolunteer_(byId_('Volunteers', id))) };
  });
}
/** Counting duplicates compares every pair of volunteers; cache the number for a minute. */
function dupCount_(admin) {
  const cache = CacheService.getScriptCache();
  const key = 'dups:' + (admin.scope || 'all');
  const hit = cache.get(key);
  if (hit !== null && hit !== undefined) return Number(hit);
  const n = findDuplicates_(admin, false).length;
  cache.put(key, String(n), 120);
  return n;
}
function lev_(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/* =================================================================
   Setup, menu, readable view
   ================================================================= */
/** Run once from the Apps Script editor (select "setup" → Run). Safe to run again. */
function setup() {
  Object.keys(TABLES).forEach((n) => table_(n));
  const now = now_();
  if (!table_('Ashrams').rows.length) {
    SEED.ashrams.forEach((a) => {
      const row = { name: a.name, location: a.location, active: 1, created_at: now };
      I18N.forEach((l) => { row['name_' + l] = a.i18n[l] || ''; });
      insert_('Ashrams', row);
    });
  }
  const lists = table_('Lists');
  if (!lists.rows.some((o) => o.kind === 'seva')) {
    SEED.sevas.forEach((s, i) => {
      const row = { kind: 'seva', name: s.name, location: '', sort_order: (i + 1) * 10, active: 1, created_at: now };
      I18N.forEach((l) => { row['name_' + l] = s.i18n[l] || ''; });
      insert_('Lists', row);
    });
  }
  if (!lists.rows.some((o) => o.kind === 'bs' || o.kind === 'zs')) {
    SEED.sadasyas.forEach(([kind, name, area], i) => insert_('Lists', { kind: kind, name: name, location: area, sort_order: (i + 1) * 10, active: 1, created_at: now }));
  }
  if (!table_('Admins').rows.length) {
    insert_('Admins', { username: 'superadmin', password: '', role: 'Super admin', ashram: '', active: 'yes',
      note: 'Type a password (8+ characters) in the password cell. It is replaced by a code at once, so nobody can read it back.' });
  }
  hashAdminPasswords();
  const adm = table_('Admins').sh;
  adm.getRange('C2:C500').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Super admin', 'Coordinator', 'Card desk', 'Viewer'], true).setAllowInvalid(false).build());
  adm.getRange('E2:E500').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['yes', 'no'], true).build());
  adm.getRange('D1').setNote('Leave empty for all ashrams, or type a Bibhagiya Ashram name exactly as in the Ashrams tab to limit this login to that ashram.');
  // Drive: keep the Sheet in the main folder, create the sub-folders
  const root = rootFolder_();
  try { DriveApp.getFileById(ss_().getId()).moveTo(root); } catch (e) { console.warn('Could not move the Sheet into the folder: ' + e); }
  photoFolder_(); subFolder_('backups');
  secret_();
  // keep the readable copy fresh, and back the Sheet up every night
  ScriptApp.getProjectTriggers().filter((t) => ['refreshReadable', 'backupSheet'].indexOf(t.getHandlerFunction()) >= 0).forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('refreshReadable').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('backupSheet').timeBased().everyDays(1).atHour(2).create();
  refreshReadable();
  SpreadsheetApp.flush();
  const msg = 'Setup complete. Next: open the Admins tab and type a password (8+ characters) for superadmin.';
  console.log(msg);
  return msg;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Sammilani')
    .addItem('Refresh readable volunteer list', 'refreshReadable')
    .addItem('Back up the Sheet now', 'backupSheet')
    .addSeparator()
    .addItem('Import from the old website (VPS)…', 'importFromVpsMenu')
    .addToUi();
}

/** "Volunteers (readable)": names instead of ids, for printing, sharing or filtering in the Sheet.
    Rebuilt every 30 minutes and from the Sammilani menu. Do not edit it — edit the Volunteers tab. */
function refreshReadable() {
  _db = {};
  const name = 'Volunteers (readable)';
  const sh = ss_().getSheetByName(name) || ss_().insertSheet(name);
  const head = ['Reg No', 'Name', 'Name as typed', 'Age', 'Gender', 'Mobile', 'WhatsApp', 'Email', 'Bibhagiya Ashram', 'Sangha', 'Seva',
    'Bibhagiya Sadasya (reference)', 'Zilla Sadasya (reference)', 'Group', 'Team leader', 'Address', 'Language', 'Photo',
    'ID card printed (UTC)', 'Registered (UTC)', 'Last edited by volunteer (UTC)'];
  const other = (n, o) => n || (o ? 'Other: ' + o : '');
  const rows = table_('Volunteers').rows.slice().sort((a, b) => a.id - b.id).map((r) => {
    const v = shapeVolunteer_(r);
    const orig = v.original || {};
    const m = /^drive:(.+)$/.exec(v.photo || '');
    return [v.reg_no, v.name, orig.name || '', v.age, v.gender, v.mobile, v.whatsapp, v.email, other(v.sangha_name, v.ashram_other),
      other(v.lsangha_name, v.lsangha_other), other(v.seva_name, v.seva_other), other(v.bs_name, v.bs_other), other(v.zs_name, v.zs_other),
      v.group_name || '', v.is_leader ? 'Yes' : '', v.address, v.language, m ? 'https://drive.google.com/file/d/' + m[1] + '/view' : '',
      v.printed_at || '', v.created_at, v.edited_at || ''].map(cellOut_);
  });
  sh.clearContents();
  const all = [head].concat(rows);
  sh.getRange(1, 1, all.length, head.length).setNumberFormat('@').setValues(all);
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(1, 1).setNote('Rebuilt automatically every 30 minutes (Sammilani menu → Refresh). Edits here are overwritten — use the admin dashboard or the Volunteers tab.');
}

/* =================================================================
   One-time import from the old website (PHP on the VPS)
   Volunteers keep their registration numbers. Run it right before switching over;
   running it again only adds registrations that are not here yet.
   ================================================================= */
function importFromVpsMenu() {
  const ui = SpreadsheetApp.getUi();
  const url = ui.prompt('Old website address', 'e.g. https://seva.namastevis.in', ui.ButtonSet.OK_CANCEL);
  if (url.getSelectedButton() !== ui.Button.OK) return;
  const user = ui.prompt('Old admin username', ui.ButtonSet.OK_CANCEL);
  if (user.getSelectedButton() !== ui.Button.OK) return;
  const pass = ui.prompt('Old admin password', ui.ButtonSet.OK_CANCEL);
  if (pass.getSelectedButton() !== ui.Button.OK) return;
  const vpsUrl = url.getResponseText().trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(vpsUrl)) { ui.alert('Please use the https:// address of the old website.'); return; }
  props_().setProperties({ VPS_URL: vpsUrl, VPS_USER: user.getResponseText().trim(), VPS_PASS: pass.getResponseText() });
  const res = importFromVps();
  ui.alert(res);
}

function vpsSession_() {
  const p = props_().getProperties();
  if (!p.VPS_URL) throw new Error('Run "Import from the old website" from the Sammilani menu first.');
  const res = UrlFetchApp.fetch(p.VPS_URL + '/api/index.php?r=login', { method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ username: p.VPS_USER, password: p.VPS_PASS }), muteHttpExceptions: true, followRedirects: false });
  if (res.getResponseCode() !== 200) throw new Error('Login to the old website failed (' + res.getResponseCode() + '). Check the username and password.');
  let cookies = res.getAllHeaders()['Set-Cookie'] || [];
  if (!Array.isArray(cookies)) cookies = [cookies];
  const cookie = cookies.map((c) => String(c).split(';')[0]).join('; ');
  const get = (route, params) => {
    const qs = Object.keys(params || {}).map((k) => '&' + k + '=' + encodeURIComponent(params[k])).join('');
    const r = UrlFetchApp.fetch(p.VPS_URL + '/api/index.php?r=' + route + qs, { headers: { Cookie: cookie }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error('Old website: ' + route + ' failed (' + r.getResponseCode() + ')');
    return JSON.parse(r.getContentText());
  };
  return { url: p.VPS_URL, get: get };
}

/** Step 1: ashrams, lists, groups, volunteers, remarks. Photos follow in step 2 (automatically). */
function importFromVps() {
  const vps = vpsSession_();
  const structure = vps.get('structure').sanghas;
  const oldLists = { seva: vps.get('options', { kind: 'seva' }).items, sangha: vps.get('options', { kind: 'sangha' }).items };
  const vols = vps.get('volunteers').items.sort((a, b) => a.id - b.id);
  const report = withLock_(() => {
    const now = now_();
    // Ashrams: keep the old ids (volunteers and groups point at them)
    structure.forEach((s) => {
      const p = { name: s.name, location: s.location || '', active: s.active === 0 ? 0 : 1 };
      I18N.forEach((l) => { p['name_' + l] = (s.name_i18n || {})[l] || ''; });
      const have = byId_('Ashrams', s.id);
      if (have) update_('Ashrams', have, p); else insert_('Ashrams', Object.assign(p, { id: s.id, created_at: now }));
    });
    // Lists: match by name (old placeholder sevas → their new names), add anything missing
    const renames = { 'annapurna': 'Annapurna Bhandar Stores', 'reception': 'Reception of Delegates', 'night security': 'Night Duty', 'discipline': 'Maintenance of Discipline at Mancha' };
    const map = { seva: {}, sangha: {} };
    ['seva', 'sangha'].forEach((kind) => oldLists[kind].forEach((o) => {
      const want = (kind === 'seva' && renames[o.name.toLowerCase()]) || o.name;
      let n = table_('Lists').rows.find((x) => x.kind === kind && x.name.toLowerCase() === want.toLowerCase());
      if (!n) {
        const max = table_('Lists').rows.filter((x) => x.kind === kind).reduce((m, x) => Math.max(m, x.sort_order || 0), 0);
        const row = { kind: kind, name: o.name, location: o.location || '', sort_order: max + 10, active: o.active === 0 ? 0 : 1, created_at: now };
        I18N.forEach((l) => { row['name_' + l] = (o.name_i18n || {})[l] || ''; });
        n = insert_('Lists', row);
      }
      map[kind][o.id] = n.id;
    }));
    // Groups (old ids kept)
    structure.forEach((s) => s.groups.forEach((g) => {
      if (!byId_('Groups', g.id)) insert_('Groups', { id: g.id, sangha_id: s.id, name: g.name, leader_id: g.leader_id || null, created_at: now });
    }));
    // Ashram / group remarks
    structure.forEach((s) => {
      s.remarks.concat(...s.groups.map((g) => g.remarks)).forEach((r) => {
        const dupe = table_('Remarks').rows.some((x) => x.entity_type === r.entity_type && x.entity_id === r.entity_id && x.body === r.body && x.created_at === r.created_at);
        if (!dupe) insert_('Remarks', { entity_type: r.entity_type, entity_id: r.entity_id, body: r.body, author: r.author, created_at: r.created_at });
      });
    });
    // Volunteers (old ids → same registration numbers). Typed "Other" sevas that match a list entry are linked.
    let added = 0;
    const sevaByName = {};
    table_('Lists').rows.filter((x) => x.kind === 'seva').forEach((x) => { sevaByName[x.name.toLowerCase()] = x.id; });
    vols.forEach((v) => {
      if (byId_('Volunteers', v.id)) return;
      let sevaId = v.seva_id ? map.seva[v.seva_id] || null : null;
      let sevaOther = v.seva_other || '';
      if (!sevaId && sevaOther && sevaByName[sevaOther.trim().toLowerCase()]) { sevaId = sevaByName[sevaOther.trim().toLowerCase()]; sevaOther = ''; }
      insert_('Volunteers', { id: v.id, reg_no: v.reg_no || regNo_(v.id), name: v.name, mobile: v.mobile, whatsapp: v.whatsapp, email: v.email,
        age: v.age, gender: v.gender, sangha_id: v.sangha_id, ashram_other: v.ashram_other || '', lsangha_id: v.lsangha_id ? map.sangha[v.lsangha_id] || null : null,
        lsangha_other: v.lsangha_other || '', seva_id: sevaId, seva_other: sevaOther, group_id: v.group_id, address: v.address, language: v.language,
        photo: v.photo ? 'vps:' + v.photo : '', original: v.original ? JSON.stringify(v.original) : '', needs_review: v.needs_review ? 1 : 0,
        printed_at: v.printed_at || '', printed_by: v.printed_by || '', print_count: v.print_count || 0, edit_count: 0,
        created_at: v.created_at, updated_at: v.updated_at || v.created_at, client_id: '' });
      added++;
    });
    return { added: added, total: table_('Volunteers').rows.length };
  });
  clearConfigCache_();
  props_().setProperty('IMPORT_CURSOR', '0');
  const more = importPhotosAndRemarks();
  return 'Imported ' + report.added + ' new registration(s); ' + report.total + ' in the Sheet now.\n' + more;
}

/** Step 2: photos (into the Drive folder) and each volunteer's remarks. Stops before Google's
    6-minute limit and schedules itself to continue, until everything is copied. */
function importPhotosAndRemarks() {
  const started = Date.now();
  const vps = vpsSession_();
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'importPhotosAndRemarks').forEach((t) => ScriptApp.deleteTrigger(t));
  _db = {};
  const todo = table_('Volunteers').rows.filter((v) => /^vps:/.test(v.photo || '')).sort((a, b) => a.id - b.id).map((v) => v.id);
  let done = 0;
  for (const id of todo) {
    if (Date.now() - started > 4.5 * 60e3) {
      ScriptApp.newTrigger('importPhotosAndRemarks').timeBased().after(60e3).create();
      return 'Copied ' + done + ' photo(s); ' + (todo.length - done) + ' left — continuing automatically in a minute.';
    }
    let detail = null, blob = null;
    try { detail = vps.get('volunteer', { id: id }).item; } catch (e) { /* deleted on the old site meanwhile */ }
    const path = (byId_('Volunteers', id) || {}).photo || '';
    try {
      const r = UrlFetchApp.fetch(vps.url + '/' + path.replace(/^vps:/, ''), { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) blob = r.getBlob();
    } catch (e) {}
    withLock_(() => {
      const v = byId_('Volunteers', id);
      if (!v) return;
      let photo = '';
      if (blob) {
        const file = photoFolder_().createFile(blob.setName(v.reg_no + '-' + path.split('/').pop()));
        try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
        photo = 'drive:' + file.getId();
      }
      update_('Volunteers', v, { photo: photo });
      ((detail && detail.remarks) || []).slice().reverse().forEach((r) => insert_('Remarks', { entity_type: 'volunteer', entity_id: id, body: r.body, author: r.author, created_at: r.created_at }));
    });
    done++;
  }
  refreshReadable();
  props_().deleteProperty('VPS_PASS'); props_().deleteProperty('VPS_USER');   // the old site's login is not kept
  return 'All photos and remarks copied (' + done + ' this round). The old site\'s login details have been removed from this script.';
}
/* Starting lists (loaded by setup). Edit them afterwards in the Sheet or the admin dashboard. */
const SEED = {"ashrams":[{"name":"Kokilamukh Saraswat Math (Main Math)","location":"Kokilamukh, Jorhat, Assam","i18n":{"or":"କୋକିଳାମୁଖ ସାରସ୍ୱତ ମଠ (ମୁଖ୍ୟ ମଠ)","hi":"कोकिलामुख सारस्वत मठ (मुख्य मठ)","bn":"কোকিলামুখ সারস্বত মঠ (মূল মঠ)","as":"কোকিলামুখ সাৰস্বত মঠ (মূল মঠ)"}},
{"name":"Purba Bangla Saraswat Ashram","location":"Dhwajanagar, Paschim Tripura","i18n":{"or":"ପୂର୍ବ ବଙ୍ଗ ସାରସ୍ୱତ ଆଶ୍ରମ","hi":"पूर्व बांग्ला सारस्वत आश्रम","bn":"পূর্ববাংলা সারস্বত আশ্রম","as":"পূৰ্ববংগ সাৰস্বত আশ্ৰম"}},
{"name":"Paschim Bangla Saraswat Ashram","location":"Kharkusma, Paschim Medinipur, WB","i18n":{"or":"ପଶ୍ଚିମ ବଙ୍ଗ ସାରସ୍ୱତ ଆଶ୍ରମ","hi":"पश्चिम बांग्ला सारस्वत आश्रम","bn":"পশ্চিমবাংলা সারস্বত আশ্রম","as":"পশ্চিমবংগ সাৰস্বত আশ্ৰম"}},
{"name":"Dakshin Bangla Saraswat Ashram","location":"Halisahar, North 24 Parganas, WB","i18n":{"or":"ଦକ୍ଷିଣ ବଙ୍ଗ ସାରସ୍ୱତ ଆଶ୍ରମ","hi":"दक्षिण बांग्ला सारस्वत आश्रम","bn":"দক্ষিণবাংলা সারস্বত আশ্রম","as":"দক্ষিণবংগ সাৰস্বত আশ্ৰম"}},
{"name":"Madhya Bangla Saraswat Ashram","location":"Purbasthali, Bardhaman, WB","i18n":{"or":"ମଧ୍ୟ ବଙ୍ଗ ସାରସ୍ୱତ ଆଶ୍ରମ","hi":"मध्य बांग्ला सारस्वत आश्रम","bn":"মধ্যবাংলা সারস্বত আশ্রম","as":"মধ্যবংগ সাৰস্বত আশ্ৰম"}},
{"name":"Sri Sri Nigamananda Saraswat Ashram, Ainkola","location":"Anandanagar, Ainkola, Paschim Medinipur, WB","i18n":{"or":"ଶ୍ରୀଶ୍ରୀ ନିଗମାନନ୍ଦ ସାରସ୍ୱତ ଆଶ୍ରମ, ଆଇନକୋଲା","hi":"श्रीश्री निगमानंद सारस्वत आश्रम, आइनकोला","bn":"শ্রীশ্রী নিগমানন্দ সারস্বত আশ্রম, আইনকোলা","as":"শ্ৰীশ্ৰী নিগমানন্দ সাৰস্বত আশ্ৰম, আইনকোলা"}},
{"name":"Sri Sri Nigamananda Saraswat Ashram, Manusmuria","location":"Manusmuria, East Singhbhum, Jharkhand","i18n":{"or":"ଶ୍ରୀଶ୍ରୀ ନିଗମାନନ୍ଦ ସାରସ୍ୱତ ଆଶ୍ରମ, ମନୁଷମୁରିଆ","hi":"श्रीश्री निगमानंद सारस्वत आश्रम, मनुसमुरिया","bn":"শ্রীশ্রী নিগমানন্দ সারস্বত আশ্রম, মনুষমুড়িয়া","as":"শ্ৰীশ্ৰী নিগমানন্দ সাৰস্বত আশ্ৰম, মনুষমুৰিয়া"}},
{"name":"Sri Nigamananda Sevashram, Adra","location":"Adra, Purulia, WB","i18n":{"or":"ଶ୍ରୀ ନିଗମାନନ୍ଦ ସେବାଶ୍ରମ, ଆଦ୍ରା","hi":"श्री निगमानंद सेवाश्रम, आद्रा","bn":"শ্রী নিগমানন্দ সেবাশ্রম, আদ্রা","as":"শ্ৰী নিগমানন্দ সেৱাশ্ৰম, আদ্ৰা"}},
{"name":"Bhubaneswar Saraswat Ashram","location":"Gautamnagar, Bhubaneswar, Odisha","i18n":{"or":"ଭୁବନେଶ୍ୱର ସାରସ୍ୱତ ଆଶ୍ରମ","hi":"भुवनेश्वर सारस्वत आश्रम","bn":"ভুবনেশ্বর সারস্বত আশ্রম","as":"ভুবনেশ্বৰ সাৰস্বত আশ্ৰম"}},
{"name":"Kadamkanta Saraswat Ashram","location":"Kendupatna, Cuttack, Odisha","i18n":{"or":"କଦମକଣ୍ଟା ସାରସ୍ୱତ ଆଶ୍ରମ","hi":"कदमकांटा सारस्वत आश्रम","bn":"কদমকান্টা সারস্বত আশ্রম","as":"কদমকাণ্টা সাৰস্বত আশ্ৰম"}},
{"name":"Sri Sri Nigamananda Saraswat Ashram, Puri","location":"Lokenath Road, Puri, Odisha","i18n":{"or":"ଶ୍ରୀଶ୍ରୀ ନିଗମାନନ୍ଦ ସାରସ୍ୱତ ଆଶ୍ରମ, ପୁରୀ","hi":"श्रीश्री निगमानंद सारस्वत आश्रम, पुरी","bn":"শ্রীশ্রী নিগমানন্দ সারস্বত আশ্রম, পুরী","as":"শ্ৰীশ্ৰী নিগমানন্দ সাৰস্বত আশ্ৰম, পুৰী"}},
{"name":"Sri Sri Nigamananda Saraswat Ashram, Garmur","location":"Garmur, Jorhat, Assam","i18n":{"or":"ଶ୍ରୀଶ୍ରୀ ନିଗମାନନ୍ଦ ସାରସ୍ୱତ ଆଶ୍ରମ, ଗଡ଼ମୁର","hi":"श्रीश्री निगमानंद सारस्वत आश्रम, गड़मुड़","bn":"শ্রীশ্রী নিগমানন্দ সারস্বত আশ্রম, গড়মুড়","as":"শ্ৰীশ্ৰী নিগমানন্দ সাৰস্বত আশ্ৰম, গড়মূৰ"}},
{"name":"Sri Sri Gurudham","location":"Kutabpur, Meherpur, Bangladesh","i18n":{"or":"ଶ୍ରୀଶ୍ରୀ ଗୁରୁଧାମ, କୁତବପୁର","hi":"श्रीश्री गुरुधाम, कुतबपुर","bn":"শ্রীশ্রী গুরুধাম, কুতবপুর","as":"শ্ৰীশ্ৰী গুৰুধাম, কুতবপুৰ"}},
{"name":"Uttar Bangla Saraswat Ashram","location":"Chelopara, Bogura, Bangladesh","i18n":{"or":"ଉତ୍ତର ବଙ୍ଗ ସାରସ୍ୱତ ଆଶ୍ରମ","hi":"उत्तर बांग्ला सारस्वत आश्रम","bn":"উত্তরবাংলা সারস্বত আশ্রম","as":"উত্তৰবংগ সাৰস্বত আশ্ৰম"}}],"sevas":[{"name":"Office","i18n":{"or":"କାର୍ଯ୍ୟାଳୟ","bn":"অফিস","hi":"कार्यालय","as":"কাৰ্যালয়"}},
{"name":"Enquiry","i18n":{"or":"ଅନୁସନ୍ଧାନ","bn":"অনুসন্ধান","hi":"पूछताछ","as":"অনুসন্ধান"}},
{"name":"Reception of Delegates","i18n":{"or":"ପ୍ରତିନିଧି ଅଭ୍ୟର୍ଥନା","bn":"প্রতিনিধি অভ্যর্থনা","hi":"प्रतिनिधि स्वागत","as":"প্ৰতিনিধি অভ্যৰ্থনা"}},
{"name":"Seva at Parking Place","i18n":{"or":"ପାର୍କିଂ ସ୍ଥାନରେ ସେବା","bn":"পার্কিং-এ সেবা","hi":"पार्किंग स्थल पर सेवा","as":"পাৰ্কিং স্থানত সেৱা"}},
{"name":"Camp Allotment","i18n":{"or":"ଶିବିର ଆବଣ୍ଟନ","bn":"শিবির বণ্টন","hi":"शिविर आवंटन","as":"শিবিৰ আবণ্টন"}},
{"name":"Delegate Counter","i18n":{"or":"ପ୍ରତିନିଧି କାଉଣ୍ଟର","bn":"প্রতিনিধি কাউন্টার","hi":"प्रतिनिधि काउंटर","as":"প্ৰতিনিধি কাউণ্টাৰ"}},
{"name":"Seva of Thakur Puja","i18n":{"or":"ଠାକୁର ପୂଜା ସେବା","bn":"ঠাকুর পূজার সেবা","hi":"ठाकुर पूजा सेवा","as":"ঠাকুৰ পূজাৰ সেৱা"}},
{"name":"Seva of Thakur Puja in Sabha Mancha","i18n":{"or":"ସଭା ମଞ୍ଚରେ ଠାକୁର ପୂଜା ସେବା","bn":"সভামঞ্চে ঠাকুর পূজার সেবা","hi":"सभा मंच पर ठाकुर पूजा सेवा","as":"সভামঞ্চত ঠাকুৰ পূজাৰ সেৱা"}},
{"name":"Adhibas Sobhayatra","i18n":{"or":"ଅଧିବାସ ଶୋଭାଯାତ୍ରା","bn":"অধিবাস শোভাযাত্রা","hi":"अधिवास शोभायात्रा","as":"অধিবাস শোভাযাত্ৰা"}},
{"name":"Maintenance of Discipline at Mancha","i18n":{"or":"ମଞ୍ଚରେ ଶୃଙ୍ଖଳା ରକ୍ଷା","bn":"মঞ্চে শৃঙ্খলা রক্ষা","hi":"मंच पर अनुशासन व्यवस्था","as":"মঞ্চত শৃংখলা ৰক্ষা"}},
{"name":"Maintenance of Discipline at Auditorium","i18n":{"or":"ପ୍ରେକ୍ଷାଳୟରେ ଶୃଙ୍ଖଳା ରକ୍ଷା","bn":"প্রেক্ষাগৃহে শৃঙ্খলা রক্ষা","hi":"सभागार में अनुशासन व्यवस्था","as":"প্ৰেক্ষাগৃহত শৃংখলা ৰক্ষা"}},
{"name":"Nama Yajnya","i18n":{"or":"ନାମ ଯଜ୍ଞ","bn":"নাম যজ্ঞ","hi":"नाम यज्ञ","as":"নাম যজ্ঞ"}},
{"name":"Sadhu Seva","i18n":{"or":"ସାଧୁ ସେବା","bn":"সাধু সেবা","hi":"साधु सेवा","as":"সাধু সেৱা"}},
{"name":"Chandan Charanasrita Seva","i18n":{"or":"ଚନ୍ଦନ ଚରଣାଶ୍ରିତ ସେବା","bn":"চন্দন চরণাশ্রিত সেবা","hi":"चंदन चरणाश्रित सेवा","as":"চন্দন চৰণাশ্ৰিত সেৱা"}},
{"name":"Supervision of Construction and Maintenance","i18n":{"or":"ନିର୍ମାଣ ଓ ରକ୍ଷଣାବେକ୍ଷଣ ତଦାରଖ","bn":"নির্মাণ ও রক্ষণাবেক্ষণ তত্ত্বাবধান","hi":"निर्माण एवं रखरखाव पर्यवेक्षण","as":"নিৰ্মাণ আৰু ৰক্ষণাবেক্ষণ তত্ত্বাৱধান"}},
{"name":"Night Duty","i18n":{"or":"ରାତ୍ରି ଡ୍ୟୁଟି","bn":"রাত্রিকালীন ডিউটি","hi":"रात्रि ड्यूटी","as":"নৈশ ডিউটি"}},
{"name":"Annapurna Bhandar Stores","i18n":{"or":"ଅନ୍ନପୂର୍ଣ୍ଣା ଭଣ୍ଡାର ଷ୍ଟୋର","bn":"অন্নপূর্ণা ভাণ্ডার স্টোর","hi":"अन्नपूर्णा भंडार स्टोर","as":"অন্নপূৰ্ণা ভঁৰাল ষ্ট’ৰ"}},
{"name":"Distribution of Prasad at Annapurna Bhandar","i18n":{"or":"ଅନ୍ନପୂର୍ଣ୍ଣା ଭଣ୍ଡାରରେ ପ୍ରସାଦ ବଣ୍ଟନ","bn":"অন্নপূর্ণা ভাণ্ডারে প্রসাদ বিতরণ","hi":"अन्नपूर्णा भंडार में प्रसाद वितरण","as":"অন্নপূৰ্ণা ভঁৰালত প্ৰসাদ বিতৰণ"}},
{"name":"Unloading at Annapurna Bhandar","i18n":{"or":"ଅନ୍ନପୂର୍ଣ୍ଣା ଭଣ୍ଡାରରେ ମାଲ ଓହ୍ଲାଇବା","bn":"অন্নপূর্ণা ভাণ্ডারে মাল নামানো","hi":"अन्नपूर्णा भंडार में माल उतारना","as":"অন্নপূৰ্ণা ভঁৰালত সামগ্ৰী নমোৱা"}},
{"name":"Utensil Cleaning at Annapurna Bhandar","i18n":{"or":"ଅନ୍ନପୂର୍ଣ୍ଣା ଭଣ୍ଡାରରେ ବାସନ ସଫା","bn":"অন্নপূর্ণা ভাণ্ডারে বাসন মাজা","hi":"अन्नपूर्णा भंडार में बर्तन सफाई","as":"অন্নপূৰ্ণা ভঁৰালত বাচন চাফা"}},
{"name":"Health Care","i18n":{"or":"ସ୍ୱାସ୍ଥ୍ୟ ସେବା","bn":"স্বাস্থ্য পরিষেবা","hi":"स्वास्थ्य सेवा","as":"স্বাস্থ্য সেৱা"}},
{"name":"Sanitation","i18n":{"or":"ପରିମଳ","bn":"পরিচ্ছন্নতা","hi":"स्वच्छता","as":"পৰিচ্ছন্নতা"}},
{"name":"Ananda Sabha","i18n":{"or":"ଆନନ୍ଦ ସଭା","bn":"আনন্দ সভা","hi":"आनंद सभा","as":"আনন্দ সভা"}},
{"name":"Shoe Stand & Mobile Charging","i18n":{"or":"ଜୋତା ଷ୍ଟାଣ୍ଡ ଓ ମୋବାଇଲ୍ ଚାର୍ଜିଂ","bn":"জুতো রাখার স্থান ও মোবাইল চার্জিং","hi":"जूता स्टैंड और मोबाइल चार्जिंग","as":"জোতা ষ্টেণ্ড আৰু ম’বাইল চাৰ্জিং"}}],"sadasyas":[["bs","Amalodaya Choudhury","Assam"],
["bs","Dipak Mandal","Assam"],
["bs","Shridam Mandal","Assam"],
["bs","Bikash Das","Assam"],
["bs","Apuram Sarkar","Tripura"],
["bs","Tushar Kumar Chowdhury","Khadakushma"],
["bs","Debi Prasad Niyogi","Khadakushma"],
["bs","Jyoti Dey","Halisahar"],
["bs","Subrata Das (Bapi)","Halisahar"],
["bs","Jaydeb Kar","Purbasthali"],
["bs","Nigam Prasad Mukherjee","Purbasthali"],
["bs","Rabindranath Roy","Jalpaiguri"],
["bs","Pulinchandra Roy","Nigamnagar"],
["bs","Kajal Roy","Nigamnagar"],
["bs","Asit Kumar Pal","Adra"],
["bs","Arindam Mishra","Adra"],
["bs","Bhaktipada Karmahapatra","Anandanagar"],
["bs","Ashish Maiti","Anandanagar"],
["bs","Anantadas Mahapatra","Anandanagar"],
["bs","Himadri Bhol (Sinha)","Manushmudia"],
["bs","Shibaram Acharya","Manushmudia"],
["bs","Sarat Kumar Mohanty","Kadamkanta"],
["bs","Dhirendra Narayan Satpathy","Kadamkanta"],
["bs","Ananta Kumar Pradhan","Kadamkanta"],
["bs","Binod Bihari Swain","Kadamkanta"],
["bs","Nigam Prasad Nayak","Bhubaneswar"],
["bs","Ashok Kumar Padhi","Bhubaneswar"],
["bs","Gurubrasad Samant","Bhubaneswar"],
["bs","Nimai Charan Sahu","Bhubaneswar"],
["bs","Bhubaneswar Tripathy","Puri"],
["bs","Nalinikanta Tarasia","Puri"],
["bs","Suresh Chandra Sahu","Puri"],
["bs","Suresh Tripathy","Vrindavan"],
["bs","Ghanashyam Das (retd. Group Captain)","Vrindavan"],
["zs","Anandaram Dasa","Assam"],
["zs","Bibhananda Das","Assam"],
["zs","Dulalchandra Saha","Assam"],
["zs","Samar De","Assam"],
["zs","Tapan Kumar Majumdar","Assam"],
["zs","Shankar Debnath","Assam"],
["zs","Niranjan Choudhury","Assam"],
["zs","Balaram Biswas","Assam"],
["zs","Debesh Chakraborty","Assam"],
["zs","Siddharshi Paul Choudhury","Assam"],
["zs","Anathabandhu Goswami","Assam"],
["zs","Prajit Kanti Bhattacharya","Assam"],
["zs","Naresh Barman","Assam"],
["zs","Sanjay Nath","Assam"],
["zs","Gurupada Chakraborty","Assam"],
["zs","Mana Acharya","Assam"],
["zs","Phulranjan Roy","Assam"],
["zs","Sunil Das","Assam"],
["zs","Pannalal Purkayastha","Assam"],
["zs","Dhiraj Sharma","Assam"],
["zs","Dilip Kumar Dutta","Assam"],
["zs","Chandrakanta Sarkar","Assam"],
["zs","Jagadish Sharma","Assam"],
["zs","Tusta Mohan Mandal","Assam"],
["zs","Pravat Ray","Assam"],
["zs","Subrata Majumdar","Assam"],
["zs","Tapan Pal","Assam"],
["zs","Gunendra Chandra Das","Assam"],
["zs","Gouranga Sarkar","Assam"],
["zs","Babul Saha","Assam"],
["zs","Sushil Chakraborty","Assam"],
["zs","Ganesh Mandal","Assam"],
["zs","Shibendra Kuri","Assam"],
["zs","Anil Kumar Das","Assam"],
["zs","Kshitish Chandra Nath","Assam"],
["zs","Dhanaram Adhikari","Assam"],
["zs","Dipankar Dey","Tripura"],
["zs","Samiran Dey (Subhash)","Tripura"],
["zs","Abhimanyu Debnath","Tripura"],
["zs","Amulya Chandra Seal","Tripura"],
["zs","Himangshu Majumdar","Tripura"],
["zs","Ranbir Modak","Tripura"],
["zs","Subrata Sharma","Tripura"],
["zs","Ratan Chandra Sarkar","Tripura"],
["zs","Nikhil Badal","Halisahar"],
["zs","Gopimohan Das","Halisahar"],
["zs","Rabindranath Kodal","Halisahar"],
["zs","Mrinmoy Chowdhury","Halisahar"],
["zs","Ujjwal Singha","Halisahar"],
["zs","Chaitanya Charan Maity","Halisahar"],
["zs","Pabitra Mandal","Halisahar"],
["zs","Shyamsundar Mandal","Halisahar"],
["zs","Biman Ghosh","Halisahar"],
["zs","Mukta Pal","Halisahar"],
["zs","Dinabandhu Bairagi","Halisahar"],
["zs","Nishikanta Halder","Halisahar"],
["zs","Dulal Halder","Halisahar"],
["zs","Shyamal Banerjee","Purbasthali"],
["zs","Bishwanath Roy","Purbasthali"],
["zs","Nilratan Chakraborty","Purbasthali"],
["zs","Ashutosh Mukhopadhyay","Purbasthali"],
["zs","Sanat Kumar Gayen","Purbasthali"],
["zs","Manoj Bhakat","Purbasthali"],
["zs","Swadhin Singha","Purbasthali"],
["zs","Dr. Barun Das","Purbasthali"],
["zs","Ranjit Sarkar","Purbasthali"],
["zs","Shyamchand Mandal","Purbasthali"],
["zs","Shyamal Chakraborty","Purbasthali"],
["zs","Ashok Sarkar","Purbasthali"],
["zs","Jayanta Sahana","Khadakushma"],
["zs","Sandip Pal","Khadakushma"],
["zs","Hemkanti Rakshit","Khadakushma"],
["zs","Debiprasad Chatterjee","Khadakushma"],
["zs","Ashok Midya","Khadakushma"],
["zs","Kaushik Chatterjee (Rana)","Khadakushma"],
["zs","Birendranath Ghosh","Khadakushma"],
["zs","Rajib Nayek","Khadakushma"],
["zs","Arindam Roy","Khadakushma"],
["zs","Tapan Biswas","Khadakushma"],
["zs","Gunakar Nandi","Khadakushma"],
["zs","Sunilbaran Goswami","Khadakushma"],
["zs","Suprabhat Niyogi","Khadakushma"],
["zs","Ranjit Kumar Mandal","Khadakushma"],
["zs","Amar Nath Majumdar","Khadakushma"],
["zs","Asit Kumar Pan","Khadakushma"],
["zs","Arabinda Ghosh","Khadakushma"],
["zs","Banamali Shasmal","Khadakushma"],
["zs","Ardhendu Kumar Roy (Bapi)","Khadakushma"],
["zs","Subhash Pan","Khadakushma"],
["zs","Ashok Kumar Roy","Khadakushma"],
["zs","Kajal Roy","Khadakushma"],
["zs","Birendranath Majhi","Khadakushma"],
["zs","Jaydeb Sau","Khadakushma"],
["zs","Chittaranjan Das","Khadakushma"],
["zs","Sunil Kumar Mudli","Khadakushma"],
["zs","Dilip Dalai","Khadakushma"],
["zs","Shubhendu Ghosh","Khadakushma"],
["zs","Ratan Pathar","Khadakushma"],
["zs","Ananta Dutta","Khadakushma"],
["zs","Bamadeb Guchhait","Khadakushma"],
["zs","Chandrakanta Roy","Khadakushma"],
["zs","Bhaskar Koyal","Khadakushma"],
["zs","Kalyan Mukhopadhyay","Adra"],
["zs","Rajib Kumar Chakraborty","Adra"],
["zs","Biswanath Gop","Adra"],
["zs","Madhusudan Pramanik","Adra"],
["zs","Pabitra Bauri","Adra"],
["zs","Manpuran Mahato","Adra"],
["zs","Arjun Mahato","Adra"],
["zs","Subhash Chandra Goap","Adra"],
["zs","Bibekananda Das","Adra"],
["zs","Durgadas Garai","Adra"],
["zs","Rajesh Laha","Adra"],
["zs","Chinibas Mahato","Adra"],
["zs","Harekrishna Mahato","Adra"],
["zs","Alok Pal","Adra"],
["zs","Chandan Dandapat","Adra"],
["zs","Jasthi Pada Majhi","Adra"],
["zs","Balailal Kar","Anandanagar"],
["zs","Bhaskar Patra","Anandanagar"],
["zs","Kanailal Maity","Anandanagar"],
["zs","Arabinda Patra","Anandanagar"],
["zs","Bhabashankar Mahanti","Anandanagar"],
["zs","Narayan Jana","Anandanagar"],
["zs","Bijay Pradhan","Anandanagar"],
["zs","Kishori Pradhan","Anandanagar"],
["zs","Manindra Singha","Anandanagar"],
["zs","Rajani Dey","Anandanagar"],
["zs","Subrata Mohapatra","Anandanagar"],
["zs","Susanta Tripathy","Anandanagar"],
["zs","Yugajit Das","Anandanagar"],
["zs","Sushanta Panigrahi","Anandanagar"],
["zs","Shambhunath Das","Anandanagar"],
["zs","Debasish Banerjee","Anandanagar"],
["zs","Ashish Kumar Panda","Anandanagar"],
["zs","Narayan Chandra Maidi","Anandanagar"],
["zs","Kedar Chandra Bera","Anandanagar"],
["zs","Shyamsundar Maity","Anandanagar"],
["zs","Nirod Chandra Ray","Jalpaiguri"],
["zs","Ratan Bablu","Jalpaiguri"],
["zs","Kamalakanta Ray","Jalpaiguri"],
["zs","Dhananjay Ray","Jalpaiguri"],
["zs","Dibyendu Ghosh","Jalpaiguri"],
["zs","Dhirendranath Debsharma","Jalpaiguri"],
["zs","Pradip Ray Dakua (Dip)","Jalpaiguri"],
["zs","Ratikanta Ray","Jalpaiguri"],
["zs","Raja Bakshi","Jalpaiguri"],
["zs","Shantanu Dasgupta","Jalpaiguri"],
["zs","Karuna Ranjan Singha","Jalpaiguri"],
["zs","Dharanikanta Singh","Jalpaiguri"],
["zs","Krushnapada Barman","Jalpaiguri"],
["zs","Mahesh Chandra Mahanta","Jalpaiguri"],
["zs","Subhash Chandra Ray","Jalpaiguri"],
["zs","Dinesh Sarkar","Jalpaiguri"],
["zs","Madhu Roy","Jalpaiguri"],
["zs","Brahmapada Roy","Jalpaiguri"],
["zs","Ajitesh Chowdhury","Nigamnagar"],
["zs","Guneshwar Roy","Nigamnagar"],
["zs","Susen Barman","Nigamnagar"],
["zs","Khagendranath Roy","Nigamnagar"],
["zs","Sukantha Barman","Nigamnagar"],
["zs","Jogesh Chandra Barman","Nigamnagar"],
["zs","Jagadish Barman","Nigamnagar"],
["zs","Bhadramohan Barman","Nigamnagar"],
["zs","Ananta Kumar Roy","Nigamnagar"],
["zs","Nalini Debnath","Nigamnagar"],
["zs","Bimal Chandra Das","Nigamnagar"],
["zs","Jagannath Mohapatra","Puri"],
["zs","Jagannath Behera","Puri"],
["zs","Laxmidhar Mohapatra","Puri"],
["zs","Govindachandra Mohanty","Puri"],
["zs","Prasanta Kumar Bishoi","Puri"],
["zs","Lingaraj Sahu","Puri"],
["zs","Harihar Sahu","Puri"],
["zs","Gautam Pradhan","Puri"],
["zs","Umakanta Pattanaik","Puri"],
["zs","Banshidhar Nahak","Puri"],
["zs","Balaram Dora","Puri"],
["zs","Prashanta Kumar Bebarta","Puri"],
["zs","Prasanna Kumar Nayak","Puri"],
["zs","Sebananda Mohapatra","Puri"],
["zs","Radhamadhab Rath","Puri"],
["zs","Ajit Kumar Panda","Puri"],
["zs","Pradip Kumar Sahu","Puri"],
["zs","Madhusudan Sahu","Puri"],
["zs","Dilip Kumar Panigrahi","Puri"],
["zs","Biswamitra Mohapatra","Puri"],
["zs","Gurucharan Ojha","Bhubaneswar"],
["zs","Debaraj Barik","Bhubaneswar"],
["zs","Sudhira Chandra Nathasharma","Bhubaneswar"],
["zs","Rabindra Kumar Behera","Bhubaneswar"],
["zs","Dharmendra Samantaray","Bhubaneswar"],
["zs","Kshetramohan Swain","Bhubaneswar"],
["zs","Dr. Premananda Pattanaik","Bhubaneswar"],
["zs","Bishnu Charan Swain","Bhubaneswar"],
["zs","Kunjabihari Sahu","Bhubaneswar"],
["zs","Pratap Kumar Sahu","Bhubaneswar"],
["zs","Biranchi Sahu","Bhubaneswar"],
["zs","Tanmaya Prakash Khuntia","Bhubaneswar"],
["zs","Duryodhan Behera","Bhubaneswar"],
["zs","Naresh Chandra Sahu","Bhubaneswar"],
["zs","Trilochan Nayak","Bhubaneswar"],
["zs","Dushmanta Kumar Pallai","Bhubaneswar"],
["zs","Manoj Kar","Bhubaneswar"],
["zs","Tapan Kumar Satpathy","Bhubaneswar"],
["zs","Gautam Nayak","Bhubaneswar"],
["zs","Basanta Kumar Sahu","Kadamkanta"],
["zs","Pabitra Mahapatra","Kadamkanta"],
["zs","Bhaktabandhu Mishra","Kadamkanta"],
["zs","Saroj Kumar Kar","Kadamkanta"],
["zs","Lingaraj Khuntia","Kadamkanta"],
["zs","Shyamasundar Sahu (Advocate)","Kadamkanta"],
["zs","Nimai Charan Raut","Kadamkanta"],
["zs","Jayanta Kumar Pal","Kadamkanta"],
["zs","Muralidhar Samal","Kadamkanta"],
["zs","Ganesh Chandra Mallik","Kadamkanta"],
["zs","Abhimanyu Gochhayat","Kadamkanta"],
["zs","Dilip Lenka","Kadamkanta"],
["zs","Alok Biswal","Kadamkanta"],
["zs","Abhimanyu Raut","Kadamkanta"],
["zs","Kailash Chandra Sendh","Kadamkanta"],
["zs","Parasuram Ojha","Kadamkanta"],
["zs","Akshaya Kumar Panda","Kadamkanta"],
["zs","Bijay Kumar Panda","Kadamkanta"],
["zs","Upendra Panda","Kadamkanta"],
["zs","Benudhar Jena","Kadamkanta"],
["zs","Gopalkrishna Jena","Kadamkanta"],
["zs","Jatin Nath Jena","Kadamkanta"],
["zs","Debadatta Mohanty","Kadamkanta"],
["zs","Chakradhar Biswal","Kadamkanta"],
["zs","Ramakrishna Jena","Kadamkanta"],
["zs","Ratikanta Patra","Kadamkanta"],
["zs","Gurudatta Prusti","Kadamkanta"],
["zs","Shashankashekhar Das","Manushmudia"],
["zs","Gurudas Biswas","Manushmudia"],
["zs","Anand Bhol","Manushmudia"],
["zs","Pradip Dutta","Manushmudia"],
["zs","Shibashankar Sadhu","Manushmudia"],
["zs","Piyush Kumar Pradhan","Manushmudia"],
["zs","Gurupada Singh Sardar","Manushmudia"],
["zs","Dilip Pal","Manushmudia"],
["zs","Ramchandra Rawani","Manushmudia"],
["zs","Dr. Lalji","Manushmudia"],
["zs","Shushanta Biswas","Vrindavan"],
["zs","Yashpal Kadaila","Vrindavan"],
["zs","Hem Prasad Ghosh","Vrindavan"],
["zs","Dr. N.C. Debnath","Vrindavan"],
["zs","K. Keshab Rao Patra","Vrindavan"],
["zs","Triveni Bhai","Vrindavan"]]};
