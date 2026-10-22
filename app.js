import { getAll, get, put, del, getMeta, setMeta, newId, exportAll, replaceAll, DATA_STORES, clearStore } from './db.js';
import {
  processQueue, onAiChange, takeNotice, getSettings, isConfigured, getUsage, quotaReached, nextResetTime,
  callWorker, deepdivePrompt, polishText, pairKey, MODELS, DEFAULT_MODEL, DAILY_LIMIT, AiError,
} from './ai.js';
import { setupVoice } from './voice.js';
import { renderMap } from './map.js';

const INBOX = 'inbox'; // 未分類（boxId が null のメモ）を表すルート上のID
const LABELS = { idea: 'アイデア', task: 'タスク', diary: '日記' };

const $view = document.getElementById('view');
const $topbar = document.getElementById('topbar');
const $form = document.getElementById('inputbar');
const $input = document.getElementById('input');
const $send = document.getElementById('send');
const $mic = document.getElementById('mic');
const $toast = document.getElementById('toast');

let justAddedId = null;
let navigatedInApp = false;
let currentCleanup = null;
let currentRoute = { name: '' };

// ---------- 小物 ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function firstLine(text) {
  return (text || '').split('\n').find((l) => l.trim()) || '';
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDue(due) {
  if (!due) return '';
  const [y, m, d] = due.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date - today) / 86400000);
  const wd = '日月火水木金土'[date.getDay()];
  const rel = diff === 0 ? '今日' : diff === 1 ? '明日' : diff < 0 ? `${-diff}日過ぎ` : `あと${diff}日`;
  return `${m}/${d}(${wd}) · ${rel}`;
}

let toastTimer;
function toast(msg, ms = 2600) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), ms);
}

function go(hash) {
  navigatedInApp = true;
  location.hash = hash;
}

function back() {
  if (navigatedInApp && history.length > 1) history.back();
  else location.hash = '#/';
}

const ICONS = {
  back: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L14.9 3h-4l-.4 2.7a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.5 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.9h4l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5L19.4 13ZM12.9 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg>',
};
const backBtn = `<button class="icon-btn" data-action="back" aria-label="戻る">${ICONS.back}</button>`;

// 長押し（箱名・マップの線など）
function onLongPress(el, fn, ms = 500) {
  let timer = null;
  let sx = 0;
  let sy = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', (e) => {
    sx = e.clientX;
    sy = e.clientY;
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  });
  el.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

