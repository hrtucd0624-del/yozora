// Worker との通信と、メモの自動振り分け（仕様書5章）。
// メモは保存済みの状態で待ち行列に入り、オンライン・設定済み・AI枠ありの時に順番に処理する。
import { getAll, get, put, getMeta, setMeta, newId } from './db.js';

export const DEFAULT_MODEL = '@cf/openai/gpt-oss-120b';
export const MODELS = [
  ['@cf/openai/gpt-oss-120b', 'gpt-oss-120b（おすすめ・1件約60 Neuron）'],
  ['@cf/openai/gpt-oss-20b', 'gpt-oss-20b（軽い・約30 Neuron、整文は弱め）'],
  ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B（約50 Neuron）'],
];
export const DAILY_LIMIT = 10000;
const SAFE_LIMIT = 9400; // 上限の少し手前で翌日に回す
const MAX_TRIES = 3;

export class AiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// ---------- 設定・使用量 ----------

export async function getSettings() {
  return {
    workerUrl: await getMeta('workerUrl', ''),
    passphrase: await getMeta('passphrase', ''),
    model: await getMeta('model', DEFAULT_MODEL),
  };
}

export async function isConfigured() {
  const s = await getSettings();
  return Boolean(s.workerUrl && s.passphrase);
}

// Workers AI の無料枠は UTC 0時（日本時間9時）にリセットされる
export function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function nextResetTime() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1));
}

export async function getUsage() {
  const u = await getMeta('usage', null);
  if (!u || u.day !== utcDay()) return { day: utcDay(), neurons: 0, exhausted: false };
  return u;
}

async function addUsage(neurons, exhausted = false) {
  const u = await getUsage();
  u.neurons = Math.round((u.neurons + (neurons || 0)) * 10) / 10;
  if (exhausted) u.exhausted = true;
  await setMeta('usage', u);
}

export async function quotaReached() {
  const u = await getUsage();
  return u.exhausted || u.neurons >= SAFE_LIMIT;
}

// ---------- Worker 呼び出し ----------

export async function callWorker(path, body = {}) {
  const s = await getSettings();
  if (!s.workerUrl || !s.passphrase) throw new AiError('not_configured');
  if (path !== '/ping' && (await quotaReached())) throw new AiError('quota');
  let res;
  try {
    res = await fetch(s.workerUrl.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Yozora-Key': s.passphrase },
      body: JSON.stringify({ ...body, model: s.model || DEFAULT_MODEL }),
    });
  } catch {
    throw new AiError('network');
  }
  let data = null;
  try { data = await res.json(); } catch { /* 空 */ }
  if (res.status === 401) throw new AiError('unauthorized');
  if (res.status === 429 || data?.error === 'quota') {
    await addUsage(0, true);
    throw new AiError('quota');
  }
  if (!res.ok || !data) throw new AiError('failed', data?.message);
  if (typeof data.neurons === 'number') await addUsage(data.neurons);
  return data;
}

// ---------- 変更の通知 ----------

const listeners = new Set();
let lastNotice = null;

export function onAiChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(notice = null) {
  if (notice) lastNotice = notice;
  for (const fn of listeners) fn(notice);
}

export function takeNotice() {
  const n = lastNotice;
  lastNotice = null;
  return n;
}

// ---------- 待ち行列 ----------

let running = false;

