import { LANGS, t, setLang, getLang, hasChosenLang, applyI18n, sanghaName, langInfo, toAsciiDigits } from './i18n.js';
import { apiGet, apiPost, ApiError, assetUrl } from './api.js';
import { Combo, optionItem } from './combo.js';
import { listen, stopListening, voiceSupported, spokenDigits, spokenEmail, matchOption, GENDER_SYNONYMS } from './voice.js';
import { startCamera, stopCamera, fileToCanvas, processPhoto, warmUpModels, detectFaces } from './photo.js';
import * as outbox from './outbox.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = { sanghas: [], lsanghas: [], sevas: [], bs: [], zs: [], photo: null, facing: 'user', year: 2026, submitting: false, step: 1, edit: null, pendingEdit: null };
const STEPS = 5;
const combos = {};   // sangha_id (Bibhagiya Ashram), lsangha (Sangha), seva, bs / zs (reference: Bibhagiya / Zilla Sadasya)
let navigating = false;   // true while handling the phone Back button
const cam = { live: false, loop: null, busy: false, starting: false, holdUntil: 0, gen: 0 };
const form = $('#reg-form');

/* ================= boot ================= */
init();

function setTopbarHeight() {
  document.documentElement.style.setProperty('--topbar-h', $('.topbar').offsetHeight + ($('#sync-banner').hidden ? 0 : $('#sync-banner').offsetHeight) + 'px');
}

async function init() {
  setTopbarHeight();
  window.addEventListener('resize', setTopbarHeight);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  setupInstall();
  buildLanguageGrid();
  const chosen = hasChosenLang();
  if (chosen) setLang(getLang());
  applyI18n();
  $('#lang-btn').addEventListener('click', () => show('lang'));
  $('#restart-btn').addEventListener('click', startOver);
  $('#brand').addEventListener('click', startOver);
  $('#brand').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startOver(); } });
  history.replaceState({ v: 'lang' }, '');   // Back from step 1 lands on the language screen
  // ?edit=ABSM-2026-0123 (the link volunteers save on WhatsApp) opens "Edit my registration"
  const q = new URLSearchParams(location.search);
  if (q.has('edit')) { state.pendingEdit = q.get('edit') || ' '; history.replaceState({ v: 'lang' }, '', location.pathname); }
  show(chosen ? 'form' : 'lang');

  loadSanghas();
  wireForm();
  wireVoice();
  wirePhoto();
  wireEdit();
  if (chosen && state.pendingEdit) openEdit(state.pendingEdit);

  window.addEventListener('online', syncOutbox);
  syncOutbox();
  updateSyncBanner();
}

function show(which) {
  state.screen = which;
  $('#lang-screen').hidden = which !== 'lang';
  $('#form-screen').hidden = which !== 'form';
  $('#edit-screen').hidden = which !== 'edit';
  $('#success-screen').hidden = which !== 'success';
  $('#lang-btn').hidden = which === 'lang';
  $('#lang-btn-label').textContent = langInfo(getLang()).native;
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  if (which === 'form') setTimeout(() => warmUpModels().catch(() => {}), 1200); // pre-load photo AI quietly
  if (which !== 'form') stopLive();
  remember();
}

/* ---------- phone Back button: step back through the form instead of leaving the site ---------- */
function remember() {
  if (navigating) return;
  const entry = state.screen === 'form' ? { v: 'form', step: state.step } : { v: state.screen };
  const cur = history.state || {};
  if (cur.v === entry.v && cur.step === entry.step) return;
  history.pushState(entry, '');
}
window.addEventListener('popstate', (e) => {
  const to = e.state || { v: 'lang' };
  navigating = true;
  try {
    if (state.screen === 'success') { resetForm(); show('lang'); }   // never return to a form that was already sent
    else if (to.v === 'form') { show('form'); goStep(to.step || 1); }
    else if (to.v === 'edit') show('edit');
    else show('lang');
  } finally { navigating = false; }
});

/* ---------- Start over (link above the form, or tap the logo) ---------- */
function hasEntries() {
  const f = new FormData(form);
  return ['name', 'age', 'mobile', 'email', 'address', 'gender'].some((k) => String(f.get(k) || '').trim()) || !!state.photo
    || Object.values(combos).some((c) => c.value.id || c.value.other || c.input.value.trim());
}
async function startOver() {
  if (state.screen === 'form' && hasEntries()) {
    const ok = await confirmModal(t('start_over_q'), t('start_over'), t('cancel'));
    if (!ok) return;
  }
  resetForm();
  show('lang');
}

