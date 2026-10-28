import { LANGS, t, setLang, getLang, applyI18n, sanghaName, langInfo } from './i18n.js';
import { apiGet, apiPost, assetUrl, ApiError, setToken, getToken } from './api.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = { sanghas: [], sevas: [], lsanghas: [], bs: [], zs: [], items: [], selected: new Set(), tab: 'volunteers', openSanghas: new Set(), me: null };
const F = { q: '', sangha: '', lsangha: '', seva: '', bs: '', zs: '', group: '', printed: '', gender: '', lang: '', age_min: '', age_max: '', leaders: false, review: false };
/** What the logged-in person's role allows (Admins tab in the Sheet): view, edit, print, lists, delete */
const can = (perm) => !!(S.me && S.me.can && S.me.can.includes(perm));

init();

async function init() {
  setLang(getLang());
  const ls = $('#lang-select');
  ls.innerHTML = LANGS.map((l) => `<option value="${l.code}" style="color:#2A1F1A">${l.native}</option>`).join('');
  ls.value = getLang();
  ls.addEventListener('change', () => { setLang(ls.value); applyI18n(); renderAll(); });
  applyI18n();

  $('#login-form').addEventListener('submit', onLogin);
  $('#logout-btn').addEventListener('click', () => { setToken(''); location.reload(); });
  $$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  wireFilters();
  wireBulk();
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-bg').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  $('#add-sangha-form').addEventListener('submit', onAddSangha);
  wirePrint();

  const me = getToken() ? await apiGet('me').catch(() => ({ ok: false })) : { ok: false };
  if (me.ok) enterDashboard(me); else { setToken(''); showLogin(); }
}

function showLogin() { $('#login-screen').hidden = false; $('#dash').hidden = true; $('#l-user').focus(); }

async function onLogin(e) {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    const r = await apiPost('login', { username: $('#l-user').value.trim(), password: $('#l-pass').value });
    setToken(r.token);
    enterDashboard(r);
  } catch (err) { $('#login-err').textContent = err.status === 401 ? t('wrong_login') : (err.message || t('error_generic')); }
}

async function enterDashboard(me) {
  S.me = me;
  ['edit', 'print', 'lists', 'delete'].forEach((p) => document.body.classList.toggle('can-' + p, can(p)));
  $('#login-screen').hidden = true; $('#dash').hidden = false; $('#logout-btn').hidden = false;
  const who = $('#who'); who.hidden = false;
  who.textContent = `${me.user} · ${t('role_' + me.role)}${me.scope_name ? ' · ' + me.scope_name : ''}`;
  await refresh();
}

async function refresh() {
  await loadStructure();
  fillFilterSelects();
  await loadVolunteers();
  if (S.tab === 'groups') renderGroups();
  if (S.tab === 'dups') renderDups();
  if (S.tab === 'lists') renderLists();
}
function renderAll() { fillFilterSelects(); renderStats(S.stats); renderTable(); renderGroups(); if (S.tab === 'dups') renderDups(); if (S.tab === 'lists') renderLists(); if (!$('#drawer').hidden && S.drawerId) openVolunteer(S.drawerId); }

/* ---------------- data ---------------- */
async function loadStructure() {   // one call: ashrams & groups, all lists, numbers
  const d = await apiGet('admin_bootstrap');
  S.sanghas = d.sanghas; S.sevas = d.lists.seva; S.lsanghas = d.lists.sangha; S.bs = d.lists.bs; S.zs = d.lists.zs;
  S.stats = d.stats; renderStats(S.stats);
}
const optName = (o) => (o && ((o.name_i18n && o.name_i18n[getLang()]) || o.name)) || '';
/** Label for a volunteer's list answer: the list name, or the words they typed for "Other". */
function answer(v, kind) {
  if (kind === 'ashram') return v.sangha_id ? esc(sanghaName({ name: v.sangha_name, name_i18n: v.sangha_i18n })) : (v.ashram_other ? `<i class="typed">${esc(v.ashram_other)}</i>` : '');
  if (kind === 'sangha') return v.lsangha_id ? esc(optName({ name: v.lsangha_name, name_i18n: v.lsangha_i18n })) : (v.lsangha_other ? `<i class="typed">${esc(v.lsangha_other)}</i>` : '');
  if (kind === 'bs' || kind === 'zs') return v[kind + '_id'] ? esc(v[kind + '_name']) + (v[kind + '_area'] ? ` <span class="muted small">(${esc(v[kind + '_area'])})</span>` : '') : (v[kind + '_other'] ? `<i class="typed">${esc(v[kind + '_other'])}</i>` : '');
  return v.seva_id ? esc(optName({ name: v.seva_name, name_i18n: v.seva_i18n })) : (v.seva_other ? `<i class="typed">${esc(v.seva_other)}</i>` : '');
}
// text of an HTML snippet, parsed in an inert document (no scripts, no image loads)
const plain = (html) => new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
async function loadStats() { S.stats = await apiGet('stats'); renderStats(S.stats); }
async function loadVolunteers() {
  const r = await apiGet('volunteers', F);
  S.items = r.items;
  S.selected = new Set([...S.selected].filter((id) => S.items.some((v) => v.id === id)));
  renderTable();
}
const allGroups = () => S.sanghas.flatMap((s) => s.groups.map((g) => ({ ...g, sangha: s })));
const sanghaById = (id) => S.sanghas.find((s) => s.id === id);

/* ---------------- stats ---------------- */
function renderStats(st) {
  if (!st) return;
  const tiles = [
    ['stat_total', st.total, null],
    ['stat_today', st.today, null],
    ['stat_unassigned', st.unassigned, () => { resetFilters(); F.group = 'none'; syncFilterInputs(); switchTab('volunteers'); loadVolunteers(); }],
    ['stat_groups', st.groups, () => switchTab('groups')],
    ['stat_no_leader', st.groups_without_leader, () => switchTab('groups')],
    ['stat_review', st.needs_review, () => { resetFilters(); F.review = true; syncFilterInputs(); switchTab('volunteers'); loadVolunteers(); }],
    ['stat_printed', `${st.printed} / ${st.total}`, () => { resetFilters(); F.printed = 'no'; syncFilterInputs(); switchTab('volunteers'); loadVolunteers(); }],
    ['stat_dups', st.duplicates, () => switchTab('dups')],
    ['stat_reprint', st.edited_after_print, () => { resetFilters(); F.printed = 'changed'; syncFilterInputs(); switchTab('volunteers'); loadVolunteers(); }],
  ];
  $('#dup-count').textContent = st.duplicates ? `(${st.duplicates})` : '';
  $('#stats').innerHTML = '';
  tiles.forEach(([k, n, fn]) => {
    const el = document.createElement(fn ? 'button' : 'div');
    el.className = 'stat' + (['stat_no_leader', 'stat_review', 'stat_unassigned', 'stat_dups', 'stat_reprint'].includes(k) && n > 0 ? ' alert' : '');
    el.innerHTML = `<div class="num">${n}</div><div class="lbl">${t(k)}</div>`;
    if (fn) el.addEventListener('click', fn);
    $('#stats').appendChild(el);
  });
}