export async function processQueue() {
  if (running || !navigator.onLine || !(await isConfigured())) return;
  if (await quotaReached()) return notify({ type: 'quota' });
  running = true;
  try {
    for (;;) {
      const waiting = (await getAll('memos'))
        .filter((m) => m.aiStatus === 'pending' || m.aiStatus === 'processing')
        .sort((a, b) => a.createdAt - b.createdAt);
      if (!waiting.length) break;
      const memo = waiting[0];
      memo.aiStatus = 'processing';
      await put('memos', memo);
      notify();
      try {
        await classifyMemo(memo);
        notify({ type: 'classified', memoId: memo.id });
      } catch (e) {
        const fresh = (await get('memos', memo.id)) || memo;
        if (e.code === 'failed') {
          fresh.aiTries = (fresh.aiTries || 0) + 1;
          fresh.aiStatus = fresh.aiTries >= MAX_TRIES ? 'failed' : 'pending';
        } else {
          fresh.aiStatus = 'pending';
        }
        await put('memos', fresh);
        if (e.code === 'quota') notify({ type: 'quota' });
        else if (e.code === 'unauthorized') notify({ type: 'error', message: '合言葉が違うようです。設定を確認してね' });
        else if (e.code === 'network') notify({ type: 'error', message: 'Workerにつながりませんでした。あとで自動で再開します' });
        else notify({ type: 'error', message: 'AI処理に失敗しました。あとでもう一度試します' });
        break;
      }
      if (await quotaReached()) {
        notify({ type: 'quota' });
        break;
      }
    }
  } finally {
    running = false;
    notify();
  }
}

export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

export function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

async function buildContext(memo) {
  const [memos, boxes, links, corrections, suggestions] = await Promise.all([
    getAll('memos'), getAll('boxes'), getAll('links'), getAll('corrections'), getAll('suggestions'),
  ]);
  memos.sort((a, b) => b.createdAt - a.createdAt);
  const boxName = new Map(boxes.map((b) => [b.id, b.name]));
  return {
    boxes: boxes.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description || '',
      recent: memos.filter((m) => m.boxId === b.id).slice(0, 3).map((m) => clip(m.text, 50)),
    })),
    recentMemos: memos
      .filter((m) => m.id !== memo.id && m.boxId)
      .slice(0, 25)
      .map((m) => ({ id: m.id, box: m.boxId, text: clip(m.text, 60) })),
    corrections: corrections
      .sort((a, b) => b.at - a.at)
      .slice(0, 20)
      .map((c) => ({ memo: c.memo, from: c.from, to: c.to })),
    blockedBoxLinks: links
      .filter((l) => l.kind === 'box-box' && l.deleted && boxName.has(l.from) && boxName.has(l.to))
      .map((l) => [l.from, l.to]),
    dismissedMerges: suggestions.map((s) => [s.a, s.b]),
  };
}

// 整文に使う言葉のヒント（箱の名前など、聞き間違えやすい固有名詞）
async function vocabulary() {
  const boxes = await getAll('boxes');
  return ['Yozora', ...boxes.map((b) => b.name)];
}

export async function polishText(text) {
  const data = await callWorker('/polish', { text, vocabulary: await vocabulary() });
  return data.text;
}

async function classifyMemo(memo) {
  // 音声入力はまず整文して、整った文をすぐ画面に出す（Typeless のように）
  if (memo.inputMethod === 'voice' && !memo.polished) {
    const text = await polishText(memo.rawTranscript || memo.text);
    const fresh = await get('memos', memo.id);
    if (!fresh) return;
    // 整文を待つ間に本人が書き直していたら、そちらを優先する
    if (fresh.text === (memo.rawTranscript || memo.text)) fresh.text = text;
    fresh.polished = true;
    await put('memos', fresh);
    notify({ type: 'polished', memoId: memo.id });
    memo = fresh;
  }
  const ctx = await buildContext(memo);
  const data = await callWorker('/classify', {
    today: localDay(),
    // 整文済みの音声メモは、振り分けで本文を書き換えないよう text として渡す
    memo: { text: memo.text, inputMethod: memo.inputMethod === 'voice' && !memo.polished ? 'voice' : 'text' },
    ...ctx,
  });
  const fresh = await get('memos', memo.id);
  if (!fresh) return; // 処理中に消された
  if (!data.result) {
    // 2回ともJSONが壊れていた → 未分類に置いておく
    fresh.aiStatus = 'failed';
    await put('memos', fresh);
    return;
  }
  await applyResult(fresh, data.result);
}