function buildLanguageGrid() {
  const grid = $('#lang-grid');
  grid.innerHTML = '';
  LANGS.forEach((l) => {
    const b = document.createElement('button');
    b.className = 'lang-tile';
    b.lang = l.code;
    b.innerHTML = `<span class="lang-native">${l.native}</span><span class="lang-en">${l.english}</span>`;
    b.addEventListener('click', () => {
      setLang(l.code);
      applyI18n();
      renderSanghaOptions();
      refreshEnglishPreviews();
      goStep(state.step);
      if (state.pendingEdit) return openEdit(state.pendingEdit);
      show('form');
    });
    grid.appendChild(b);
  });
}

/* ================= lists (Bibhagiya Ashram, Sangha, Seva) ================= */
async function loadSanghas() {
  try {
    const cfg = await apiGet('config');
    state.sanghas = cfg.sanghas; state.lsanghas = cfg.lsanghas || []; state.sevas = cfg.sevas || [];
    state.bs = cfg.bs || []; state.zs = cfg.zs || [];
    state.year = cfg.event_year || state.year;
    try { localStorage.setItem('lists', JSON.stringify({ sanghas: state.sanghas, lsanghas: state.lsanghas, sevas: state.sevas, bs: state.bs, zs: state.zs })); } catch (e) {}
  } catch (e) {
    try { Object.assign(state, JSON.parse(localStorage.getItem('lists') || '{}')); } catch (e2) {}
  }
  renderSanghaOptions();
}
function renderSanghaOptions() { Object.values(combos).forEach((c) => c.relabel()); }
function makeCombos() {
  const byLabel = (a, b) => a.label.localeCompare(b.label, getLang());
  combos.sangha_id = new Combo($('#combo-sangha_id'), { items: () => state.sanghas.map(optionItem).sort(byLabel), onChange: () => clearError($('.field[data-field="sangha_id"]')) });
  combos.lsangha = new Combo($('#combo-lsangha'), { items: () => state.lsanghas.map(optionItem).sort(byLabel), onChange: () => clearError($('.field[data-field="lsangha"]')) });
  combos.seva = new Combo($('#combo-seva'), { items: () => state.sevas.map(optionItem), onChange: () => clearError($('.field[data-field="seva"]')) });
  // Reference persons: people from the volunteer's own Bibhagiya Ashram area come first
  const people = (list) => () => {
    const a = combos.sangha_id.value;
    const ashram = a.id ? state.sanghas.find((s) => s.id === a.id) : null;
    const where = ashram ? `${ashram.name} ${ashram.location || ''}` : (a.other || '');
    const items = list().map((o) => ({ id: o.id, label: o.name, sub: o.location || '', keys: [o.name, o.location || ''] }));
    return items.map((it, i) => ({ it, i, near: areaMatches(it.sub, where) })).sort((x, y) => (y.near - x.near) || (x.i - y.i)).map((x) => x.it);
  };
  combos.bs = new Combo($('#combo-bs'), { items: people(() => state.bs) });
  combos.zs = new Combo($('#combo-zs'), { items: people(() => state.zs) });
}
// Sadasya list areas are written as in the directory; a few differ from the ashram names
const AREA_ALIAS = { khadakushma: 'kharkusma', manushmudia: 'manusmuria' };
function areaMatches(area, where) {
  if (!area || !where) return false;
  const a = area.toLowerCase().trim(), w = where.toLowerCase();
  return w.includes(a) || (!!AREA_ALIAS[a] && w.includes(AREA_ALIAS[a]));
}
const comboValue = (c) => c.value.id ? { id: c.value.id, other: '' } : (c.input.value.trim() ? { id: 'other', other: (c.value.other || c.input.value).trim() } : { id: '', other: '' });