/* ---------------- filters ---------------- */
function wireFilters() {
  const bind = (id, key, ev = 'change', debounceMs = 0) => {
    let h;
    $(id).addEventListener(ev, (e) => {
      F[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim();
      if (key === 'sangha') { F.group = ''; fillGroupFilter(); }
      clearTimeout(h); h = setTimeout(loadVolunteers, debounceMs);
    });
  };
  bind('#f-q', 'q', 'input', 250);
  bind('#f-sangha', 'sangha'); bind('#f-lsangha', 'lsangha'); bind('#f-seva', 'seva'); bind('#f-bs', 'bs'); bind('#f-zs', 'zs'); bind('#f-printed', 'printed'); bind('#f-group', 'group'); bind('#f-gender', 'gender'); bind('#f-lang', 'lang');
  bind('#f-amin', 'age_min', 'input', 400); bind('#f-amax', 'age_max', 'input', 400);
  bind('#f-leaders', 'leaders'); bind('#f-review', 'review');
  $('#f-clear').addEventListener('click', () => { resetFilters(); syncFilterInputs(); loadVolunteers(); });
  $('#export-btn').addEventListener('click', exportCsv);
}
function resetFilters() { Object.keys(F).forEach((k) => { F[k] = typeof F[k] === 'boolean' ? false : ''; }); }
function syncFilterInputs() {
  $('#f-q').value = F.q; $('#f-sangha').value = F.sangha; $('#f-lsangha').value = F.lsangha; $('#f-seva').value = F.seva; $('#f-bs').value = F.bs; $('#f-zs').value = F.zs; $('#f-printed').value = F.printed; fillGroupFilter(); $('#f-group').value = F.group;
  $('#f-gender').value = F.gender; $('#f-lang').value = F.lang; $('#f-amin').value = F.age_min; $('#f-amax').value = F.age_max;
  $('#f-leaders').checked = F.leaders; $('#f-review').checked = F.review;
}
function fillFilterSelects() {
  const sorted = [...S.sanghas].sort((a, b) => sanghaName(a).localeCompare(sanghaName(b)));
  const typed = `<option value="other">— ${t('typed_other')} —</option>`;
  $('#f-sangha').innerHTML = `<option value="">${t('all_sanghas')}</option>` + sorted.map((s) => `<option value="${s.id}">${esc(sanghaName(s))}</option>`).join('') + typed;
  $('#f-sangha').value = F.sangha;
  $('#f-lsangha').innerHTML = `<option value="">${t('all_lsanghas')}</option>` + S.lsanghas.map((o) => `<option value="${o.id}">${esc(optName(o))}</option>`).join('') + typed;
  $('#f-lsangha').value = F.lsangha;
  $('#f-seva').innerHTML = `<option value="">${t('all_sevas')}</option>` + S.sevas.map((o) => `<option value="${o.id}">${esc(optName(o))}</option>`).join('') + typed;
  $('#f-seva').value = F.seva;
  const ref = (k, all) => `<option value="">${t(all)}</option><option value="none">— ${t('ref_none')} —</option>` + S[k].map((o) => `<option value="${o.id}">${esc(o.name)}${o.location ? ' · ' + esc(o.location) : ''}</option>`).join('') + typed;
  $('#f-bs').innerHTML = ref('bs', 'all_bs'); $('#f-bs').value = F.bs;
  $('#f-zs').innerHTML = ref('zs', 'all_zs'); $('#f-zs').value = F.zs;
  $('#f-printed').innerHTML = `<option value="">${t('any_print')}</option><option value="yes">${t('printed')}</option><option value="no">${t('not_printed')}</option><option value="changed">${t('changed_after_print')}</option>`;
  $('#f-printed').value = F.printed;
  fillGroupFilter();
  $('#f-gender').innerHTML = `<option value="">${t('all_genders')}</option>` + ['Male', 'Female'].map((g) => `<option value="${g}">${t(g)}</option>`).join('');
  $('#f-gender').value = F.gender;
  $('#f-lang').innerHTML = `<option value="">${t('all_languages')}</option>` + LANGS.map((l) => `<option value="${l.code}">${l.native}</option>`).join('');
  $('#f-lang').value = F.lang;
  fillBulkGroups();
}
function fillGroupFilter() {
  const groups = allGroups().filter((g) => !F.sangha || g.sangha_id === +F.sangha);
  $('#f-group').innerHTML = `<option value="">${t('all_groups')}</option><option value="none">— ${t('no_group')} —</option>` +
    groups.map((g) => `<option value="${g.id}">${esc(g.name)}${F.sangha ? '' : ' · ' + esc(sanghaName(g.sangha))}</option>`).join('');
  $('#f-group').value = F.group;
}

/* ---------------- table ---------------- */
function initials(name) { return esc(String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()); }
function avatar(v, cls = 'avatar') {
  return v.photo ? `<img class="${cls}" src="${esc(assetUrl(v.photo))}" alt="" loading="lazy">` : `<span class="${cls}">${initials(v.name)}</span>`;
}
const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString(getLang() + '-IN', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(getLang() + '-IN', { hour: '2-digit', minute: '2-digit' });
};

function renderTable() {
  const body = $('#vol-body');
  $('#result-count').textContent = `${S.items.length} ${t('results')}`;
  $('#vol-empty').hidden = S.items.length > 0;
  body.innerHTML = S.items.map((v) => `
    <tr data-id="${v.id}">
      <td class="cb"><input type="checkbox" data-sel="${v.id}" ${S.selected.has(v.id) ? 'checked' : ''} aria-label="select"></td>
      <td><div class="person">${avatar(v)}<div><div class="nm">${esc(v.name)} ${v.is_leader ? `<span class="badge leader">★ ${t('team_leader')}</span>` : ''} ${v.needs_review ? `<span class="badge review">${t('review_only')}</span>` : ''} ${v.printed_at ? `<span class="badge printed" title="${fmtDate(v.printed_at)}">🖨 ${t('printed')}</span>` : ''} ${v.changed_after_print ? `<span class="badge review">✎ ${t('changed_after_print')}</span>` : ''}</div>
        <div class="sub">${esc(v.reg_no || '')} · ${v.gender ? t(v.gender) : ''}${v.original && v.original.name ? ' · ' + esc(v.original.name) : ''}</div></div></div></td>
      <td>${answer(v, 'ashram')}${v.lsangha_id || v.lsangha_other ? `<div class="sub small">${answer(v, 'sangha')}</div>` : ''}</td>
      <td>${answer(v, 'seva')}${v.bs_id || v.bs_other || v.zs_id || v.zs_other ? `<div class="sub small">${t('reference_short')}: ${[answer(v, 'bs'), answer(v, 'zs')].filter(Boolean).join(', ')}</div>` : ''}</td>
      <td>${v.group_name ? esc(v.group_name) : `<span class="badge none">${t('no_group')}</span>`}</td>
      <td>${v.age ?? ''}</td>
      <td class="nowrap"><a href="tel:+91${esc(v.mobile)}" class="tel-link">${esc(v.mobile)}</a></td>
      <td><span class="badge lang">${langInfo(v.language).native}</span></td>
      <td class="nowrap muted small">${fmtDate(v.created_at)}</td>
    </tr>`).join('');
  $$('tr[data-id]', body).forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.matches('input[type=checkbox]') || e.target.closest('.tel-link')) return;
    openVolunteer(+tr.dataset.id);
  }));
  $$('[data-sel]', body).forEach((cb) => cb.addEventListener('change', () => {
    const id = +cb.dataset.sel; cb.checked ? S.selected.add(id) : S.selected.delete(id); renderBulk();
  }));
  $('#check-all').checked = S.items.length > 0 && S.items.every((v) => S.selected.has(v.id));
  renderBulk();
}