// 下から出るシート（片手で届く位置に選択肢を出す）
function openSheet(html) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="sheet-grip"></div>${html}</div>`;
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('show'));
  const sheet = backdrop.querySelector('.sheet');
  const close = () => {
    backdrop.classList.remove('show');
    setTimeout(() => backdrop.remove(), 220);
  };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  return { sheet, close };
}

// 画面ごとに新しい入れ物を作る（イベントが前の画面から積み重ならないように）
function mount(html) {
  const root = document.createElement('div');
  root.innerHTML = html;
  $view.replaceChildren(root);
  return root;
}

// ---------- データ操作 ----------

async function loadAll() {
  const [memos, boxes, links, suggestions] = await Promise.all([getAll('memos'), getAll('boxes'), getAll('links'), getAll('suggestions')]);
  memos.sort((a, b) => b.createdAt - a.createdAt);
  return { memos, boxes, links, suggestions };
}

async function addMemo(text, { inputMethod = 'text', rawTranscript = null, boxId = null } = {}) {
  const now = Date.now();
  const memo = {
    id: newId(),
    text,
    rawTranscript,
    inputMethod,
    createdAt: now,
    updatedAt: now,
    boxId,
    labels: [],
    due: null,
    aiStatus: 'pending', // pending → processing → done / failed
  };
  if (boxId) memo.keepBox = true;
  await put('memos', memo);
  processQueue();
  return memo;
}

async function deleteMemo(id) {
  await del('memos', id);
  for (const l of await getAll('links')) if (l.kind === 'memo-memo' && (l.from === id || l.to === id)) await del('links', l.id);
}

async function boxNameOf(id) {
  if (!id) return '未分類';
  return (await get('boxes', id))?.name || '未分類';
}

// 箱の付け替え。修正履歴に残し、次からのAIの振り分けに使う
async function moveMemo(memo, toBoxId) {
  if (memo.boxId === toBoxId) return;
  const from = await boxNameOf(memo.boxId);
  const to = await boxNameOf(toBoxId);
  await put('corrections', { id: newId(), at: Date.now(), memo: clip(memo.text, 60), from, to });
  memo.boxId = toBoxId;
  memo.aiStatus = 'done';
  memo.updatedAt = Date.now();
  await put('memos', memo);
  if (toBoxId) {
    const box = await get('boxes', toBoxId);
    if (box) { box.updatedAt = Date.now(); await put('boxes', box); }
  }
}

async function createBox(name) {
  const now = Date.now();
  const trimmed = name.trim().slice(0, 30);
  const existing = (await getAll('boxes')).find((b) => b.name === trimmed);
  if (existing) return existing;
  const box = { id: newId(), name: trimmed, description: '', createdAt: now, updatedAt: now };
  await put('boxes', box);
  return box;
}

async function mergeBoxes(fromId, intoId) {
  if (fromId === intoId) return;
  const [memos, links, suggestions] = await Promise.all([getAll('memos'), getAll('links'), getAll('suggestions')]);
  for (const m of memos) if (m.boxId === fromId) { m.boxId = intoId; await put('memos', m); }
  const seen = new Set(links.filter((l) => l.kind === 'box-box' && l.from !== fromId && l.to !== fromId).map((l) => pairKey(l.from, l.to)));
  for (const l of links) {
    if (l.kind !== 'box-box' || (l.from !== fromId && l.to !== fromId)) continue;
    const other = l.from === fromId ? l.to : l.from;
    await del('links', l.id);
    if (other === intoId || seen.has(pairKey(intoId, other))) continue;
    seen.add(pairKey(intoId, other));
    await put('links', { ...l, from: intoId, to: other });
  }
  for (const s of suggestions) {
    if (s.a === fromId || s.b === fromId) { s.status = s.status === 'open' ? 'done' : s.status; await put('suggestions', s); }
  }
  const into = await get('boxes', intoId);
  if (into) { into.updatedAt = Date.now(); await put('boxes', into); }
  await del('boxes', fromId);
}

async function deleteBox(id) {
  const [memos, links] = await Promise.all([getAll('memos'), getAll('links')]);
  for (const m of memos) if (m.boxId === id) { m.boxId = null; m.aiStatus = 'done'; await put('memos', m); }
  for (const l of links) if (l.kind === 'box-box' && (l.from === id || l.to === id)) await del('links', l.id);
  await del('boxes', id);
}

// 手動でつなぐ／消す。消した線は「削除済み」として残し、AIが再びつながないようにする
async function connectMemos(a, b) {
  if (a === b) return;
  const links = await getAll('links');
  const existing = links.find((l) => l.kind === 'memo-memo' && pairKey(l.from, l.to) === pairKey(a, b));
  if (existing) {
    existing.deleted = false;
    existing.by = 'manual';
    existing.strength = Math.max(existing.strength, 0.8);
    await put('links', existing);
  } else {
    await put('links', { id: newId(), from: a, to: b, kind: 'memo-memo', by: 'manual', strength: 0.8, deleted: false, createdAt: Date.now() });
  }
}

async function removeLink(link) {
  link.deleted = true;
  await put('links', link);
}

// ---------- ホーム ----------

async function renderHome() {
  const mode = (await getMeta('homeMode', 'list')) === 'map' ? 'map' : 'list';
  document.body.classList.remove('no-input');
  document.body.classList.toggle('map-mode', mode === 'map');

  $topbar.innerHTML = `
    <span class="title brand">Yozora</span>
    <div class="segmented" role="group" aria-label="表示切り替え">
      <button data-mode="list" aria-pressed="${mode === 'list'}">一覧</button>
      <button data-mode="map" aria-pressed="${mode === 'map'}">マップ</button>
    </div>
    <button class="icon-btn" data-action="settings" aria-label="設定">${ICONS.gear}</button>`;

  const data = await loadAll();
  if (mode === 'map') return renderMapView(data);

  const { memos, boxes, suggestions } = data;
  const configured = await isConfigured();
  const quota = configured && (await quotaReached());
  const banners = [];

  if (quota) banners.push(`<div class="banner">今日のAI枠を使い切りました。メモは保存されています。${nextResetTime().getHours()}時ごろにAI処理を再開します</div>`);
  if (!navigator.onLine) banners.push(`<div class="banner">オフラインです。メモは保存して、つながったらAIが整理します</div>`);
  if (!configured && memos.length) banners.push(`<a class="banner link" href="#/settings">設定でWorkerをつなぐと、AIが箱に整理します ›</a>`);

  const boxById = new Map(boxes.map((b) => [b.id, b]));
  for (const s of suggestions.filter((x) => x.status === 'open' && boxById.has(x.a) && boxById.has(x.b))) {
    banners.push(`<div class="banner suggest">
      <div>「${esc(boxById.get(s.a).name)}」と「${esc(boxById.get(s.b).name)}」をまとめる？${s.reason ? `<div class="banner-sub">${esc(s.reason)}</div>` : ''}</div>
      <div class="banner-actions">
        <button class="pill" data-suggest="${s.id}" data-act="dismiss">無視</button>
        <button class="pill primary" data-suggest="${s.id}" data-act="merge">まとめる</button>
      </div></div>`);
  }

  if (memos.length === 0 && boxes.length === 0) {
    $view.innerHTML = `${banners.join('')}<div class="empty"><div class="big-star"></div>まだ星がありません<br>下から思いついたことを投げ込んでみて</div>`;
    return;
  }

  const cards = [];
  // 未分類（AI待ち・処理中を含む）は常に一番上
  const inbox = memos.filter((m) => !m.boxId);
  if (inbox.length) {
    const waiting = inbox.filter((m) => m.aiStatus === 'pending' || m.aiStatus === 'processing').length;
    const failed = inbox.filter((m) => m.aiStatus === 'failed').length;
    const badges = [];
    if (waiting) {
      if (!configured) badges.push(`<span class="badge">AI未接続</span>`);
      else if (quota) badges.push(`<span class="badge">明日AIが整理</span>`);
      else if (!navigator.onLine) badges.push(`<span class="badge">オンライン待ち</span>`);
      else badges.push(`<span class="badge pending">処理中…</span>`);
    }
    if (failed) badges.push(`<span class="badge">分類できなかった ${failed}件</span>`);
    cards.push(cardHtml({
      href: `#/box/${INBOX}`,
      name: waiting && configured && !quota && navigator.onLine && waiting === inbox.length ? '処理中…' : '未分類',
      count: inbox.length,
      latest: firstLine(inbox[0].text),
      meta: badges.join(''),
      extraClass: 'inbox' + (inbox.some((m) => m.id === justAddedId) ? ' just-added' : ''),
    }));
  }

  // 箱は「最後にメモが入った順」
  const byBox = new Map(boxes.map((b) => [b.id, []]));
  for (const m of memos) if (m.boxId && byBox.has(m.boxId)) byBox.get(m.boxId).push(m);
  const sorted = boxes
    .map((b) => ({ box: b, items: byBox.get(b.id), last: byBox.get(b.id)[0]?.createdAt ?? b.updatedAt }))
    .sort((a, b) => b.last - a.last);

  for (const { box, items } of sorted) {
    const dueCount = items.filter((m) => m.due && m.labels.includes('task')).length;
    cards.push(cardHtml({
      href: `#/box/${box.id}`,
      name: box.name,
      count: items.length,
      latest: items[0] ? firstLine(items[0].text) : '',
      meta: dueCount ? `<span class="badge due">期限${dueCount}件</span>` : '',
      extraClass: items.some((m) => m.id === justAddedId) ? 'just-added' : '',
    }));
  }

  $view.innerHTML = `${banners.join('')}<ul class="cards">${cards.join('')}</ul>`;
  justAddedId = null;

  $view.querySelectorAll('[data-suggest]').forEach((btn) => btn.addEventListener('click', async () => {
    const s = await get('suggestions', btn.dataset.suggest);
    if (!s) return;
    if (btn.dataset.act === 'merge') {
      // メモの多い方に寄せる
      const count = (id) => memos.filter((m) => m.boxId === id).length;
      const [from, into] = count(s.a) >= count(s.b) ? [s.b, s.a] : [s.a, s.b];
      s.status = 'accepted';
      await put('suggestions', s);
      await mergeBoxes(from, into);
      toast('まとめました');
    } else {
      s.status = 'dismissed';
      await put('suggestions', s);
    }
    renderHome();
  }));
}