/* ================= form ================= */
function wireForm() {
  makeCombos();
  $('#wa-same').addEventListener('change', (e) => {
    $('#wa-wrap').hidden = e.target.checked;
    if (!e.target.checked) $('#f-whatsapp').focus();
  });
  ['#f-mobile', '#f-whatsapp', '#f-age'].forEach((sel) =>
    $(sel).addEventListener('input', (e) => { e.target.value = toAsciiDigits(e.target.value).replace(/\D/g, ''); }));

  $('#f-name').addEventListener('input', debounce(() => updateEnglish('name'), 700));
  $('#f-address').addEventListener('input', debounce(() => updateEnglish('address'), 900));
  $$('[data-english]').forEach((el) => el.addEventListener('input', () => { el.dataset.edited = '1'; }));

  form.addEventListener('input', (e) => clearError(e.target.closest('.field')));
  form.addEventListener('change', (e) => clearError(e.target.closest('.field')));
  form.addEventListener('submit', onSubmit);
  $('#next-btn').addEventListener('click', () => {
    const errs = stepErrors(state.step);
    if (Object.keys(errs).length) return showErrors(errs);
    goStep(state.step + 1);
  });
  $('#back-btn').addEventListener('click', () => goStep(state.step - 1));
  // Enter on a text field moves to the next step instead of submitting early
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && state.step < STEPS) { e.preventDefault(); $('#next-btn').click(); }
  });
  goStep(1);
  $('#again-btn').addEventListener('click', resetForm);
}

/* ---------- steps (one screen each on a phone) ---------- */
const stepOf = (fieldKey) => {
  const f = $(`.field[data-field="${fieldKey}"]`);
  const p = f && f.closest('[data-step]');
  return p ? +p.dataset.step : STEPS;
};
function stepErrors(step) {
  const all = validate(collect());
  return Object.fromEntries(Object.entries(all).filter(([k]) => stepOf(k) === step));
}
function goStep(n) {
  n = Math.max(1, Math.min(STEPS, n));
  state.step = n;
  $$('.step-panel').forEach((p) => { p.hidden = +p.dataset.step !== n; });
  $('.intro').hidden = n !== 1;
  $('#edit-open').hidden = n !== 1 || !!state.edit;
  $$('#progress .progress-steps span').forEach((el, i) => { el.className = i < n - 1 ? 'done' : i === n - 1 ? 'current' : ''; });
  $('#step-num').textContent = n; $('#step-total').textContent = STEPS;
  const legend = $(`.step-panel[data-step="${n}"] legend span[data-i18n]`);
  $('#step-title').textContent = legend ? legend.textContent : '';
  $('#back-btn').style.visibility = n === 1 ? 'hidden' : 'visible';
  $('#next-btn').hidden = n === STEPS;
  $('#submit-btn').hidden = n !== STEPS;
  $('#form-error').hidden = true;
  window.scrollTo({ top: 0 });
  if (n === STEPS) { warmUpModels().catch(() => {}); startLive(); } else stopLive();
  if (n === 4 && !combos.seva.value.id && !combos.seva.value.other) combos.seva.open();
  if (state.screen === 'form') remember();
}

const hasNonLatin = (s) => /[^\x00-\x7F]/.test(s);

async function updateEnglish(field) {
  const src = field === 'name' ? $('#f-name') : $('#f-address');
  const box = $(`[data-preview="${field}"]`);
  const out = $(`[data-english="${field}"]`);
  const text = src.value.trim();
  if (!hasNonLatin(text) || getLang() === 'en') { box.hidden = true; out.value = ''; delete out.dataset.edited; return; }
  box.hidden = false;
  if (out.dataset.edited) return;
  out.placeholder = '…';
  try {
    const r = await apiPost('translate', { text, from: getLang(), mode: field === 'name' ? 'name' : 'text' });
    if (src.value.trim() === text && !out.dataset.edited) out.value = r.english || '';
  } catch (e) { /* offline: server will translate on sync */ }
  out.placeholder = '';
}
function refreshEnglishPreviews() { updateEnglish('name'); updateEnglish('address'); }

function collect() {
  const fd = new FormData(form);
  const mobile = toAsciiDigits(fd.get('mobile') || '').replace(/\D/g, '');
  const sameWa = $('#wa-same').checked;
  const data = {
    language: getLang(),
    name: (fd.get('name') || '').trim(),
    age: parseInt(toAsciiDigits(fd.get('age') || ''), 10) || '',
    gender: fd.get('gender') || '',
    mobile,
    whatsapp: sameWa ? mobile : toAsciiDigits(fd.get('whatsapp') || '').replace(/\D/g, ''),
    email: (fd.get('email') || '').trim(),
    ...(() => {
      const a = comboValue(combos.sangha_id), l = comboValue(combos.lsangha), v = comboValue(combos.seva), bs = comboValue(combos.bs), zs = comboValue(combos.zs);
      return { sangha_id: a.id, ashram_other: a.other, lsangha_id: l.id, lsangha_other: l.other, seva_id: v.id, seva_other: v.other,
               bs_id: bs.id, bs_other: bs.other, zs_id: zs.id, zs_other: zs.other };
    })(),
    address: (fd.get('address') || '').trim(),
    photo: state.photo && state.photo.startsWith('data:') ? state.photo : '',   // an unchanged photo (when editing) is not re-sent
    english: {},
  };
  ['name', 'address'].forEach((k) => {
    const v = $(`[data-english="${k}"]`).value.trim();
    if (v && !$(`[data-preview="${k}"]`).hidden) data.english[k] = v;
  });
  return data;
}