/* ---------------- bulk ---------------- */
function wireBulk() {
  $('#check-all').addEventListener('change', (e) => {
    S.items.forEach((v) => (e.target.checked ? S.selected.add(v.id) : S.selected.delete(v.id)));
    renderTable();
  });
  $('#bulk-group').addEventListener('change', async (e) => {
    const gid = +e.target.value; if (!gid) return;
    await apiPost('assign', { ids: [...S.selected], group_id: gid });
    S.selected.clear(); toast(t('saved')); await refresh();
  });
  $('#bulk-print').addEventListener('click', () => openPrint(S.items.filter((v) => S.selected.has(v.id))));
  $('#bulk-remove').addEventListener('click', async () => {
    await apiPost('assign', { ids: [...S.selected], group_id: null });
    S.selected.clear(); toast(t('saved')); await refresh();
  });
}
function groupOptions(filterSanghaId = null) {
  return S.sanghas.filter((s) => s.groups.length && (!filterSanghaId || s.id === filterSanghaId))
    .map((s) => `<optgroup label="${esc(sanghaName(s))}">${s.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</optgroup>`).join('');
}
function fillBulkGroups() { $('#bulk-group').innerHTML = `<option value="">${t('add_to_group')}</option>` + groupOptions(); }
function renderBulk() {
  $('#bulkbar').hidden = S.selected.size === 0;
  $('#bulk-count').textContent = `${S.selected.size} ${t('selected')}`;
  $('#bulk-group').value = '';
}

