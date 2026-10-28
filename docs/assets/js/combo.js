// Searchable picker used for Bibhagiya Ashram, Sangha and Seva.
// Shows the list, filters it as you type or speak, and always ends with
// "Other", which keeps whatever was typed. Value: { id, other }.
import { t, getLang } from './i18n.js';

const fold = (s) => String(s || '').toLowerCase().normalize('NFC')
  .replace(/[।॥.,()'"`’\-_/]/g, ' ').replace(/\s+/g, ' ').trim();

/* ---- "sound skeleton" so names match across scripts and spellings ----
   Odia, Bengali/Assamese and Devanagari share one consonant layout (offsets
   from each block's start), so one table covers all three. Vowels, h and
   y are dropped; similar consonants collapse (sh/s, v/w/b, ph/f/p, …):
   "ଶରତ ମହାନ୍ତି", "শরৎ মহান্তি", "Sharat Mohanty" and "Sarat Mohanti" → "srt mnt". */
const IND = { 0x15: 'k', 0x16: 'k', 0x17: 'g', 0x18: 'g', 0x19: 'n', 0x1A: 'c', 0x1B: 'c', 0x1C: 'j', 0x1D: 'j', 0x1E: 'n',
  0x1F: 't', 0x20: 't', 0x21: 'd', 0x22: 'd', 0x23: 'n', 0x24: 't', 0x25: 't', 0x26: 'd', 0x27: 'd', 0x28: 'n', 0x29: 'n',
  0x2A: 'p', 0x2B: 'p', 0x2C: 'b', 0x2D: 'b', 0x2E: 'm', 0x2F: 'j', 0x30: 'r', 0x31: 'r', 0x32: 'l', 0x33: 'l', 0x34: 'l',
  0x35: 'b', 0x36: 's', 0x37: 's', 0x38: 's', 0x02: 'n', 0x5C: 'r', 0x5D: 'r', 0x58: 'k', 0x5A: 'g', 0x5B: 'j', 0x5E: 'p',
  0x70: 'r', 0x71: 'b' };   // 0x5C/0x5D ḍa/ḍha with dot = r; 0x70/0x71 Assamese ra/wa (Odia 0x71 wa)
const BLOCKS = [0x0900, 0x0980, 0x0B00];
function skeletonWord(w) {
  let out = '';
  if (/[a-z]/.test(w)) {
    w = w.replace(/^y/, 'j').replace(/x/g, 'ks').replace(/ph/g, 'p').replace(/ch/g, 'c').replace(/sh/g, 's').replace(/([aeiou])w/g, '$1')
      .replace(/[fvw]/g, (c) => (c === 'f' ? 'p' : 'b')).replace(/z/g, 'j').replace(/q/g, 'k').replace(/[aeiouyh]/g, '');
    out = w.replace(/[^a-z]/g, '');
  } else {
    for (const ch of w) {
      const cp = ch.codePointAt(0);
      const base = BLOCKS.find((b) => cp >= b && cp < b + 0x80);
      if (base === undefined) continue;
      const off = cp - base;
      if (off === 0x3C && out.endsWith('d')) { out = out.slice(0, -1) + 'r'; continue; }   // nukta: ড় ड़ = r
      if (base === 0x0980 && off === 0x2F) { out += 'j'; continue; }
      if ((base === 0x0980 || base === 0x0B00) && off === 0x5F) continue;                 // য় ୟ = y (dropped)
      if (base === 0x0980 && off === 0x4E) { out += 't'; continue; }                      // ৎ khanda ta
      if (base === 0x0980 && off === 0x70) { out += 'r'; continue; }
      if (base === 0x0980 && off === 0x71) { out += 'b'; continue; }
      if (IND[off]) out += IND[off];
    }
  }
  return out.replace(/(.)\1+/g, '$1');
}
export const skeleton = (s) => String(s || '').toLowerCase().normalize('NFC').split(/[\s,.()\-/]+/).map(skeletonWord).filter(Boolean);

export class Combo {
  /**
   * @param {HTMLElement} root  .combo element
   * @param {{ items: () => Array<{id:number,label:string,sub?:string,keys:string[]}>, onChange?: Function }} opts
   */
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.input = root.querySelector('.combo-input');
    this.list = root.querySelector('.combo-list');
    this.otherNote = root.querySelector('.combo-other');
    this.value = { id: null, other: '' };
    this.active = -1;
    this.input.addEventListener('focus', () => this.open());
    this.input.addEventListener('click', () => this.open());
    this.input.addEventListener('input', () => { this.value = { id: null, other: '' }; this.open(); this.changed(); });
    this.input.addEventListener('keydown', (e) => this.key(e));
    this.input.addEventListener('blur', () => setTimeout(() => this.settle(), 150));
    this.list.addEventListener('mousedown', (e) => e.preventDefault());   // keep focus while tapping a row
    this.list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li) this.pick(+li.dataset.i);
    });
  }

  matches(q) {
    const items = this.opts.items();
    const f = fold(q);
    if (!f) return items;
    const words = f.split(' ');
    const qs = skeleton(q);
    const useSkel = qs.length && qs.join('').length >= 2;
    return items
      .map((it, order) => {
        const hay = it.keys.map(fold);
        let score = 0;
        for (const h of hay) {
          if (h === f) score = Math.max(score, 100);
          else if (h.startsWith(f)) score = Math.max(score, 80);
          else if (h.includes(f)) score = Math.max(score, 60);
          else if (words.every((w) => h.split(' ').some((hw) => hw.startsWith(w)))) score = Math.max(score, 50);
        }
        if (!score && useSkel) {   // sounds alike in another script or spelling
          const ks = (it._sk = it._sk || it.keys.map(skeleton));
          if (ks.some((k) => qs.every((w) => k.some((kw) => kw.startsWith(w))))) score = 40;
        }
        return { it, score, order };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map((x) => x.it);
  }

  open() {
    const q = this.value.id ? '' : this.input.value;
    this.rows = this.matches(q);
    const typed = this.input.value.trim();
    const otherLabel = typed && !this.value.id
      ? `${t('other_label')}: “${typed}”`
      : `${t('other_label')} — ${t('other_type')}`;
    this.list.innerHTML = this.rows.map((it, i) => `
      <li role="option" data-i="${i}" class="${this.value.id === it.id ? 'sel' : ''}">
        <span class="c-label">${esc(it.label)}</span>${it.sub ? `<span class="c-sub">${esc(it.sub)}</span>` : ''}
      </li>`).join('') +
      `<li role="option" data-i="-1" class="c-other ${this.value.id === null && this.value.other ? 'sel' : ''}"><span class="c-label">${esc(otherLabel)}</span></li>`;
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.active = -1;
  }
  close() { this.list.hidden = true; this.input.setAttribute('aria-expanded', 'false'); }

  pick(i) {
    if (i === -1) {
      const typed = this.input.value.trim();
      this.value = { id: null, other: typed };
      this.close();
      if (!typed) { this.input.placeholder = t('other_type'); this.input.focus(); this.otherMode = true; }
    } else {
      const it = this.rows[i];
      this.value = { id: it.id, other: '' };
      this.input.value = it.label;
      this.close();
      this.input.blur();
    }
    this.changed();
  }

  /** Called when leaving the field: an exact match is selected, anything else typed becomes "Other". */
  settle() {
    if (document.activeElement === this.input) return;
    this.close();
    if (this.value.id) return;
    const typed = this.input.value.trim();
    if (!typed) { this.value = { id: null, other: '' }; this.changed(); return; }
    const exact = this.opts.items().find((it) => it.keys.some((k) => fold(k) === fold(typed)));
    if (exact) { this.value = { id: exact.id, other: '' }; this.input.value = exact.label; }
    else this.value = { id: null, other: typed };
    this.changed();
  }

  key(e) {
    if (this.list.hidden && (e.key === 'ArrowDown' || e.key === 'Enter')) { this.open(); return; }
    const n = this.list.children.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); this.active = (this.active + 1) % n; this.highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.active = (this.active - 1 + n) % n; this.highlight(); }
    else if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      const li = this.active >= 0 ? this.list.children[this.active] : this.list.children[0];
      if (li) this.pick(+li.dataset.i);
    } else if (e.key === 'Escape') this.close();
  }
  highlight() { [...this.list.children].forEach((li, i) => li.classList.toggle('hl', i === this.active)); }

  /** Voice result: pick a confident match, otherwise keep the words and show suggestions. */
  fromVoice(text) {
    this.input.value = text;
    const m = this.matches(text);
    if (m.length === 1 || (m.length && m[0].keys.some((k) => fold(k) === fold(text)))) {
      this.value = { id: m[0].id, other: '' }; this.input.value = m[0].label; this.close();
    } else { this.value = { id: null, other: text }; this.input.focus(); this.open(); }
    this.changed();
  }

  set(val) {
    this.value = val || { id: null, other: '' };
    const it = this.value.id && this.opts.items().find((x) => x.id === this.value.id);
    this.input.value = it ? it.label : (this.value.other || '');
    this.changed();
  }
  relabel() { this.set(this.value); }
  reset() { this.otherMode = false; this.set({ id: null, other: '' }); this.close(); }

  changed() {
    const isOther = !this.value.id && !!this.value.other;
    this.otherNote.hidden = !isOther;
    this.otherNote.querySelector('.combo-other-text').textContent = this.value.other;
    this.root.classList.toggle('is-other', isOther);
    if (this.opts.onChange) this.opts.onChange(this.value);
  }
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** List entry for a localised option: label in the chosen language, English underneath. */
export function optionItem(o) {
  const lang = getLang();
  const local = (o.name_i18n && o.name_i18n[lang]) || o.name;
  const keys = [o.name, o.location || '', ...Object.values(o.name_i18n || {})];
  const sub = local !== o.name ? o.name : (o.location || '');
  return { id: o.id, label: local, sub, keys };
}