function validate(d) {
  const errs = {};
  if (d.name.length < 2) errs.name = t('required');
  if (!(d.age >= 10 && d.age <= 100)) errs.age = t('invalid_age');
  if (!d.gender) errs.gender = t('required');
  if (!/^[6-9]\d{9}$/.test(d.mobile)) errs.mobile = t('invalid_mobile');
  if (!$('#wa-same').checked && !/^[6-9]\d{9}$/.test(d.whatsapp)) errs.whatsapp = t('invalid_mobile');
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) errs.email = t('invalid_email');
  if (!d.sangha_id || (d.sangha_id === 'other' && d.ashram_other.length < 2)) errs.sangha_id = t('choose_or_other');
  if (!d.seva_id || (d.seva_id === 'other' && d.seva_other.length < 2)) errs.seva = t('choose_or_other');
  if (d.address.length < 3) errs.address = t('required');
  if (!state.photo) errs.photo = t('photo_required');
  if (!$('#f-consent').checked) errs.consent = t('consent_required');
  return errs;
}
function showErrors(errs) {
  $$('.field.invalid').forEach(clearError);
  Object.entries(errs).forEach(([k, msg]) => {
    const f = $(`.field[data-field="${k}"]`);
    if (!f) return;
    f.classList.add('invalid');
    $('.err', f).textContent = msg;
  });
  const first = $('.field.invalid');
  if (first) {
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const inp = $('input:not([type=radio]):not([type=checkbox]), select, textarea', first);
    // Focus the field only if the person hasn't already tapped somewhere else
    const before = document.activeElement;
    if (inp) setTimeout(() => {
      const now = document.activeElement;
      if (now === before || now === document.body || now === $('#next-btn') || now === $('#submit-btn')) inp.focus({ preventScroll: true });
    }, 350);
  }
  const fe = $('#form-error');
  fe.hidden = !Object.keys(errs).length;
  fe.textContent = t('fix_errors');
}
function clearError(field) {
  if (!field) return;
  field.classList.remove('invalid');
  const e = $('.err', field); if (e) e.textContent = '';
  if (!$('.field.invalid')) $('#form-error').hidden = true;
}

async function onSubmit(ev) {
  ev.preventDefault();
  if (state.submitting) return;
  const data = collect();
  const errs = validate(data);
  if (Object.keys(errs).length) {
    const first = Math.min(...Object.keys(errs).map(stepOf));
    goStep(first);
    return showErrors(Object.fromEntries(Object.entries(errs).filter(([k]) => stepOf(k) === first)));
  }

  if (state.edit) return submitEdit(data);
  data.client_id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
  await submit(data);
}

async function submit(data) {
  const btn = $('#submit-btn');
  state.submitting = true; btn.disabled = true; btn.firstElementChild.textContent = t('submitting');
  try {
    if (!navigator.onLine) throw new TypeError('offline');
    const res = await apiPost('register', data);
    showSuccess(data, res);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const ok = await confirmModal(t('dup_mobile'), t('register_anyway'), t('cancel'));
      if (ok) { state.submitting = false; return submit({ ...data, force: true }); }
    } else if (e instanceof ApiError && e.status === 422 && e.data && e.data.fields) {
      showServerErrors(e.data.fields);
    } else if (!(e instanceof ApiError) || e.status >= 500) {
      // Network problem → keep it on the phone and send later
      await outbox.queue(data);
      updateSyncBanner();
      showSuccess(data, null);
    } else {
      toast(e.message || t('error_generic'));
    }
  } finally {
    state.submitting = false; btn.disabled = false; btn.firstElementChild.textContent = t('submit');
  }
}

function showServerErrors(fields) {
  const map = {};
  Object.keys(fields).forEach((k) => { map[k] = k === 'mobile' || k === 'whatsapp' ? t('invalid_mobile') : k === 'age' ? t('invalid_age') : k === 'email' ? t('invalid_email') : (k === 'seva' || k === 'sangha_id') ? t('choose_or_other') : t('required'); });
  goStep(Math.min(...Object.keys(map).map(stepOf)));
  showErrors(Object.fromEntries(Object.entries(map).filter(([k]) => stepOf(k) === state.step)));
}

