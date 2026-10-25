// iPhone と Mac の同期。各端末は自分の IndexedDB で動き、変更だけを Worker（D1）経由で交換する。
// 同じメモを両方で直した時は、あとから直した方が残る。
import { getAll, get, put, del, getMeta, setMeta, applyRemote, markAllForSync, getDeviceId, onLocalWrite } from './db.js';
import { callWorker, isConfigured } from './ai.js';

const BATCH = 300;
const INTERVAL = 30000;

let running = false;
let again = false;
let timer = null;
const listeners = new Set();

export function onSyncChange(fn) {
  listeners.add(fn);
}
function notify(info) {
  for (const fn of listeners) fn(info);
}

export async function syncEnabled() {
  return (await getMeta('syncEnabled', true)) && (await isConfigured());
}

export async function syncStatus() {
  return {
    enabled: await getMeta('syncEnabled', true),
    lastSync: await getMeta('lastSync', null),
    pending: (await getAll('outbox')).length,
    error: await getMeta('syncError', null),
  };
}

export function scheduleSync(delay = 2000) {
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

export async function syncNow() {
  if (running) { again = true; return; }
  if (!navigator.onLine || !(await syncEnabled())) return;
  running = true;
  let pulled = 0;
  try {
    // 初めての同期：この端末にある全部を送る。AIの振り分け待ちのメモは「この端末の担当」にしておく
    if (!(await getMeta('syncInit', false))) {
      const me = await getDeviceId();
      for (const m of await getAll('memos')) {
        if (!m.origin && (m.aiStatus === 'pending' || m.aiStatus === 'processing')) await put('memos', { ...m, origin: me });
      }
      await markAllForSync();
      await setMeta('syncInit', true);
    }

    for (let round = 0; round < 50; round++) {
      const outbox = (await getAll('outbox')).sort((a, b) => a.at - b.at).slice(0, BATCH);
      const changes = [];
      for (const e of outbox) {
        const data = e.deleted ? null : await get(e.store, e.id);
        changes.push({ store: e.store, id: e.id, at: e.at, deleted: e.deleted || !data, data });
      }
      const since = await getMeta('syncRev', 0);
      const res = await callWorker('/sync', { since, changes });

      // 送れた分を outbox から消す（送っている間に書き換わったものは残して次に送る）
      for (const e of outbox) {
        const now = await get('outbox', e.key);
        if (now && now.at === e.at) await del('outbox', e.key);
      }

      // 届いた変更を反映。まだ送っていない、こちらの新しい変更があればそちらを優先
      const pendingAt = new Map((await getAll('outbox')).map((e) => [e.key, e.at]));
      const incoming = res.changes.filter((c) => {
        const mine = pendingAt.get(`${c.store}|${c.id}`);
        return !(mine && mine > c.at);
      });
      await applyRemote(incoming);
      pulled += incoming.length;
      await setMeta('syncRev', res.rev);

      const left = (await getAll('outbox')).length;
      if (!res.more && left === 0) break;
    }
    await setMeta('lastSync', Date.now());
    await setMeta('syncError', null);
  } catch (e) {
    await setMeta('syncError', { unauthorized: '合言葉が違います', locked: '合言葉の間違いが続いたので1時間お休み中', network: 'つながりませんでした' }[e.code] || '同期に失敗しました');
  } finally {
    running = false;
    notify({ pulled });
    if (again) { again = false; scheduleSync(500); }
  }
}

// 書いたら少し待って送る。開いている間は30秒ごと、戻ってきた時・つながった時にも
export function startSync() {
  onLocalWrite(() => scheduleSync(2000));
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, INTERVAL);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  window.addEventListener('online', () => syncNow());
  syncNow();
}

// 初回の同期をやり直す（この端末の全部をもう一度送り、全部を受け取り直す）
export async function resetSync() {
  await setMeta('syncInit', false);
  await setMeta('syncRev', 0);
  return syncNow();
}

export { getDeviceId };