function cardHtml({ href, name, count, latest, meta, extraClass = '' }) {
  return `<li><a class="card ${extraClass}" href="${href}">
    <div class="card-head"><span class="star-dot"></span><span class="card-name">${esc(name)}</span><span class="card-count">${count}</span></div>
    ${latest ? `<div class="card-latest">${esc(latest)}</div>` : ''}
    ${meta ? `<div class="card-meta">${meta}</div>` : ''}
  </a></li>`;
}

async function renderMapView(data) {
  $view.innerHTML = `<div class="map-wrap" id="map-wrap"></div>
    <div class="map-legend"><span><i style="background:var(--idea)"></i>アイデア</span><span><i style="background:var(--task)"></i>タスク</span><span><i style="background:var(--diary)"></i>日記</span></div>`;
  const wrap = document.getElementById('map-wrap');
  const highlightId = justAddedId;
  justAddedId = null;
  const destroy = await renderMap(wrap, { ...data, highlightId }, {
    onOpenBox: (id) => go(`#/box/${id}`),
    onOpenMemo: (id) => go(`#/memo/${id}`),
    onDeleteLink: async (link) => {
      if (navigator.vibrate) navigator.vibrate(15);
      if (!confirm('このつながりを消しますか？')) return;
      await removeLink(link);
      toast('つながりを消しました');
      rerender();
    },
    onConnect: async (a, b) => {
      await connectMemos(a, b);
      toast('つなぎました');
      rerender();
    },
  });
  currentCleanup = destroy;
}

// ---------- 箱 ----------

async function renderBox(boxId, filter) {
  document.body.classList.remove('no-input', 'map-mode');
  const { memos } = await loadAll();
  const isInbox = boxId === INBOX;
  const box = isInbox ? { name: '未分類' } : await get('boxes', boxId);
  if (!box) return go('#/');

  const items = memos.filter((m) => (isInbox ? !m.boxId : m.boxId === boxId));
  const used = Object.keys(LABELS).filter((l) => items.some((m) => m.labels.includes(l)));
  const shown = filter ? items.filter((m) => m.labels.includes(filter)) : items;

  $topbar.innerHTML = `${backBtn}<span class="title" id="box-title">${esc(box.name)}</span>
    ${isInbox ? `<span class="card-count">${items.length}</span>` : `<button class="icon-btn" data-action="box-menu" aria-label="箱のメニュー">${ICONS.more}</button>`}`;
  if (!isInbox) onLongPress(document.getElementById('box-title'), () => openBoxMenu(box));

  const chips = used.length
    ? `<div class="chips">
        <a class="chip ${!filter ? 'on' : ''}" href="#/box/${boxId}">すべて ${items.length}</a>
        ${used.map((l) => `<a class="chip label ${l} ${filter === l ? 'on' : ''}" href="#/box/${boxId}/${l}">${LABELS[l]}</a>`).join('')}
      </div>`
    : '';
  const desc = !isInbox && box.description ? `<p class="box-desc">${esc(box.description)}</p>` : '';
  const retry = isInbox && items.some((m) => m.aiStatus === 'failed')
    ? `<button class="text-btn" data-action="retry-failed">分類できなかったメモをAIにもう一度渡す</button>` : '';

  $view.innerHTML = items.length
    ? `${desc}${chips}<ul class="cards">${shown.map(memoRowHtml).join('')}</ul>${retry}`
    : `${desc}<div class="placeholder">この箱は空です</div>`;

  $view.querySelector('[data-action="retry-failed"]')?.addEventListener('click', async () => {
    for (const m of items.filter((x) => x.aiStatus === 'failed')) { m.aiStatus = 'pending'; m.aiTries = 0; await put('memos', m); }
    processQueue();
    rerender();
  });
}