function showSuccess(data, res, edited = false) {
  stopLive();
  const title = $('#success-title');
  title.dataset.i18n = edited ? 'updated_title' : 'success_title'; title.textContent = t(title.dataset.i18n);
  $('#again-btn').dataset.i18n = edited ? 'done' : 'register_another'; $('#again-btn').textContent = t($('#again-btn').dataset.i18n);
  $('#success-actions').hidden = !res;   // queued offline: no registration number yet
  if (res) {
    const url = `${location.origin}${location.pathname}?edit=${encodeURIComponent(res.reg_no)}`;
    const msg = t('wa_text').replace('{reg}', res.reg_no).replace('{name}', res.name_en || data.name).replace('{url}', url);
    $('#wa-save').href = 'https://wa.me/?text=' + encodeURIComponent(msg);
    state.last = { reg_no: res.reg_no, mobile: data.mobile };
  }
  const s = state.sanghas.find((x) => x.id === data.sangha_id);
  const sv = state.sevas.find((x) => x.id === data.seva_id);
  $('#id-photo').src = (res && res.photo) ? assetUrl(res.photo) : data.photo;
  const enName = (res && res.name_en) || data.english.name || data.name;
  $('#id-name').textContent = enName;
  $('#id-name-orig').textContent = hasNonLatin(data.name) ? data.name : '';
  $('#id-sangha').textContent = s ? sanghaName(s) : data.ashram_other;
  $('#id-seva').textContent = sv ? optionItem(sv).label : data.seva_other;
  $('#id-reg').textContent = res ? res.reg_no : '⏳ ' + t('saved_offline');
  $('#success-msg').textContent = edited ? t('updated_body') : res ? t('success_body') : t('offline_saved');
  show('success');
}

function resetForm() {
  setEditMode(null);
  form.reset();
  $('#wa-same').checked = true; $('#wa-wrap').hidden = true;
  $$('[data-preview]').forEach((b) => { b.hidden = true; });
  $$('[data-english]').forEach((el) => { el.value = ''; delete el.dataset.edited; });
  setPhoto(null);
  setStatus('', '');
  Object.values(combos).forEach((c) => c.reset());
  $$('.field.invalid').forEach(clearError);
  goStep(1);
  show('form');
}

/* ================= edit an existing registration (registration number + mobile) ================= */
function wireEdit() {
  $('#edit-open').addEventListener('click', () => openEdit(''));
  $('#edit-again').addEventListener('click', () => {
    const l = state.last || {};
    resetForm(); openEdit(l.reg_no || '', l.mobile || '', true);
  });
  $('#edit-cancel').addEventListener('click', () => { resetForm(); });
  $('#edit-exit').addEventListener('click', async () => {
    if (await confirmModal(t('start_over_q'), t('start_over'), t('cancel'))) { resetForm(); }
  });
  $('#e-mobile').addEventListener('input', (e) => { e.target.value = toAsciiDigits(e.target.value).replace(/\D/g, ''); });
  $('#edit-form').addEventListener('submit', (e) => { e.preventDefault(); lookup(); });
}
function openEdit(reg = '', mobile = '', auto = false) {
  state.pendingEdit = null;
  $('#e-reg').value = reg.trim(); $('#e-mobile').value = mobile;
  $('#edit-err').hidden = true;
  show('edit');
  if (auto && reg && mobile) lookup();
  else setTimeout(() => (reg.trim() ? $('#e-mobile') : $('#e-reg')).focus(), 50);
}
async function lookup() {
  const err = $('#edit-err'), btn = $('#edit-find');
  err.hidden = true;
  const reg = toAsciiDigits($('#e-reg').value), mobile = toAsciiDigits($('#e-mobile').value).replace(/\D/g, '');
  if (!/\d/.test(reg) || mobile.length !== 10) { err.textContent = t('edit_not_found'); err.hidden = false; return; }
  btn.disabled = true;
  try {
    const r = await apiPost('self_lookup', { reg_no: reg, mobile });
    fillForm(r.item, r.token);
  } catch (e) {
    err.textContent = !(e instanceof ApiError) ? t('edit_offline') : e.status === 429 ? t('edit_too_many') : t('edit_not_found');
    err.hidden = false;
  } finally { btn.disabled = false; }
}
function setEditMode(edit) {
  state.edit = edit;
  $('#edit-banner').hidden = !edit;
  $('#edit-reg').textContent = edit ? edit.reg_no : '';
  $('#edit-open').hidden = !!edit;
  const sb = $('#submit-btn').firstElementChild;
  sb.dataset.i18n = edit ? 'save_changes' : 'submit'; sb.textContent = t(sb.dataset.i18n);
}
/* Put a saved registration back into the form. Text typed in Odia etc. comes back in that script
   (with its English version underneath) when the form is in that language; otherwise in English. */
