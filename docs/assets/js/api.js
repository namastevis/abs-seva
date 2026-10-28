// API client for the Google Apps Script backend (see config.js for its URL).
// Every call is a "simple" POST (text/plain), which Apps Script accepts from any website
// without a CORS preflight. Admin calls carry the login token from localStorage.
const BASE = window.SEVA_API || '';
const TOKEN_KEY = 'sevaAdminToken';

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } };
export const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} };

async function call(route, body = {}) {
  if (!BASE || BASE.includes('PASTE-YOUR')) throw new ApiError('The site is not connected to its Google Sheet yet (config.js).', 503);
  const payload = { ...body, r: route };
  const tok = getToken(); if (tok && !payload.token) payload.token = tok;
  const res = await fetch(`${BASE}?r=${encodeURIComponent(route)}`, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload),
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data) throw new ApiError(res.statusText || 'Network error', res.status >= 400 ? res.status : 502, data);
  if (data.ok === false && data.status) throw new ApiError(data.error || 'Error', data.status, data);
  return data;
}
export const apiGet = (route, params = {}) => call(route, Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null && v !== false)));
export const apiPost = call;

/** Photo stored as "drive:<file id>" → public image URL; older relative paths still work. */
export const assetUrl = (p) => {
  if (!p) return '';
  const m = /^drive:(.+)$/.exec(p);
  if (m) return (window.SEVA_PHOTO_URL || 'https://lh3.googleusercontent.com/d/{id}=w800').replace('{id}', m[1]);
  return /^(https?:|data:)/.test(p) ? p : new URL('../../' + p, import.meta.url).href;
};