function memoRowHtml(m) {
  const labels = m.labels.map((l) => `<span class="badge label ${l}">${LABELS[l]}</span>`).join('');
  const due = m.due ? `<span class="badge due">${formatDue(m.due)}</span>` : '';
  const status = m.aiStatus === 'pending' || m.aiStatus === 'processing'
    ? `<span class="badge pending">${m.inputMethod === 'voice' && !m.polished ? '整えています…' : '処理中…'}</span>` : '';
  return `<li><a class="card memo-row" href="#/memo/${m.id}">
    <div class="memo-text">${esc(m.text)}</div>
    <div class="memo-date">${formatDate(m.createdAt)}${m.inputMethod === 'voice' ? ' · 音声' : ''}</div>
    ${labels || due || status ? `<div class="card-meta">${status}${labels}${due}</div>` : ''}
  </a></li>`;
}

async function openBoxMenu(box) {
  if (navigator.vibrate) navigator.vibrate(15);
  const { sheet, close } = openSheet(`
    <div class="sheet-title">${esc(box.name)}</div>
    <button class="sheet-item" data-act="rename">名前を変える</button>
    <button class="sheet-item" data-act="merge">他の箱と合体する</button>
    <button class="sheet-item danger" data-act="delete">箱を消す（中のメモは未分類へ）</button>
    <button class="sheet-item muted" data-close>やめる</button>`);
  sheet.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'rename') {
      close();
      const name = prompt('新しい箱の名前', box.name);
      if (!name || !name.trim() || name.trim() === box.name) return;
      box.name = name.trim().slice(0, 30);
      box.updatedAt = Date.now();
      await put('boxes', box);
      rerender();
    }
    if (act === 'merge') {
      close();
      openMergePicker(box);
    }
    if (act === 'delete') {
      close();
      const count = (await getAll('memos')).filter((m) => m.boxId === box.id).length;
      if (!confirm(`「${box.name}」を消しますか？\n中のメモ${count}件は未分類に移ります`)) return;
      await deleteBox(box.id);
      toast('箱を消しました');
      go('#/');
    }
  });
}

async function openMergePicker(box) {
  const boxes = (await getAll('boxes')).filter((b) => b.id !== box.id).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!boxes.length) return toast('合体できる箱がありません');
  const { sheet, close } = openSheet(`
    <div class="sheet-title">「${esc(box.name)}」をどの箱に合体する？</div>
    <div class="sheet-list">${boxes.map((b) => `<button class="sheet-item" data-into="${b.id}">${esc(b.name)}</button>`).join('')}</div>
    <button class="sheet-item muted" data-close>やめる</button>`);
  sheet.addEventListener('click', async (e) => {
    const into = e.target.closest('[data-into]')?.dataset.into;
    if (!into) return;
    close();
    await mergeBoxes(box.id, into);
    toast('合体しました');
    location.replace(`#/box/${into}`);
  });
}

// ---------- メモ ----------