/* ---------------- drawer: volunteer ---------------- */
async function openVolunteer(id) {
  S.drawerId = id;
  const { item: v } = await apiGet('volunteer', { id });
  const s = sanghaById(v.sangha_id);
  const ledGroup = allGroups().find((g) => g.leader_id === v.id);
  const body = $('#drawer-body');
  body.innerHTML = `
    <div class="profile">
      <div class="ph">${v.photo ? `<img src="${esc(assetUrl(v.photo))}" alt="">` : initials(v.name)}</div>
      <div>
        <h2>${esc(v.name)}</h2>
        ${v.original && v.original.name ? `<div class="muted">${esc(v.original.name)}</div>` : ''}
        <div style="margin:6px 0">${v.is_leader ? `<span class="badge leader">★ ${t('team_leader')}${ledGroup ? ' · ' + esc(ledGroup.name) : ''}</span>` : ''}
          ${v.needs_review ? `<span class="badge review">${t('review_only')}</span>` : ''}</div>
        <div class="muted small">${esc(v.reg_no)} · ${t('registered_on')} ${fmtDate(v.created_at)}</div>
        ${v.printed_at ? `<div class="small printed-line">🖨 ${t('printed_on')}: ${fmtDate(v.printed_at)}${v.printed_by ? ' · ' + esc(v.printed_by) : ''}${v.print_count > 1 ? ` · ${v.print_count}×` : ''}<span data-need="print"> · <button type="button" class="link-btn" id="d-unprint">${t('mark_not_printed')}</button></span></div>` : ''}
        ${v.edited_at ? `<div class="small ${v.changed_after_print ? 'warn-line' : 'muted'}">✎ ${t('edited')}: ${fmtDate(v.edited_at)}${v.changed_after_print ? ' · ' + t('changed_after_print') : ''}</div>` : ''}
        <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
          <button type="button" class="btn primary small" id="d-print" data-need="print">🖨 ${t('print_card')}</button>
          <a class="btn ghost small" href="tel:+91${esc(v.mobile)}">📞 ${t('call')}</a>
          <a class="btn ghost small" target="_blank" rel="noopener" href="https://wa.me/91${esc(v.whatsapp || v.mobile)}">WhatsApp</a>
        </div>
      </div>
    </div>

    <div class="card" data-need="edit">
      <div class="section-title" style="margin-top:0">${t('group')}</div>
      <div class="edit-grid">
        <div class="full"><select id="d-group"><option value="">— ${t('no_group')} —</option>${groupOptions(v.sangha_id)}</select></div>
        <label class="check full" ${v.group_id ? '' : 'hidden'} id="d-leader-wrap"><input type="checkbox" id="d-leader" ${v.is_leader && ledGroup && ledGroup.id === v.group_id ? 'checked' : ''}> ${t('make_leader')}</label>
      </div>
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0">${t('edit')}</div>
      <form id="d-form"><fieldset class="edit-grid" ${can('edit') ? '' : 'disabled'}>
        <div class="full"><label>${t('name')}</label><input name="name" value="${esc(v.name)}"></div>
        <div><label>${t('age')}</label><input name="age" inputmode="numeric" value="${esc(v.age)}"></div>
        <div><label>${t('gender')}</label><select name="gender">${['Male', 'Female'].map((g) => `<option value="${g}" ${v.gender === g ? 'selected' : ''}>${t(g)}</option>`).join('')}</select></div>
        <div><label>${t('mobile')}</label><input name="mobile" value="${esc(v.mobile)}"></div>
        <div><label>${t('whatsapp')}</label><input name="whatsapp" value="${esc(v.whatsapp)}"></div>
        <div class="full"><label>${t('email')}</label><input name="email" value="${esc(v.email)}"></div>
        <div class="full"><label>${t('sangha')}</label>
          <select name="sangha_id">${S.sanghas.map((x) => `<option value="${x.id}" ${x.id === v.sangha_id ? 'selected' : ''}>${esc(sanghaName(x))}</option>`).join('')}<option value="other" ${!v.sangha_id ? 'selected' : ''}>${t('other_label')} …</option></select>
          <input name="ashram_other" class="other-input" placeholder="${t('other_type')}" value="${esc(v.ashram_other || '')}" ${v.sangha_id ? 'hidden' : ''}>
          ${v.original && v.original.ashram_other ? `<div class="muted small">${t('original_text')}: ${esc(v.original.ashram_other)}</div>` : ''}</div>
        <div class="full"><label>${t('lsangha')}</label>
          <select name="lsangha_id">${`<option value="" ${!v.lsangha_id && !v.lsangha_other ? 'selected' : ''}>—</option>` + S.lsanghas.map((x) => `<option value="${x.id}" ${x.id === v.lsangha_id ? 'selected' : ''}>${esc(optName(x))}</option>`).join('')}<option value="other" ${!(v.lsangha_id || !v.lsangha_other) ? 'selected' : ''}>${t('other_label')} …</option></select>
          <input name="lsangha_other" class="other-input" placeholder="${t('other_type')}" value="${esc(v.lsangha_other || '')}" ${(v.lsangha_id || !v.lsangha_other) ? 'hidden' : ''}>
          ${v.original && v.original.lsangha_other ? `<div class="muted small">${t('original_text')}: ${esc(v.original.lsangha_other)}</div>` : ''}</div>
        <div class="full"><label>${t('seva')}</label>
          <select name="seva_id">${S.sevas.map((x) => `<option value="${x.id}" ${x.id === v.seva_id ? 'selected' : ''}>${esc(optName(x))}</option>`).join('')}<option value="other" ${!v.seva_id ? 'selected' : ''}>${t('other_label')} …</option></select>
          <input name="seva_other" class="other-input" placeholder="${t('other_type')}" value="${esc(v.seva_other || '')}" ${v.seva_id ? 'hidden' : ''}>
          ${v.original && v.original.seva_other ? `<div class="muted small">${t('original_text')}: ${esc(v.original.seva_other)}</div>` : ''}</div>
        ${refSelect('bs', v)}
        ${refSelect('zs', v)}
        <div class="full"><label>${t('address')}</label><textarea name="address" rows="2">${esc(v.address)}</textarea>
          ${v.original && v.original.address ? `<div class="muted small">${t('original_text')}: ${esc(v.original.address)}</div>` : ''}</div>
        <div class="full" style="display:flex;gap:8px;flex-wrap:wrap" data-need="edit">
          <button class="btn primary small">${t('save')}</button>
          ${v.needs_review ? `<button type="button" class="btn ghost small" id="d-reviewed">✓ ${t('mark_reviewed')}</button>` : ''}
          <span style="flex:1"></span>
          <button type="button" class="btn danger small" id="d-delete" data-need="delete">${t('delete')}</button>
        </div>
      </fieldset></form>
    </div>

    <div class="section-title">${t('remarks')}</div>
    ${remarksBlock('volunteer', v.id, v.remarks)}
  `;
  openDrawer();

  $('#d-group').value = v.group_id || '';
  $('#d-group').addEventListener('change', async (e) => {
    await apiPost('assign', { ids: [v.id], group_id: e.target.value ? +e.target.value : null });
    toast(t('saved')); await refresh(); openVolunteer(v.id);
  });
  $('#d-leader').addEventListener('change', async (e) => {
    const gid = +$('#d-group').value;
    await apiPost('group_save', { id: gid, leader_id: e.target.checked ? v.id : null });
    toast(t('saved')); await refresh(); openVolunteer(v.id);
  });
  $$('#d-form select[name$="_id"]').forEach((sel) => sel.addEventListener('change', () => {
    const inp = sel.parentElement.querySelector('.other-input'); if (inp) { inp.hidden = sel.value !== 'other'; if (!inp.hidden) inp.focus(); }
  }));
  $('#d-print').addEventListener('click', () => openPrint([v]));
  const un = $('#d-unprint');
  if (un) un.addEventListener('click', async () => { await apiPost('mark_printed', { ids: [v.id], undo: true }); await refresh(); openVolunteer(v.id); });
  $('#d-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    d.id = v.id;
    for (const [col, oth] of [['sangha_id', 'ashram_other'], ['lsangha_id', 'lsangha_other'], ['seva_id', 'seva_other'], ['bs_id', 'bs_other'], ['zs_id', 'zs_other']]) {
      if (d[col] === 'other') { d[col] = 0; } else { d[col] = +d[col] || 0; d[oth] = ''; }
    }
    if (d.sangha_id === v.sangha_id) delete d.sangha_id;
    await apiPost('volunteer_update', d);
    toast(t('saved')); await refresh(); openVolunteer(v.id);
  });
  const rv = $('#d-reviewed');
  if (rv) rv.addEventListener('click', async () => { await apiPost('volunteer_update', { id: v.id, needs_review: false }); await refresh(); openVolunteer(v.id); });
  $('#d-delete').addEventListener('click', async () => {
    if (!confirm(t('confirm_delete'))) return;
    await apiPost('volunteer_delete', { id: v.id }); closeDrawer(); refresh();
  });
  wireRemarks(body, () => openVolunteer(v.id));
}
function refSelect(k, v) {
  const id = v[k + '_id'], other = v[k + '_other'];
  return `<div class="full"><label>${t(k)} <span class="muted small">(${t('reference_short')})</span></label>
    <select name="${k}_id"><option value="" ${!id && !other ? 'selected' : ''}>—</option>${S[k].map((x) => `<option value="${x.id}" ${x.id === id ? 'selected' : ''}>${esc(x.name)}${x.location ? ' · ' + esc(x.location) : ''}</option>`).join('')}<option value="other" ${!id && other ? 'selected' : ''}>${t('other_label')} …</option></select>
    <input name="${k}_other" class="other-input" placeholder="${t('other_type')}" value="${esc(other || '')}" ${!id && other ? '' : 'hidden'}>
    ${v.original && v.original[k + '_other'] ? `<div class="muted small">${t('original_text')}: ${esc(v.original[k + '_other'])}</div>` : ''}</div>`;
}
function openDrawer() { $('#drawer').hidden = false; $('#drawer-bg').hidden = false; }
function closeDrawer() { $('#drawer').hidden = true; $('#drawer-bg').hidden = true; S.drawerId = null; }