function fillForm(v, token) {
  resetForm();
  const orig = v.original || {};
  const native = (k) => (getLang() !== 'en' && orig[k]) ? orig[k] : '';
  const setVal = (sel, val) => { const el = $(sel); el.value = val == null ? '' : val; };
  setVal('#f-name', native('name') || v.name);
  setVal('#f-address', native('address') || v.address);
  ['name', 'address'].forEach((k) => {
    if (!native(k)) return;
    $(`[data-preview="${k}"]`).hidden = false;
    const en = $(`[data-english="${k}"]`); en.value = v[k] || ''; en.dataset.edited = '1';
  });
  setVal('#f-age', v.age); setVal('#f-mobile', v.mobile); setVal('#f-email', v.email);
  const g = $(`input[name=gender][value="${v.gender}"]`); if (g) g.checked = true;
  const sameWa = !v.whatsapp || v.whatsapp === v.mobile;
  $('#wa-same').checked = sameWa; $('#wa-wrap').hidden = sameWa; setVal('#f-whatsapp', sameWa ? '' : v.whatsapp);
  combos.sangha_id.set({ id: v.sangha_id, other: native('ashram_other') || v.ashram_other || '' });
  combos.lsangha.set({ id: v.lsangha_id, other: native('lsangha_other') || v.lsangha_other || '' });
  combos.seva.set({ id: v.seva_id, other: native('seva_other') || v.seva_other || '' });
  combos.bs.set({ id: v.bs_id, other: native('bs_other') || v.bs_other || '' });
  combos.zs.set({ id: v.zs_id, other: native('zs_other') || v.zs_other || '' });
  if (v.photo) setPhoto(assetUrl(v.photo), true);
  $('#f-consent').checked = true;
  setEditMode({ id: v.id, reg_no: v.reg_no, token });
  goStep(1);
  show('form');
}
async function submitEdit(data) {
  if (!navigator.onLine) return toast(t('edit_offline'), 4000);
  const btn = $('#submit-btn');
  state.submitting = true; btn.disabled = true; btn.firstElementChild.textContent = t('submitting');
  try {
    const r = await apiPost('self_update', { ...data, token: state.edit.token });
    const reg = state.edit.reg_no;
    if (!r.changed.length) toast(t('no_changes'));
    showSuccess({ ...data, sangha_id: r.item.sangha_id, seva_id: r.item.seva_id, ashram_other: r.item.ashram_other, seva_other: r.item.seva_other },
                { reg_no: reg, name_en: r.item.name, photo: r.item.photo }, true);
    setEditMode(null);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { toast(t('edit_expired'), 5000); openEdit(state.edit.reg_no, data.mobile); }
    else if (e instanceof ApiError && e.status === 422 && e.data && e.data.fields) showServerErrors(e.data.fields);
    else toast((e && e.message) || t('error_generic'));
  } finally {
    state.submitting = false; btn.disabled = false;
    btn.firstElementChild.textContent = t(state.edit ? 'save_changes' : 'submit');
  }
}

/* ================= voice ================= */
function wireVoice() {
  $$('.mic').forEach((b) => {
    b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-2.1A7 7 0 0 0 19 12h-2Z"/></svg>';
    b.addEventListener('click', () => onMic(b));
  });
  $('#listening').addEventListener('click', stopListening);
}

async function onMic(btn) {
  const field = btn.dataset.voice;
  if (!voiceSupported) return toast(t('voice_unsupported'), 5000);
  const lang = langInfo(getLang()).speech;
  // numbers/emails are recognised better in Indian English regardless of UI language
  const recLang = ['email'].includes(field) ? 'en-IN' : lang;
  btn.classList.add('on');
  $('#listening').hidden = false; $('#interim').textContent = '';
  try {
    const { text, alternatives } = await listen(recLang, { onInterim: (s) => { $('#interim').textContent = s; } });
    applyVoice(field, text, alternatives);
  } catch (e) {
    if (e.message === 'language-not-supported') toast(t('voice_unsupported'), 5000);
    else if (e.message === 'not-allowed' || e.message === 'service-not-allowed') toast(t('voice_unsupported'), 5000);
    else if (e.message !== 'aborted') toast(t('voice_error'));
  } finally {
    btn.classList.remove('on');
    $('#listening').hidden = true;
  }
}