async function renderMemo(id) {
  const memo = await get('memos', id);
  if (!memo) return go('#/');
  document.body.classList.add('no-input');
  document.body.classList.remove('map-mode');
  const [box, links, memos] = await Promise.all([memo.boxId ? get('boxes', memo.boxId) : null, getAll('links'), getAll('memos')]);
  const memoById = new Map(memos.map((m) => [m.id, m]));
  const related = links
    .filter((l) => l.kind === 'memo-memo' && !l.deleted && (l.from === id || l.to === id))
    .map((l) => ({ link: l, memo: memoById.get(l.from === id ? l.to : l.from) }))
    .filter((r) => r.memo)
    .sort((a, b) => b.link.strength - a.link.strength);
  const waiting = memo.aiStatus === 'pending' || memo.aiStatus === 'processing';
  const showDue = memo.labels.includes('task') || memo.due;

  $topbar.innerHTML = `${backBtn}<span class="title">メモ</span>`;
  const root = mount(`
    <textarea class="memo-edit" id="memo-edit" aria-label="本文">${esc(memo.text)}</textarea>
    <div class="memo-date" style="margin-top:8px">${formatDate(memo.createdAt)}${memo.inputMethod === 'voice' ? ' · 音声入力' : ''}${memo.updatedAt - memo.createdAt > 60000 ? `（編集 ${formatDate(memo.updatedAt)}）` : ''}${waiting ? ' · <span style="color:var(--star)">AI処理中…</span>' : ''}</div>

    <div class="field">
      <div class="field-label">箱</div>
      <button class="field-btn" data-action="pick-box"><span class="star-dot"></span>${esc(box ? box.name : '未分類')}<span class="chev">›</span></button>
    </div>

    <div class="field">
      <div class="field-label">種類</div>
      <div class="chips">${Object.entries(LABELS).map(([k, v]) => `<button class="chip label ${k} ${memo.labels.includes(k) ? 'on' : ''}" data-label="${k}" aria-pressed="${memo.labels.includes(k)}">${v}</button>`).join('')}</div>
    </div>

    ${showDue ? `<div class="field">
      <div class="field-label">期限</div>
      <div class="due-row">
        <input type="date" class="date-input" id="due" value="${memo.due || ''}">
        ${memo.due ? `<span class="due-rel">${esc(formatDue(memo.due).split(' · ')[1] || '')}</span><button class="pill" data-action="clear-due">期限なし</button>` : ''}
      </div>
    </div>` : ''}

    ${related.length ? `<div class="field">
      <div class="field-label">関連メモ</div>
      <ul class="cards compact">${related.map((r) => `<li><a class="card memo-row" href="#/memo/${r.memo.id}"><div class="memo-text one">${esc(firstLine(r.memo.text))}</div></a></li>`).join('')}</ul>
    </div>` : ''}

    ${memo.rawTranscript && memo.rawTranscript !== memo.text ? `<details class="field raw">
      <summary class="field-label">${memo.inputMethod === 'voice' ? '元の文字起こし' : '整える前の文'}</summary>
      <div class="field-value" style="white-space:pre-wrap">${esc(memo.rawTranscript)}</div>
    </details>` : ''}

    ${memo.inputMethod === 'voice' && !memo.polished ? '' : `<button class="text-btn" data-action="polish">✦ AIで文を整える</button>`}

    ${!memo.boxId && memo.aiStatus !== 'pending' && memo.aiStatus !== 'processing' ? `<button class="text-btn" data-action="reclassify">AIに振り分けてもらう</button>` : ''}
    <button class="text-btn danger" data-action="delete-memo">このメモを消す</button>

    <div class="bottom-actions">
      <button class="primary-btn" data-action="deepdive">✦ Claudeと深掘り</button>
    </div>`);

  const $edit = document.getElementById('memo-edit');
  let timer;
  const save = async () => {
    clearTimeout(timer);
    const text = $edit.value;
    const fresh = await get('memos', id);
    if (!fresh || !text.trim() || text === fresh.text) return;
    fresh.text = text;
    fresh.updatedAt = Date.now();
    await put('memos', fresh);
  };
  $edit.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 500); });
  $edit.addEventListener('blur', save);
  currentCleanup = save;

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action], [data-label]');
    if (!t) return;
    await save();
    const fresh = await get('memos', id);
    if (!fresh) return;
    if (t.dataset.label) {
      const l = t.dataset.label;
      fresh.labels = fresh.labels.includes(l) ? fresh.labels.filter((x) => x !== l) : [...fresh.labels, l];
      fresh.updatedAt = Date.now();
      await put('memos', fresh);
      return rerender();
    }
    switch (t.dataset.action) {
      case 'pick-box': return openBoxPicker(fresh);
      case 'clear-due':
        fresh.due = null;
        await put('memos', fresh);
        return rerender();
      case 'reclassify':
        fresh.aiStatus = 'pending';
        fresh.aiTries = 0;
        await put('memos', fresh);
        processQueue();
        return rerender();
      case 'delete-memo':
        if (!confirm('このメモを消しますか？')) return;
        currentCleanup = null;
        await deleteMemo(id);
        toast('メモを消しました');
        return back();
      case 'deepdive': return openDeepdive(fresh);
      case 'polish': return openPolish(fresh);
    }
  });

  document.getElementById('due')?.addEventListener('change', async (e) => {
    const fresh = await get('memos', id);
    fresh.due = e.target.value || null;
    fresh.updatedAt = Date.now();
    await put('memos', fresh);
    rerender();
  });
}

// キーボードのマイクで入れた文なども、あとから整えられる。整える前の文は残す
async function openPolish(memo) {
  if (!(await isConfigured())) return toast('先に設定でWorkerをつないでね');
  const { sheet, close } = openSheet(`
    <div class="sheet-title">AIで文を整える</div>
    <div class="polish-body"><div class="loading"><span class="star-dot"></span>整えています…</div></div>`);
  const body = sheet.querySelector('.polish-body');
  let text;
  try {
    text = await polishText(memo.text);
  } catch (e) {
    const msg = e instanceof AiError
      ? { quota: '今日のAI枠を使い切りました。明日もう一度試してね', unauthorized: '合言葉が違うようです', network: 'Workerにつながりませんでした' }[e.code]
      : null;
    body.innerHTML = `<p class="muted-text">${esc(msg || 'うまく整えられませんでした。もう一度試してね')}</p><button class="sheet-item muted" data-close>閉じる</button>`;
    return;
  }
  if (text.trim() === memo.text.trim()) {
    body.innerHTML = `<p class="muted-text">もう十分整っていました。</p><button class="sheet-item muted" data-close>閉じる</button>`;
    return;
  }
  body.innerHTML = `
    <div class="field-label">整えた文（直してから使ってもOK）</div>
    <textarea class="memo-edit prompt-edit" id="polished">${esc(text)}</textarea>
    <div class="row-actions">
      <button class="pill" data-close>やめる</button>
      <button class="pill primary" data-polish="apply">この文にする</button>
    </div>`;
  body.querySelector('[data-polish="apply"]').addEventListener('click', async () => {
    const fresh = await get('memos', memo.id);
    if (!fresh) return close();
    if (!fresh.rawTranscript) fresh.rawTranscript = fresh.text;
    fresh.text = body.querySelector('#polished').value.trim() || fresh.text;
    fresh.polished = true;
    // 描き直しの前の自動保存が、古い本文で上書きしないようにそろえておく
    const $edit = document.getElementById('memo-edit');
    if ($edit) $edit.value = fresh.text;
    fresh.updatedAt = Date.now();
    await put('memos', fresh);
    close();
    toast('整えました');
    rerender();
  });
}