/* ---------------- remarks (shared) ---------------- */
function remarksBlock(type, id, list = []) {
  return `<div class="remarks" data-remarks="${type}:${id}">
    ${list.map((r) => `<div class="remark">${esc(r.body)}<div class="meta">${esc(r.author || '')} · ${fmtDate(r.created_at)}</div><button class="x" data-need="edit" data-del-remark="${r.id}" title="${t('delete')}">×</button></div>`).join('')}
    <form class="remark-form" data-need="edit" data-add-remark="${type}:${id}"><input data-i18n-ph="remark_ph" placeholder="${t('remark_ph')}" required><button class="btn ghost small">${t('add_remark')}</button></form>
  </div>`;
}
function wireRemarks(root, after) {
  $$('[data-add-remark]', root).forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const [type, id] = f.dataset.addRemark.split(':');
    const input = $('input', f);
    await apiPost('remark_add', { entity_type: type, entity_id: +id, body: input.value });
    input.value = ''; await after();
  }));
  $$('[data-del-remark]', root).forEach((b) => b.addEventListener('click', async () => {
    await apiPost('remark_delete', { id: +b.dataset.delRemark }); await after();
  }));
}

/* ---------------- tabs ---------------- */
function switchTab(tab) {
  S.tab = tab;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#tab-volunteers').hidden = tab !== 'volunteers';
  $('#tab-groups').hidden = tab !== 'groups';
  $('#tab-dups').hidden = tab !== 'dups';
  $('#tab-lists').hidden = tab !== 'lists';
  if (tab === 'groups') renderGroups();
  if (tab === 'dups') renderDups();
  if (tab === 'lists') renderLists();
}

/* ---------------- sanghas & groups ---------------- */
async function renderGroups() {
  const list = $('#sangha-list');
  if (S.tab !== 'groups') return;
  // members of each sangha for leader dropdowns
  const vols = (await apiGet('volunteers')).items;
  const bySangha = {};
  vols.forEach((v) => { (bySangha[v.sangha_id] ||= []).push(v); });

  const sorted = [...S.sanghas].sort((a, b) => b.volunteers - a.volunteers || sanghaName(a).localeCompare(sanghaName(b)));
  list.innerHTML = sorted.map((s) => {
    const members = (bySangha[s.id] || []).sort((a, b) => a.name.localeCompare(b.name));
    const noLeader = s.groups.filter((g) => !g.leader_id).length;
    return `
    <details class="sangha" data-sangha="${s.id}" ${S.openSanghas.has(s.id) ? 'open' : ''}>
      <summary>
        <svg class="chev" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5l8 7-8 7z"/></svg>
        <div><div class="s-name">${esc(sanghaName(s))} ${s.active ? '' : `<span class="badge none">${t('inactive')}</span>`}</div><div class="s-loc">${esc(s.location || '')}${getLang() !== 'en' ? ' · ' + esc(s.name) : ''}</div></div>
        <div class="s-counts">
          <span class="badge lang">${s.volunteers} ${t('results')}</span>
          <span class="badge lang">${s.groups.length} ${t('stat_groups')}</span>
          ${s.unassigned ? `<span class="badge review">${s.unassigned} ${t('unassigned_in_sangha')}</span>` : ''}
          ${noLeader ? `<span class="badge review">${noLeader} ${t('stat_no_leader')}</span>` : ''}
        </div>
      </summary>
      <div class="sangha-body">
        <div class="groups">
          ${s.groups.map((g) => groupCard(g, members)).join('')}
        </div>
        <form class="inline-form" data-add-group="${s.id}">
          <input data-i18n-ph="group_name" placeholder="${t('group_name')}" required data-need="edit">
          <button class="btn primary small" data-need="edit">+ ${t('add_group')}</button>
          <button type="button" class="link-btn" data-view-sangha="${s.id}">${t('view_members')} →</button>
        </form>
        <div class="two-col" style="margin-top:14px">
          <div><div class="section-title">${t('remarks')} · ${t('sangha')}</div>${remarksBlock('sangha', s.id, s.remarks)}</div>
          <div data-need="lists"><div class="section-title">${t('names_in_languages')}</div>
            <form class="i18n-grid" data-edit-sangha="${s.id}">
              ${['or', 'bn', 'hi', 'as'].map((l) => `<input name="${l}" lang="${l}" placeholder="${langInfo(l).native}" value="${esc((s.name_i18n || {})[l] || '')}">`).join('')}
              <input name="name" value="${esc(s.name)}" placeholder="English">
              <input name="location" value="${esc(s.location || '')}" placeholder="${t('location')}">
              <label class="check" style="grid-column:1/-1;margin:0"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> ${t('active')}</label>
              <button class="btn ghost small" style="grid-column:1/-1">${t('save')}</button>
            </form>
          </div>
        </div>
      </div>
    </details>`;
  }).join('');

  $$('details.sangha', list).forEach((d) => d.addEventListener('toggle', () => {
    const id = +d.dataset.sangha; d.open ? S.openSanghas.add(id) : S.openSanghas.delete(id);
  }));
  $$('[data-add-group]', list).forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiPost('group_save', { sangha_id: +f.dataset.addGroup, name: $('input', f).value });
    toast(t('saved')); await refresh();
  }));
  $$('[data-leader-select]', list).forEach((sel) => sel.addEventListener('change', async () => {
    await apiPost('group_save', { id: +sel.dataset.leaderSelect, leader_id: sel.value ? +sel.value : null });
    toast(t('saved')); await refresh();
  }));
  $$('[data-del-group]', list).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(t('confirm_delete_group'))) return;
    await apiPost('group_delete', { id: +b.dataset.delGroup }); await refresh();
  }));
  $$('[data-view-group]', list).forEach((b) => b.addEventListener('click', () => {
    const g = allGroups().find((x) => x.id === +b.dataset.viewGroup);
    resetFilters(); F.sangha = String(g.sangha_id); F.group = String(g.id); syncFilterInputs(); switchTab('volunteers'); loadVolunteers();
  }));
  $$('[data-view-sangha]', list).forEach((b) => b.addEventListener('click', () => {
    resetFilters(); F.sangha = b.dataset.viewSangha; syncFilterInputs(); switchTab('volunteers'); loadVolunteers();
  }));
  $$('[data-edit-sangha]', list).forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    await apiPost('sangha_save', { id: +f.dataset.editSangha, name: d.name, location: d.location, active: !!d.active,
      name_i18n: { or: d.or, bn: d.bn, hi: d.hi, as: d.as } });
    toast(t('saved')); await refresh();
  }));
  $$('[data-rename-group]', list).forEach((b) => b.addEventListener('click', async () => {
    const g = allGroups().find((x) => x.id === +b.dataset.renameGroup);
    const name = prompt(t('group_name'), g.name);
    if (name && name.trim()) { await apiPost('group_save', { id: g.id, name: name.trim() }); await refresh(); }
  }));
  wireRemarks(list, refresh);
}