function applyVoice(field, text, alts = []) {
  const set = (sel, v) => { const el = $(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  switch (field) {
    case 'name': set('#f-name', titleCase(text.replace(/[.,!?]+$/, ''))); break;
    case 'address': set('#f-address', ($('#f-address').value ? $('#f-address').value + ', ' : '') + text); break;
    case 'age': { const n = spokenDigits(text).slice(0, 3); if (n) set('#f-age', n); else toast(t('voice_error')); break; }
    case 'mobile': case 'whatsapp': {
      let n = spokenDigits(text); if (n.length > 10) n = n.slice(-10);
      set(field === 'mobile' ? '#f-mobile' : '#f-whatsapp', n); break;
    }
    case 'email': set('#f-email', spokenEmail(text)); break;
    case 'gender': {
      const opts = Object.keys(GENDER_SYNONYMS).map((v) => ({ value: v, labels: [t(v), ...GENDER_SYNONYMS[v]] }));
      const v = matchOption([text, ...alts], opts);
      if (v) { const r = $(`input[name=gender][value="${v}"]`); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
      else toast(t('voice_no_match'));
      break;
    }
    default:
      if (field.startsWith('combo-')) combos[field.slice(6)].fromVoice(text.replace(/[.,!?।]+$/, ''));
  }
}

/* ================= photo: live camera inside step 4 ================= */

function wirePhoto() {
  $('#take-photo').addEventListener('click', capture);
  $('#retake-btn').addEventListener('click', () => { setPhoto(null); setStatus('', ''); startLive(); });
  $('#camera-switch').addEventListener('click', () => {
    state.facing = state.facing === 'user' ? 'environment' : 'user';
    if (!state.photo) startLive();
  });
  $('#upload-photo').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    stopLive();
    await handleImage(await fileToCanvas(f));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLive();
    else if (state.step === STEPS && !state.photo && !$('#form-screen').hidden) startLive();
  });
}

function setStatus(kind, text) {
  const s = $('#photo-status');
  s.className = 'photo-status' + (kind ? ' ' + kind : '');
  s.textContent = text;
}
function camMessage(key) {
  $('#cam-msg').hidden = !key;
  $('#cam-msg-text').textContent = key ? t(key) : '';
}

async function startLive() {
  if (cam.starting || state.photo) return;
  const frame = $('#photo-frame');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camMessage('cam_unavailable'); frame.classList.add('no-cam'); return; }
  cam.starting = true;
  const gen = ++cam.gen;
  camMessage('cam_starting');
  try {
    await startCamera($('#camera-video'), state.facing);
    // the person may have uploaded a photo or left the step while the camera was starting
    if (gen !== cam.gen || state.photo || state.step !== STEPS) { stopCamera(); camMessage(null); return; }
    cam.live = true;
    frame.classList.add('live'); frame.classList.remove('no-cam');
    camMessage(null);
    $('#take-photo').disabled = false;
    alignLoop();
  } catch (e) {
    cam.live = false;
    frame.classList.remove('live'); frame.classList.add('no-cam');
    camMessage('cam_unavailable');
    $('#take-photo').disabled = true;
  } finally { cam.starting = false; }
}
function stopLive() {
  cam.live = false;
  cam.gen++;
  clearTimeout(cam.loop);
  stopCamera();
  $('#photo-frame').classList.remove('live', 'aligned');
}

