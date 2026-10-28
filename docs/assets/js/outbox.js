// Offline outbox: registrations made without network are kept in IndexedDB
// and sent automatically when the phone is back online.
const DB = 'sammilani', STORE = 'outbox';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'client_id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}
export const queue = (payload) => tx('readwrite', (s) => s.put({ ...payload, queued_at: Date.now() }));
export const pending = () => tx('readonly', (s) => s.getAll());
export const remove = (id) => tx('readwrite', (s) => s.delete(id));

let flushing = false;
/** Try to send everything; returns number sent. */
export async function flush(send) {
  if (flushing || !navigator.onLine) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const item of await pending()) {
      try {
        await send({ ...item, force: true });   // duplicates were already confirmed on the device
        await remove(item.client_id); sent++;
      } catch (e) {
        if (e && e.status && e.status >= 400 && e.status < 500 && e.status !== 409) await remove(item.client_id);
        else break;   // still offline / server down: try later
      }
    }
  } finally { flushing = false; }
  return sent;
}