function groupCard(g, members) {
  const leader = members.find((m) => m.id === g.leader_id);
  return `<div class="group-card">
    <div class="g-head"><span class="g-name">${esc(g.name)}</span>
      <button class="link-btn" data-view-group="${g.id}">${g.members} ${t('members')}</button>
      <button class="link-btn" data-need="edit" data-rename-group="${g.id}" title="${t('edit')}">✎</button>
      <button class="link-btn" data-need="edit" style="color:var(--bad)" data-del-group="${g.id}" title="${t('delete')}">✕</button></div>
    ${leader ? `<div class="leader-row">${avatar(leader)}<div><div style="font-weight:600;font-size:.9rem">★ ${esc(leader.name)}</div><div class="muted small">${t('team_leader')} · ${esc(leader.mobile)}</div></div></div>`
      : `<div class="badge review" style="align-self:flex-start">${t('no_leader')}</div>`}
    <label class="muted small">${t('leader')}</label>
    <select data-leader-select="${g.id}" ${can('edit') ? '' : 'disabled'}>
      <option value="">— ${t('no_leader')} —</option>
      ${members.map((m) => `<option value="${m.id}" ${m.id === g.leader_id ? 'selected' : ''}>${esc(m.name)}${m.group_id === g.id ? ' ✓' : ''}</option>`).join('')}
    </select>
    ${remarksBlock('group', g.id, g.remarks)}
  </div>`;
}

async function onAddSangha(e) {
  e.preventDefault();
  await apiPost('sangha_save', { name: $('#new-sangha-name').value, location: $('#new-sangha-loc').value });
  e.target.reset(); toast(t('saved')); await refresh();
}

/* ---------------- misc ---------------- */
function toast(msg, ms = 2200) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, ms);
}
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof ApiError && e.reason.status === 401) { setToken(''); S.me = null; showLogin(); return; }
  toast((e.reason && e.reason.message) || t('error_generic'), 4000);
});

/* =================================================================
   DUPLICATES
   ================================================================= */
async function renderDups() {
  const box = $('#dup-list');
  const { groups } = await apiGet('duplicates');
  if (!groups.length) { box.innerHTML = `<div class="empty card">${t('dups_none')}</div>`; return; }
  box.innerHTML = groups.map((g, gi) => `
    <div class="dup-group card" data-group="${gi}">
      <div class="dup-reasons">${g.reasons.map((r) => `<span class="badge review">${t('dup_' + r)}</span>`).join(' ')}
        <span class="spacer"></span><button class="btn ghost small" data-need="edit" data-not-same="${g.ids.join(',')}">${t('not_same')}</button></div>
      <div class="dup-people">
        ${g.people.map((v) => `
          <div class="dup-person">
            <div class="person">${avatar(v)}<div><div class="nm">${esc(v.name)}</div><div class="sub">${esc(v.reg_no)} · ${fmtDate(v.created_at)}</div></div></div>
            <dl class="kv small">
              <dt>${t('mobile')}</dt><dd>${esc(v.mobile)}</dd>
              <dt>${t('age')}</dt><dd>${v.age ?? ''} · ${v.gender ? t(v.gender) : ''}</dd>
              <dt>${t('sangha')}</dt><dd>${answer(v, 'ashram')}</dd>
              <dt>${t('seva')}</dt><dd>${answer(v, 'seva')}</dd>
              <dt>${t('group')}</dt><dd>${esc(v.group_name || '—')}</dd>
              <dt>${t('printed')}</dt><dd>${v.printed_at ? fmtDate(v.printed_at) : '—'}</dd>
            </dl>
            <div class="dup-actions">
              <button class="btn primary small" data-need="delete" data-keep="${v.id}" data-others="${g.ids.filter((x) => x !== v.id).join(',')}">✓ ${t('keep_this')}</button>
              <button class="link-btn" data-open="${v.id}">${t('details')}</button>
            </div>
          </div>`).join('')}
      </div>
    </div>`).join('');
  $$('[data-keep]', box).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(t('merge_confirm'))) return;
    await apiPost('merge', { keep: +b.dataset.keep, remove: b.dataset.others.split(',').map(Number) });
    toast(t('saved')); await refresh();
  }));
  $$('[data-not-same]', box).forEach((b) => b.addEventListener('click', async () => {
    await apiPost('dup_dismiss', { ids: b.dataset.notSame.split(',').map(Number) });
    toast(t('saved')); await refresh();
  }));
  $$('[data-open]', box).forEach((b) => b.addEventListener('click', () => openVolunteer(+b.dataset.open)));
}