/* Live guide: is the face inside the oval, and the right size? */
async function alignLoop() {
  clearTimeout(cam.loop);
  if (!cam.live) return;
  const video = $('#camera-video');
  if (!cam.busy && video.readyState >= 2) {
    cam.busy = true;
    try {
      const boxes = await detectFaces(visibleFrame(video, 360));
      if (cam.live && !state.photo) showAlignment(boxes);
    } catch (e) { /* model not ready yet: keep the plain guide */ }
    cam.busy = false;
  }
  cam.loop = setTimeout(alignLoop, 300);
}
/* The part of the camera image the person actually sees in the 3:4 frame (mirrored like the preview). */
function visibleFrame(video, targetW) {
  const frame = $('#photo-frame');
  const fw = frame.clientWidth, fh = frame.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
  const k = Math.max(fw / vw, fh / vh), sw = fw / k, sh = fh / k, sx = (vw - sw) / 2, sy = (vh - sh) / 2;
  const w = targetW || Math.round(sw), h = Math.round(w * sh / sw);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (state.facing === 'user') { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  return c;
}
function showAlignment(boxes) {
  const frame = $('#photo-frame');
  let hint = 'cam_align', ok = false;
  if (boxes.length) {
    const b = boxes.sort((x, y) => y.width - x.width)[0];   // boxes are already relative to the visible frame
    // the detector's box is centred near the eyes, which sit in the upper-middle of the oval
    const centred = Math.abs(b.xCenter - 0.5) < 0.12 && b.yCenter > 0.3 && b.yCenter < 0.52;
    if (!centred) hint = 'cam_align';
    else if (b.width < 0.25) hint = 'cam_closer';
    else if (b.width > 0.62) hint = 'cam_back';
    else { hint = 'cam_ready'; ok = true; }
  }
  frame.classList.toggle('aligned', ok);
  if (Date.now() < cam.holdUntil) return;   // keep the last error visible for a moment
  setStatus(ok ? 'guide ok' : 'guide', (ok ? '✓ ' : '') + t(hint));
}

async function capture() {
  if (!cam.live) { $('#upload-photo').click(); return; }
  const frame = visibleFrame($('#camera-video'));   // exactly what was shown in the frame
  stopLive();
  await handleImage(frame);
}

async function handleImage(canvas) {
  const busy = $('#photo-busy');
  busy.hidden = false; setStatus('', '');
  clearError($('.field[data-field="photo"]'));
  $('#take-photo').disabled = true;
  try {
    const r = await processPhoto(canvas);
    if (r.status === 'ok') { setPhoto(r.dataUrl, true); setStatus('ok', '✓ ' + t('photo_ok')); }
    else if (r.status === 'unavailable') { setPhoto(r.dataUrl, false); setStatus('warn', t('photo_ai_unavailable')); }
    else { setPhoto(null); setStatus('bad', t(r.status === 'many' ? 'photo_many_faces' : 'photo_no_face')); cam.holdUntil = Date.now() + 4000; startLive(); }
  } catch (e) {
    console.error(e); setPhoto(null); setStatus('bad', t('error_generic')); startLive();
  } finally { busy.hidden = true; $('#take-photo').disabled = false; }
}
function setPhoto(dataUrl, cutout) {
  state.photo = dataUrl;
  const img = $('#photo-preview');
  img.hidden = !dataUrl;
  if (dataUrl) img.src = dataUrl; else img.removeAttribute('src');
  const frame = $('#photo-frame');
  frame.classList.toggle('has-photo', !!dataUrl);
  frame.classList.toggle('cutout', !!cutout);
  $('#take-photo').hidden = !!dataUrl;
  $('#retake-btn').hidden = !dataUrl;
  $('#camera-switch').hidden = !!dataUrl;
}

/* ================= offline sync ================= */
async function syncOutbox() {
  const n = await outbox.flush((payload) => apiPost('register', payload)).catch(() => 0);
  if (n) toast(`✓ ${n}`);
  updateSyncBanner();
}
async function updateSyncBanner() {
  const items = await outbox.pending().catch(() => []);
  const b = $('#sync-banner');
  b.hidden = !items.length;
  b.textContent = `⏳ ${items.length} ${t('pending_sync')}`;
  setTopbarHeight();
}

/* ================= install prompt ================= */
function setupInstall() {
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#install-btn').hidden = false; });
  $('#install-btn').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#install-btn').hidden = true; });
}

/* ================= ui helpers ================= */
function toast(msg, ms = 3200) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, ms);
}
function confirmModal(text, yes, no) {
  return new Promise((resolve) => {
    $('#modal-text').textContent = text; $('#modal-yes').textContent = yes; $('#modal-no').textContent = no;
    $('#modal').hidden = false;
    const done = (v) => { $('#modal').hidden = true; $('#modal-yes').onclick = $('#modal-no').onclick = null; resolve(v); };
    $('#modal-yes').onclick = () => done(true); $('#modal-no').onclick = () => done(false);
  });
}
function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }
function titleCase(s) { return /[^\x00-\x7F]/.test(s) ? s : s.replace(/\b\w/g, (c) => c.toUpperCase()); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
