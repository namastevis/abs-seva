// Voice input via the Web Speech API (Chrome/Android, Edge, Safari 14.5+).
import { toAsciiDigits } from './i18n.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const voiceSupported = !!SR;

let active = null;

/** Listen once and resolve with the best transcript. */
export function listen(lang, { onInterim } = {}) {
  if (!SR) return Promise.reject(new Error('unsupported'));
  if (active) { try { active.abort(); } catch (e) {} active = null; }
  return new Promise((resolve, reject) => {
    const rec = new SR();
    active = rec;
    rec.lang = lang;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    rec.continuous = false;
    let finalText = '';
    let alternatives = [];
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          finalText += r[0].transcript;
          alternatives = Array.from(r).map((a) => a.transcript);
        } else interim += r[0].transcript;
      }
      if (onInterim) onInterim(finalText + interim);
    };
    rec.onerror = (e) => { active = null; reject(new Error(e.error || 'error')); };
    rec.onend = () => {
      active = null;
      if (finalText.trim()) resolve({ text: finalText.trim(), alternatives });
      else reject(new Error('no-speech'));
    };
    try { rec.start(); } catch (e) { active = null; reject(e); }
  });
}
export function stopListening() { if (active) try { active.stop(); } catch (e) {} }

/* ---------- normalisers for spoken input ---------- */

// Spoken number words commonly returned in English recognisers
const EN_NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, oh: 0 };

export function spokenDigits(text) {
  let s = toAsciiDigits(text.toLowerCase());
  // "double 9" / "triple 5"
  s = s.replace(/\b(double|triple)\s+(\d)/g, (_, m, d) => d.repeat(m === 'double' ? 2 : 3));
  s = s.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|oh)\b/g, (w) => String(EN_NUM[w]));
  return s.replace(/\D/g, '');
}

export function spokenEmail(text) {
  let s = text.toLowerCase().trim();
  s = s.replace(/\s*(at the rate of|at the rate|at sign|\bat\b|@)\s*/g, '@');
  s = s.replace(/\s*(dot|full stop|period)\s*/g, '.');
  s = s.replace(/\s*(underscore)\s*/g, '_').replace(/\s*(hyphen|dash)\s*/g, '-');
  s = toAsciiDigits(s).replace(/\s+/g, '');
  return s;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Pick the option that best matches what was said.
 * options: [{ value, labels: [string,...] }]
 */
export function matchOption(said, options) {
  const candidates = Array.isArray(said) ? said : [said];
  let best = null, bestScore = 0;
  for (const heard of candidates) {
    const h = norm(heard);
    if (!h) continue;
    const hTokens = new Set(h.split(' '));
    for (const opt of options) {
      for (const label of opt.labels) {
        const l = norm(label);
        if (!l) continue;
        let score = 0;
        if (h === l) score = 100;
        else if (h.includes(l) || l.includes(h)) score = 60 + Math.min(l.length, h.length);
        else {
          const lt = l.split(' ');
          const hits = lt.filter((tok) => tok.length > 2 && hTokens.has(tok)).length;
          score = hits ? (hits / lt.length) * 50 : 0;
        }
        if (score > bestScore) { bestScore = score; best = opt.value; }
      }
    }
  }
  return bestScore >= 20 ? best : null;
}

// Extra spoken synonyms for gender (all languages)
export const GENDER_SYNONYMS = {
  Male: ['male', 'man', 'boy', 'gents', 'purush', 'purusha', 'पुरुष', 'आदमी', 'ପୁରୁଷ', 'পুরুষ', 'পুৰুষ', 'ছেলে', 'লৰা', 'ପୁଅ'],
  Female: ['female', 'woman', 'girl', 'lady', 'ladies', 'mahila', 'महिला', 'स्त्री', 'औरत', 'ମହିଳା', 'ମାଇକିନିଆ', 'মহিলা', 'মেয়ে', 'ছোৱালী', 'নাৰী', 'নারী', 'ଝିଅ'],
};