/* =================================================================
   LISTS — Seva, Sangha, and answers typed as "Other"
   ================================================================= */
async function renderLists() {
  const box = $('#lists');
  const [os, ol, oa, ob, oz] = await Promise.all(['seva', 'sangha', 'ashram', 'bs', 'zs'].map((kind) => apiGet('others', { kind })));
  const people = (kind) => kind === 'bs' || kind === 'zs';   // names of people: an area instead of translations
  const listPanel = (kind, title, items, others) => `
    <section class="card list-panel" data-kind="${kind}">
      <h3>${title}</h3>
      <div class="opt-rows">
        ${items.map((o, i) => `
          <details class="opt-row ${o.active ? '' : 'is-hidden'}" data-id="${o.id}">
            <summary>
              <span class="opt-name">${esc(optName(o))}${getLang() !== 'en' && optName(o) !== o.name ? ` <span class="muted small">· ${esc(o.name)}</span>` : ''}${o.location && people(kind) ? ` <span class="muted small">· ${esc(o.location)}</span>` : ''}</span>
              ${o.active ? '' : `<span class="badge none">${t('hidden')}</span>`}
              <span class="muted small opt-used" title="${esc(t('used_by'))}">👤 ${o.used}</span>
              <span class="spacer"></span>
              <button type="button" class="icon-mini" data-move="-1" title="${t('move_up')}" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" class="icon-mini" data-move="1" title="${t('move_down')}" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>
              <span class="link-btn">${t('edit')}</span>
            </summary>
            <form class="opt-edit">
              <label>English<input name="name" value="${esc(o.name)}" required></label>
              ${people(kind) ? `<label>${t('area')}<input name="location" value="${esc(o.location || '')}"></label>`
                : ['or', 'bn', 'hi', 'as'].map((l) => `<label>${langInfo(l).native}<input name="${l}" lang="${l}" value="${esc((o.name_i18n || {})[l] || '')}"></label>`).join('')}
              <label class="check"><input type="checkbox" name="active" ${o.active ? 'checked' : ''}> ${t('active')}</label>
              <div class="opt-edit-actions"><button class="btn primary small">${t('save')}</button>
                <button type="button" class="btn danger small" data-del-opt ${o.used ? 'disabled title="' + esc(t('in_use')) + '"' : ''}>${t('delete')}</button></div>
            </form>
          </details>`).join('')}
        <div class="opt-row opt-fixed"><span class="opt-name">${t('other_label')} — ${t('other_type')}</span></div>
      </div>
      <form class="inline-form add-opt"><input name="name" placeholder="${t('add_item')}: ${people(kind) ? t('name') : 'English name'}" required>${people(kind) ? `<input name="location" placeholder="${t('area')}">` : ''}<button class="btn primary small">+ ${t('add_item')}</button></form>
      ${othersBlock(kind, others)}
    </section>`;
  box.innerHTML = listPanel('seva', t('list_seva'), S.sevas, os.items) + listPanel('sangha', t('list_lsangha'), S.lsanghas, ol.items) +
    listPanel('bs', t('list_bs'), S.bs, ob.items) + listPanel('zs', t('list_zs'), S.zs, oz.items) +
    `<section class="card list-panel" data-kind="ashram"><h3>${t('list_ashram')}</h3>
      <p class="muted small">${t('tab_groups')} → ${t('add_sangha')}</p>${othersBlock('ashram', oa.items)}</section>`;

  $$('.list-panel[data-kind="seva"], .list-panel[data-kind="sangha"], .list-panel[data-kind="bs"], .list-panel[data-kind="zs"]', box).forEach((panel) => {
    const kind = panel.dataset.kind;
    $$('.opt-row[data-id]', panel).forEach((row) => {
      const id = +row.dataset.id;
      $$('[data-move]', row).forEach((b) => b.addEventListener('click', async (e) => {
        e.preventDefault(); await apiPost('option_move', { id, dir: +b.dataset.move }); await refresh();
      }));
      $('form', row).addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(e.target));
        await apiPost('option_save', people(kind) ? { id, kind, name: d.name, location: d.location, active: !!d.active }
          : { id, kind, name: d.name, active: !!d.active, location: (S[kind === 'seva' ? 'sevas' : 'lsanghas'].find((x) => x.id === id) || {}).location || '', name_i18n: { or: d.or, bn: d.bn, hi: d.hi, as: d.as } });
        toast(t('saved')); await refresh();
      });
      const del = $('[data-del-opt]', row);
      del.addEventListener('click', async () => {
        if (!confirm(t('delete') + '?')) return;
        try { await apiPost('option_delete', { id }); toast(t('saved')); await refresh(); }
        catch (err) { toast(t('in_use'), 4000); }
      });
    });
    $('.add-opt', panel).addEventListener('submit', async (e) => {
      e.preventDefault();
      await apiPost('option_save', { kind, name: e.target.name.value, location: e.target.location ? e.target.location.value : '' });
      e.target.reset(); toast(t('saved')); await refresh();
    });
  });
  $$('[data-promote]', box).forEach((b) => b.addEventListener('click', async () => {
    const [kind, text] = [b.dataset.kind, b.dataset.promote];
    const name = prompt(t('add_to_list') + ' (English)', text);
    if (!name || !name.trim()) return;
    const r = await apiPost('promote', { kind, text, name: name.trim() });
    toast(`${t('saved')} · ${r.linked}`); await refresh();
  }));
}
function othersBlock(kind, items) {
  return `<div class="others"><div class="section-title">${t('typed_other')}</div>
    ${items.length ? items.map((o) => `<div class="other-row"><span>“${esc(o.text)}”</span><span class="muted small">× ${o.n}</span><span class="spacer"></span>
      <button class="btn ghost small" data-kind="${kind}" data-promote="${esc(o.text)}">+ ${t('add_to_list')}</button></div>`).join('')
      : `<div class="muted small">${t('others_none')}</div>`}</div>`;
}

/* =================================================================
   ID CARDS — 8.56 × 5.4 cm (CR80), portrait or landscape
   ================================================================= */
const PRINT = { people: [], orient: 'portrait', paper: 'a4' };
try { Object.assign(PRINT, JSON.parse(localStorage.getItem('printPrefs') || '{}'), { people: [] }); } catch (e) {}