async function applyResult(memo, result) {
  const now = Date.now();
  const [boxes, allMemos, links, suggestions] = await Promise.all([
    getAll('boxes'), getAll('memos'), getAll('links'), getAll('suggestions'),
  ]);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
  const byName = new Map(boxes.map((b) => [norm(b.name), b]));
  const memoIds = new Set(allMemos.map((m) => m.id));
  const linkByPair = new Map(links.map((l) => [l.kind + ':' + pairKey(l.from, l.to), l]));

  async function resolveBox(item) {
    if (memo.keepBox && memo.boxId && byId.has(memo.boxId)) return memo.boxId;
    if (!item.box) return null;
    if (item.box.id && byId.has(item.box.id)) return item.box.id;
    const name = (item.box.new || item.box.id || '').trim();
    if (!name) return null;
    const found = byName.get(norm(name));
    if (found) return found.id;
    const box = { id: newId(), name, description: item.boxDescription || '', createdAt: now, updatedAt: now };
    await put('boxes', box);
    byId.set(box.id, box);
    byName.set(norm(name), box);
    return box.id;
  }

  async function addLink(kind, from, to, strength) {
    if (from === to) return;
    const key = kind + ':' + pairKey(from, to);
    const existing = linkByPair.get(key);
    if (existing) {
      if (existing.deleted) return; // 手動で消した線は二度とつながない
      if (strength > existing.strength) {
        existing.strength = strength;
        await put('links', existing);
      }
      return;
    }
    const link = { id: newId(), from, to, kind, by: 'ai', strength, deleted: false, createdAt: now };
    linkByPair.set(key, link);
    await put('links', link);
  }

  // 深掘りの結果など、箱が決まっているメモは分割しない
  const items = memo.keepBox ? [{ ...result.items[0], text: memo.text }] : result.items;
  const splitting = items.length > 1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const target = i === 0 ? memo : {
      id: newId(),
      rawTranscript: memo.rawTranscript,
      inputMethod: memo.inputMethod,
      createdAt: memo.createdAt + i, // 並び順を保つ
      splitFrom: memo.id,
    };
    // 分割なしなら本文はそのまま（音声は整文済み）。分割した時だけAIが切り出した文を使う
    if (splitting || (memo.inputMethod === 'voice' && !memo.polished)) target.text = item.text;
    target.boxId = await resolveBox(item);
    target.labels = item.labels.length ? item.labels : ['idea'];
    target.due = item.due || null;
    target.aiStatus = 'done';
    target.updatedAt = now;
    delete target.keepBox;
    await put('memos', target);
    memoIds.add(target.id);

    const box = target.boxId && byId.get(target.boxId);
    if (box) {
      if (item.boxDescription) box.description = item.boxDescription;
      box.updatedAt = now;
      await put('boxes', box);
      for (const r of item.relatedBoxes) if (byId.has(r.id)) await addLink('box-box', box.id, r.id, r.strength);
    }
    for (const r of item.related) if (memoIds.has(r.id)) await addLink('memo-memo', target.id, r.id, r.strength);
  }

  const m = result.merge;
  if (m && byId.has(m.a) && byId.has(m.b) && !suggestions.some((s) => pairKey(s.a, s.b) === pairKey(m.a, m.b))) {
    await put('suggestions', { id: newId(), a: m.a, b: m.b, reason: m.reason, status: 'open', createdAt: now });
  }
}

// ---------- 深掘り ----------

export async function deepdivePrompt(memo) {
  const [memos, links, box] = await Promise.all([
    getAll('memos'), getAll('links'), memo.boxId ? get('boxes', memo.boxId) : null,
  ]);
  const byId = new Map(memos.map((m) => [m.id, m]));
  const relatedIds = links
    .filter((l) => l.kind === 'memo-memo' && !l.deleted && (l.from === memo.id || l.to === memo.id))
    .map((l) => (l.from === memo.id ? l.to : l.from));
  const data = await callWorker('/deepdive', {
    memo: { text: memo.text },
    box: box ? { name: box.name, description: box.description } : null,
    sameBoxMemos: memo.boxId
      ? memos.filter((m) => m.boxId === memo.boxId && m.id !== memo.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 15).map((m) => clip(m.text, 120))
      : [],
    relatedMemos: relatedIds.map((id) => byId.get(id)).filter(Boolean).map((m) => clip(m.text, 160)),
  });
  return data.prompt;
}