// 箱の候補：AIがつないだ箱・関連メモの箱を上に、あとは最近使った順
async function boxCandidates(memo) {
  const [boxes, links, memos] = await Promise.all([getAll('boxes'), getAll('links'), getAll('memos')]);
  const score = new Map(boxes.map((b) => [b.id, 0]));
  const memoBox = new Map(memos.map((m) => [m.id, m.boxId]));
  for (const l of links) {
    if (l.deleted) continue;
    if (l.kind === 'box-box' && memo.boxId && (l.from === memo.boxId || l.to === memo.boxId)) {
      const other = l.from === memo.boxId ? l.to : l.from;
      if (score.has(other)) score.set(other, score.get(other) + l.strength * 2);
    }
    if (l.kind === 'memo-memo' && (l.from === memo.id || l.to === memo.id)) {
      const b = memoBox.get(l.from === memo.id ? l.to : l.from);
      if (b && score.has(b)) score.set(b, score.get(b) + l.strength * 3);
    }
  }
  return boxes
    .filter((b) => b.id !== memo.boxId)
    .sort((a, b) => score.get(b.id) - score.get(a.id) || b.updatedAt - a.updatedAt);
}

async function openBoxPicker(memo) {
  const candidates = await boxCandidates(memo);
  const { sheet, close } = openSheet(`
    <div class="sheet-title">どの箱に入れる？</div>
    <form class="new-box" id="new-box">
      <input type="text" id="new-box-name" placeholder="新しい箱の名前" maxlength="30" enterkeyhint="done">
      <button class="pill primary" type="submit">作る</button>
    </form>
    <div class="sheet-list">
      ${candidates.map((b) => `<button class="sheet-item" data-box="${b.id}">${esc(b.name)}${b.description ? `<span class="sheet-sub">${esc(b.description)}</span>` : ''}</button>`).join('')}
      ${memo.boxId ? `<button class="sheet-item muted" data-box="">未分類に戻す</button>` : ''}
    </div>
    <button class="sheet-item muted" data-close>やめる</button>`);
  const finish = async (boxId) => {
    close();
    await moveMemo(memo, boxId);
    toast(`「${await boxNameOf(boxId)}」に移しました`);
    rerender();
  };
  sheet.addEventListener('click', (e) => {
    const b = e.target.closest('[data-box]');
    if (b) finish(b.dataset.box || null);
  });
  sheet.querySelector('#new-box').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = sheet.querySelector('#new-box-name').value.trim();
    if (!name) return;
    const box = await createBox(name);
    finish(box.id);
  });
}

async function openDeepdive(memo) {
  if (!(await isConfigured())) return toast('先に設定でWorkerをつないでね');
  const { sheet, close } = openSheet(`
    <div class="sheet-title">Claudeと深掘り</div>
    <div class="deepdive-body"><div class="loading"><span class="star-dot"></span>問いかけを考えています…</div></div>`);
  const body = sheet.querySelector('.deepdive-body');
  let prompt;
  try {
    prompt = await deepdivePrompt(memo);
  } catch (e) {
    const msg = e instanceof AiError
      ? { quota: '今日のAI枠を使い切りました。明日もう一度試してね', unauthorized: '合言葉が違うようです', network: 'Workerにつながりませんでした' }[e.code]
      : null;
    body.innerHTML = `<p class="muted-text">${esc(msg || '問いかけを作れませんでした。もう一度試してね')}</p><button class="sheet-item muted" data-close>閉じる</button>`;
    return;
  }
  const claudeUrl = (p) => `https://claude.ai/new?q=${encodeURIComponent(p)}`;
  body.innerHTML = `
    <textarea class="memo-edit prompt-edit" id="dd-prompt">${esc(prompt)}</textarea>
    <div class="row-actions">
      <button class="pill" data-dd="copy">コピー</button>
      <a class="pill primary" id="dd-open" href="${claudeUrl(prompt)}" target="_blank" rel="noopener">Claudeで開く</a>
    </div>
    <details class="field">
      <summary class="field-label">深掘りした結果をメモにする</summary>
      <textarea class="memo-edit small" id="dd-result" placeholder="Claudeとの話のまとめを貼り付け"></textarea>
      <button class="pill primary" data-dd="save" style="margin-top:8px">「${esc(await boxNameOf(memo.boxId))}」に保存</button>
    </details>
    <button class="sheet-item muted" data-close>閉じる</button>`;
  const $p = body.querySelector('#dd-prompt');
  $p.addEventListener('input', () => { body.querySelector('#dd-open').href = claudeUrl($p.value); });
  body.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-dd]')?.dataset.dd;
    if (act === 'copy') {
      try {
        await navigator.clipboard.writeText($p.value);
        toast('コピーしました');
      } catch {
        $p.select();
        toast('選択したのでコピーしてね');
      }
    }
    if (act === 'save') {
      const text = body.querySelector('#dd-result').value.trim();
      if (!text) return toast('結果を貼り付けてね');
      const created = await addMemo(text, { boxId: memo.boxId });
      await connectMemos(memo.id, created.id);
      close();
      toast('同じ箱に保存しました');
      rerender();
    }
  });
}