function wirePrint() {
  $('#print-close').addEventListener('click', closePrint);
  $('#print-orient').addEventListener('change', (e) => { PRINT.orient = e.target.value; savePrefs(); renderPrintPreview(); });
  $('#print-paper').addEventListener('change', (e) => { PRINT.paper = e.target.value; savePrefs(); });
  $('#print-go').addEventListener('click', doPrint);
}
function savePrefs() { try { localStorage.setItem('printPrefs', JSON.stringify({ orient: PRINT.orient, paper: PRINT.paper })); } catch (e) {} }

function openPrint(people) {
  if (!people.length) return;
  PRINT.people = people;
  $('#print-orient').value = PRINT.orient; $('#print-paper').value = PRINT.paper;
  $('#print-count').textContent = `· ${people.length}`;
  renderPrintPreview();
  $('#print-modal').hidden = false;
}
function closePrint() { $('#print-modal').hidden = true; }
function renderPrintPreview() {
  $('#print-preview').innerHTML = PRINT.people.slice(0, 6).map((v) => cardHtml(v, PRINT.orient)).join('') +
    (PRINT.people.length > 6 ? `<div class="muted">+ ${PRINT.people.length - 6}</div>` : '');
}

function qrSvg(text) {
  try { const q = window.qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 2, margin: 0, scalable: true }); }
  catch (e) { return ''; }
}
function cardHtml(v, orient) {
  const ashram = plain(answer(v, 'ashram'));
  const seva = plain(answer(v, 'seva'));
  const orig = v.original && v.original.name ? `<div class="c-orig">${esc(v.original.name)}</div>` : '';
  const photo = v.photo ? `<img src="${esc(assetUrl(v.photo))}" alt="">` : `<span class="c-initials">${initials(v.name)}</span>`;
  return `<div class="idc ${orient}">
    <div class="idc-slot"></div>
    <div class="idc-head">
      <img class="idc-logo" src="icons/logo.png" alt="">
      <div class="idc-event"><b>112th Sarbabhouma Bhakta Sammilani</b><span>Kalyani, Balesore, Odisha</span></div>
    </div>
    <div class="idc-role">VOLUNTEER · ସ୍ୱେଚ୍ଛାସେବୀ</div>
    <div class="idc-main">
      <div class="idc-photo">${photo}</div>
      <div class="idc-info">
        <div class="idc-name">${esc(v.name)}</div>${orig}
        ${seva ? `<div class="idc-seva">${esc(seva)}</div>` : ''}
        ${ashram ? `<div class="idc-ashram">${esc(ashram)}</div>` : ''}
        ${v.group_name ? `<div class="idc-ashram">${esc(v.group_name)}${v.is_leader ? ' · Team Leader' : ''}</div>` : ''}
      </div>
    </div>
    <div class="idc-foot"><div class="idc-reg">${esc(v.reg_no || '')}</div><div class="idc-qr">${qrSvg(v.reg_no || String(v.id))}</div></div>
  </div>`;
}

function doPrint() {
  const { people, orient, paper } = PRINT;
  const [w, h] = orient === 'portrait' ? ['54mm', '85.6mm'] : ['85.6mm', '54mm'];
  $('#print-page').textContent = paper === 'card'
    ? `@page { size: ${w} ${h}; margin: 0; } #print-root .sheet { display: block; } #print-root .idc { page-break-after: always; break-after: page; margin: 0; }`
    : `@page { size: A4 portrait; margin: 8mm; }`;
  $('#print-root').innerHTML = `<div class="sheet ${paper}">${people.map((v) => cardHtml(v, orient)).join('')}</div>`;
  const ids = people.map((v) => v.id);
  const imgs = $$('#print-root img');
  Promise.all(imgs.map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))).then(() => {
    let done = false;
    const after = async () => {
      if (done) return; done = true;
      window.removeEventListener('afterprint', after);
      closePrint();
      await apiPost('mark_printed', { ids });
      showUndo(ids);
      await refresh();
    };
    window.addEventListener('afterprint', after);
    window.print();
    setTimeout(after, 800);   // some browsers don't fire afterprint
  });
}
function showUndo(ids) {
  const el = $('#toast');
  el.innerHTML = `🖨 ${ids.length} ${esc(t('marked_printed'))} <button class="link-btn toast-undo">${esc(t('undo'))}</button>`;
  el.hidden = false;
  $('.toast-undo', el).addEventListener('click', async () => {
    await apiPost('mark_printed', { ids, undo: true }); el.hidden = true; await refresh();
  });
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, 8000);
}

/* =================================================================
   CSV export of the volunteers currently shown (all filters apply)
   ================================================================= */
function exportCsv(e) {
  e.preventDefault();
  const name = (k, v) => v[k + '_name'] || (v[k + '_other'] ? 'Other: ' + v[k + '_other'] : '');
  const head = ['Reg No', 'Name', 'Name as typed', 'Age', 'Gender', 'Mobile', 'WhatsApp', 'Email', 'Bibhagiya Ashram', 'Sangha', 'Seva',
    'Bibhagiya Sadasya (reference)', 'Zilla Sadasya (reference)', 'Group', 'Team Leader', 'Address', 'Language',
    'ID card printed (UTC)', 'Registered (UTC)', 'Last edited by volunteer (UTC)'];
  const rows = S.items.map((v) => [v.reg_no, v.name, (v.original && v.original.name) || '', v.age, v.gender, v.mobile, v.whatsapp, v.email,
    v.sangha_name || (v.ashram_other ? 'Other: ' + v.ashram_other : ''), name('lsangha', v), name('seva', v),
    v.bs_name ? `${v.bs_name}${v.bs_area ? ' (' + v.bs_area + ')' : ''}` : name('bs', v), v.zs_name ? `${v.zs_name}${v.zs_area ? ' (' + v.zs_area + ')' : ''}` : name('zs', v),
    v.group_name, v.is_leader ? 'Yes' : '', v.address, v.language, v.printed_at, v.created_at, v.edited_at]);
  // Spreadsheet apps run text starting with = + - @ as formulas: prefix those with '
  const cell = (x) => { let c = x == null ? '' : String(x); if (/^[=+\-@\t\r]/.test(c)) c = "'" + c; return /[",\n\r]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; };
  const csv = '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `sammilani-volunteers-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