// ---------- 設定 ----------

async function renderSettings() {
  document.body.classList.add('no-input');
  document.body.classList.remove('map-mode');
  $topbar.innerHTML = `${backBtn}<span class="title">設定</span>`;
  const s = await getSettings();
  const usage = await getUsage();
  const known = MODELS.some(([id]) => id === s.model);
  const reset = nextResetTime();

  const root = mount(`
    <section class="panel">
      <h2>AIの接続</h2>
      <label class="field-label" for="s-url">Worker URL</label>
      <input class="text-input" id="s-url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://yozora.xxxx.workers.dev" value="${esc(s.workerUrl)}">
      <label class="field-label" for="s-pass">合言葉</label>
      <div class="pass-row">
        <input class="text-input" id="s-pass" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(s.passphrase)}">
        <button class="pill" type="button" data-action="toggle-pass">表示</button>
      </div>
      <label class="field-label" for="s-model">モデル</label>
      <select class="text-input" id="s-model">
        ${MODELS.map(([id, label]) => `<option value="${id}" ${id === s.model ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        <option value="custom" ${known ? '' : 'selected'}>その他（名前を入力）</option>
      </select>
      <input class="text-input ${known ? 'hidden' : ''}" id="s-model-custom" placeholder="@cf/..." autocapitalize="off" spellcheck="false" value="${known ? '' : esc(s.model)}">
      <div class="row-actions">
        <button class="pill" data-action="test">接続テスト</button>
        <button class="pill primary" data-action="save">保存</button>
      </div>
      <p class="muted-text" id="s-status"></p>
    </section>

    <section class="panel">
      <h2>今日のAI使用量</h2>
      <div class="meter"><div style="width:${Math.min(100, (usage.neurons / DAILY_LIMIT) * 100)}%"></div></div>
      <p class="muted-text">約 ${Math.round(usage.neurons).toLocaleString()} / ${DAILY_LIMIT.toLocaleString()} Neurons（この端末で数えた目安）${usage.exhausted ? ' · 使い切りました' : ''}<br>毎日 ${reset.getHours()}:00 にリセット。超えても請求はされず、AI処理が翌日に回るだけです。</p>
    </section>

    <section class="panel">
      <h2>バックアップ</h2>
      <p class="muted-text">データはこの端末の中だけにあります。ときどき書き出しておくと安心です（合言葉は含みません）。</p>
      <div class="row-actions">
        <button class="pill" data-action="export">JSONで書き出す</button>
        <label class="pill">JSONから復元<input type="file" id="s-import" accept="application/json,.json" hidden></label>
      </div>
    </section>

    <section class="panel">
      <h2>全データ削除</h2>
      <p class="muted-text">メモ・箱・つながり・修正履歴をすべて消します。接続の設定は残ります。</p>
      <button class="text-btn danger" data-action="wipe" style="margin-top:8px">全データを削除</button>
    </section>
    <p class="muted-text center">Yozora v1</p>`);

  const $url = document.getElementById('s-url');
  const $pass = document.getElementById('s-pass');
  const $model = document.getElementById('s-model');
  const $custom = document.getElementById('s-model-custom');
  const $status = document.getElementById('s-status');
  $model.addEventListener('change', () => $custom.classList.toggle('hidden', $model.value !== 'custom'));

  const saveSettings = async () => {
    await setMeta('workerUrl', $url.value.trim().replace(/\/+$/, ''));
    await setMeta('passphrase', $pass.value.trim());
    await setMeta('model', $model.value === 'custom' ? ($custom.value.trim() || DEFAULT_MODEL) : $model.value);
  };

  root.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-action]')?.dataset.action;
    if (!act) return;
    if (act === 'toggle-pass') {
      $pass.type = $pass.type === 'password' ? 'text' : 'password';
      e.target.textContent = $pass.type === 'password' ? '表示' : '隠す';
    }
    if (act === 'save') {
      await saveSettings();
      $status.textContent = '保存しました';
      processQueue();
    }
    if (act === 'test') {
      await saveSettings();
      $status.textContent = '確認中…';
      try {
        const r = await callWorker('/ping');
        $status.textContent = `つながりました（${r.model}）`;
        processQueue();
      } catch (err) {
        $status.textContent = {
          not_configured: 'URLと合言葉を入れてね',
          unauthorized: '合言葉が違います',
          network: 'Workerにつながりません。URLを確認してね',
        }[err.code] || 'うまくいきませんでした';
      }
    }
    if (act === 'export') {
      const data = await exportAll();
      const payload = { app: 'yozora', version: 1, exportedAt: new Date().toISOString(), settings: { workerUrl: s.workerUrl, model: s.model }, ...data };
      const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      const d = new Date();
      a.href = URL.createObjectURL(blob);
      a.download = `yozora-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    if (act === 'wipe') {
      if (!confirm('すべてのメモと箱を消します。元に戻せません。よろしいですか？')) return;
      if (!confirm('本当に消しますか？（バックアップは取りましたか？）')) return;
      for (const name of DATA_STORES) await clearStore(name);
      try { localStorage.removeItem('yozora.mapPos'); } catch { /* 無視 */ }
      toast('全データを削除しました');
      go('#/');
    }
  });

  document.getElementById('s-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return toast('JSONとして読めませんでした');
    }
    if (data.app !== 'yozora' || !Array.isArray(data.memos)) return toast('Yozoraのバックアップではないようです');
    if (!confirm(`${new Date(data.exportedAt).toLocaleString()} のバックアップ（メモ${data.memos.length}件）で、今のデータを置き換えますか？`)) return;
    await replaceAll(data);
    if (data.settings?.workerUrl && !(await getMeta('workerUrl', ''))) await setMeta('workerUrl', data.settings.workerUrl);
    toast('復元しました');
    go('#/');
  });
}

// ---------- ルーティング ----------

async function route() {
  if (currentCleanup) {
    const fn = currentCleanup;
    currentCleanup = null;
    await fn();
  }
  document.querySelectorAll('.sheet-backdrop').forEach((el) => el.remove());
  const [, name, id, sub] = (location.hash || '#/').split('/');
  currentRoute = { name: name || 'home', id, sub };
  window.scrollTo(0, 0);
  if (name === 'box' && id) return renderBox(id, sub);
  if (name === 'memo' && id) return renderMemo(id);
  if (name === 'settings') return renderSettings();
  return renderHome();
}

// 今の画面を描き直す（スクロール位置は保つ）
async function rerender() {
  const y = window.scrollY;
  if (currentCleanup) {
    const fn = currentCleanup;
    currentCleanup = null;
    await fn();
  }
  const { name, id, sub } = currentRoute;
  if (name === 'box') await renderBox(id, sub);
  else if (name === 'memo') await renderMemo(id);
  else if (name === 'settings') return;
  else await renderHome();
  window.scrollTo(0, y);
}

window.addEventListener('hashchange', () => { navigatedInApp = true; route(); });

$topbar.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.action === 'back') back();
  if (t.dataset.action === 'settings') go('#/settings');
  if (t.dataset.action === 'box-menu') {
    const box = await get('boxes', currentRoute.id);
    if (box) openBoxMenu(box);
  }
  if (t.dataset.mode) {
    await setMeta('homeMode', t.dataset.mode);
    rerender();
  }
});

// AIの処理が進んだら画面に反映する（メモを編集中なら邪魔しない）
let aiRenderTimer;
onAiChange(() => {
  clearTimeout(aiRenderTimer);
  aiRenderTimer = setTimeout(() => {
    const n = takeNotice();
    if (n?.type === 'error') toast(n.message, 3500);
    if (currentRoute.name === 'settings') return;
    if (currentRoute.name === 'memo' && document.activeElement?.id === 'memo-edit') return;
    if (document.querySelector('.sheet-backdrop')) return;
    if (currentRoute.name === 'home' && document.body.classList.contains('map-mode') && n?.type !== 'classified') return;
    rerender();
  }, 150);
});

// ---------- 入力バー ----------

function autoGrow() {
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight + 2, window.innerHeight * 0.4) + 'px';
  $send.disabled = !$input.value.trim();
}

$input.addEventListener('input', autoGrow);

// iPhoneでは改行キーは改行のまま。PCでは ⌘/Ctrl+Enter で送信
$input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    $form.requestSubmit();
  }
});

async function submitMemo(text, opts) {
  const memo = await addMemo(text, opts);
  justAddedId = memo.id;
  const { name, id } = currentRoute;
  if (name === 'box' && id !== INBOX) toast('保存しました。AIが箱に振り分けます');
  if (name === 'box' && id === INBOX) rerender();
  else if (name === 'home') rerender();
}

$form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $input.value.trim();
  if (!text) return;
  $input.value = '';
  autoGrow();
  $input.focus(); // 続けて書けるようにキーボードは閉じない
  submitMemo(text);
});

setupVoice($mic, {
  onResult: async (text) => {
    await submitMemo(text, { inputMethod: 'voice', rawTranscript: text });
    if (navigator.onLine && (await isConfigured())) toast('話した内容をAIが整えています');
  },
  onMessage: (msg) => toast(msg, 3500),
});

// ---------- 起動 ----------

function measureTopbar() {
  document.documentElement.style.setProperty('--top-h', $topbar.offsetHeight + 'px');
}
new ResizeObserver(measureTopbar).observe($topbar);

window.addEventListener('online', () => { processQueue(); rerender(); });
window.addEventListener('offline', () => rerender());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') processQueue(); });

if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();
processQueue();
