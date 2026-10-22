// マップモード（仕様書3-1）。d3-force で箱（大きい星）とメモ（小さい星）を描く。
const D3_URL = 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';
let d3Promise = null;

const COLORS = { idea: '#b6a6ff', task: '#7fdcc8', diary: '#f5b3c6' };
const STAR = '#ffe9b3';
const DAY = 86400000;

function memoColor(m) {
  return COLORS[m.labels?.[0]] || STAR;
}

// 新しいメモほど明るい（1日以内はいちばん明るく、30日でかなり暗く）
function memoBrightness(m, now) {
  const age = Math.max(0, (now - m.createdAt) / DAY);
  return 0.28 + 0.72 * Math.exp(-age / 8);
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export async function renderMap(container, data, handlers) {
  d3Promise ||= import(D3_URL);
  let d3;
  try {
    d3 = await d3Promise;
  } catch {
    d3Promise = null;
    container.innerHTML = `<div class="placeholder">マップの部品を読み込めませんでした。<br>オンラインで一度開いてね</div>`;
    return () => {};
  }

  const { memos, boxes, links, highlightId } = data;
  const now = Date.now();
  const width = container.clientWidth || 360;
  const height = container.clientHeight || 600;

  if (!memos.length && !boxes.length) {
    container.innerHTML = `<div class="placeholder">まだ星がありません</div>`;
    return () => {};
  }

  const countByBox = new Map();
  for (const m of memos) if (m.boxId) countByBox.set(m.boxId, (countByBox.get(m.boxId) || 0) + 1);

  const nodes = [
    ...boxes.map((b) => ({ id: 'b:' + b.id, ref: b.id, type: 'box', name: b.name, r: 13 + Math.sqrt(countByBox.get(b.id) || 0) * 4 })),
    ...memos.map((m) => ({ id: 'm:' + m.id, ref: m.id, type: 'memo', memo: m, r: 5.5, color: memoColor(m), bright: memoBrightness(m, now) })),
  ];
  const nodeIds = new Set(nodes.map((n) => n.id));

  // 前回の位置を覚えておくと、開き直した時に星座の形が保たれる
  const saved = loadPositions();
  for (const n of nodes) {
    const p = saved[n.id];
    if (p) { n.x = p[0]; n.y = p[1]; }
  }
  // 新しいメモは、箱の近くから現れる
  for (const n of nodes) {
    if (n.x != null || n.type !== 'memo') continue;
    const home = n.memo.boxId && saved['b:' + n.memo.boxId];
    if (home) { n.x = home[0] + (Math.random() - 0.5) * 30; n.y = home[1] + (Math.random() - 0.5) * 30; }
  }

  const edges = [];
  for (const m of memos) {
    if (m.boxId && nodeIds.has('b:' + m.boxId)) edges.push({ source: 'm:' + m.id, target: 'b:' + m.boxId, kind: 'member', strength: 0.4 });
  }
  for (const l of links) {
    if (l.deleted) continue;
    const prefix = l.kind === 'box-box' ? 'b:' : 'm:';
    const s = prefix + l.from;
    const t = prefix + l.to;
    if (nodeIds.has(s) && nodeIds.has(t)) edges.push({ source: s, target: t, kind: l.kind, strength: l.strength, link: l });
  }

  container.innerHTML = '';
  const svg = d3.select(container).append('svg')
    .attr('class', 'map-svg')
    .attr('viewBox', [-width / 2, -height / 2, width, height])
    .attr('width', width)
    .attr('height', height);

  svg.append('defs').html(`
    <filter id="glow" x="-200%" y="-200%" width="500%" height="500%">
      <feGaussianBlur stdDeviation="3" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <radialGradient id="boxGrad">
      <stop offset="0%" stop-color="#fff6dc" stop-opacity=".95"/>
      <stop offset="45%" stop-color="${STAR}" stop-opacity=".55"/>
      <stop offset="100%" stop-color="${STAR}" stop-opacity="0"/>
    </radialGradient>`);

  const world = svg.append('g');
  const linkLayer = world.append('g');
  const nodeLayer = world.append('g');

  const zoom = d3.zoom().scaleExtent([0.25, 4]).on('zoom', (e) => world.attr('transform', e.transform));
  svg.call(zoom).on('dblclick.zoom', null);
  const savedZoom = loadZoom();
  if (savedZoom) svg.call(zoom.transform, d3.zoomIdentity.translate(savedZoom.x, savedZoom.y).scale(savedZoom.k));

  const linkSel = linkLayer.selectAll('g').data(edges).join('g').attr('class', (d) => 'edge ' + d.kind);
  const line = linkSel.append('line')
    .attr('stroke-width', (d) => (d.kind === 'member' ? 0.6 : d.kind === 'box-box' ? 1 + d.strength * 3 : 0.6 + d.strength * 2.4));
  // 長押ししやすいよう、見えない太い線を重ねる
  const hit = linkSel.filter((d) => d.kind !== 'member').append('line').attr('class', 'edge-hit');

  hit.on('pointerdown', (e, d) => {
    e.stopPropagation();
    const timer = setTimeout(() => handlers.onDeleteLink(d.link), 550);
    const cancel = () => { clearTimeout(timer); window.removeEventListener('pointerup', cancel); window.removeEventListener('pointermove', move); };
    const sx = e.clientX, sy = e.clientY;
    const move = (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) cancel(); };
    window.addEventListener('pointerup', cancel);
    window.addEventListener('pointermove', move);
  });

  const nodeSel = nodeLayer.selectAll('g').data(nodes).join('g')
    .attr('class', (d) => 'node ' + d.type + (highlightId && d.ref === highlightId ? ' arrive' : ''));

  nodeSel.filter((d) => d.type === 'box').call((g) => {
    g.append('circle').attr('r', (d) => d.r * 1.9).attr('fill', 'url(#boxGrad)').attr('class', 'halo');
    g.append('circle').attr('r', (d) => d.r * 0.42).attr('fill', '#fffaf0').attr('class', 'core');
    g.append('text').attr('dy', (d) => d.r * 1.25 + 12).attr('text-anchor', 'middle').text((d) => clip(d.name, 10));
  });
  nodeSel.filter((d) => d.type === 'memo').call((g) => {
    g.append('circle').attr('r', 14).attr('class', 'tap'); // タップしやすい範囲
    g.append('circle')
      .attr('r', (d) => d.r)
      .attr('fill', (d) => d.color)
      .attr('opacity', (d) => d.bright)
      .attr('filter', (d) => (d.bright > 0.6 ? 'url(#glow)' : null));
  });

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id((d) => d.id)
      .distance((d) => (d.kind === 'member' ? 34 : d.kind === 'box-box' ? 150 : 70))
      .strength((d) => (d.kind === 'member' ? 0.7 : d.kind === 'box-box' ? 0.08 + d.strength * 0.1 : 0.1 + d.strength * 0.2)))
    .force('charge', d3.forceManyBody().strength((d) => (d.type === 'box' ? -220 : -40)))
    .force('collide', d3.forceCollide((d) => (d.type === 'box' ? d.r + 10 : d.r + 3)))
    .force('x', d3.forceX(0).strength(0.03))
    .force('y', d3.forceY(0).strength(0.03))
    .alpha(saved && Object.keys(saved).length ? 0.4 : 1)
    .on('tick', ticked);

  // 全体が画面に収まるようにズームする（初回と、背景のダブルタップ）
  function fit(animate = true) {
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const k = Math.max(0.3, Math.min(1.6, 0.85 * Math.min(width / (maxX - minX + 120), height / (maxY - minY + 120))));
    const t = d3.zoomIdentity.scale(k).translate(-(minX + maxX) / 2, -(minY + maxY) / 2);
    (animate ? svg.transition().duration(500) : svg).call(zoom.transform, t);
  }
  if (!savedZoom) sim.on('end.fit', () => { sim.on('end.fit', null); fit(); });
  svg.on('dblclick', (e) => { if (e.target === svg.node()) fit(); });

  function ticked() {
    line.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y).attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
    hit.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y).attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
    nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
  }

  // ドラッグ：箱は動かすだけ。メモを別のメモの上で離すと手動でつなぐ
  let dropTarget = null;
  const drag = d3.drag()
    .clickDistance(6)
    .on('start', (e, d) => {
      if (!e.active) sim.alphaTarget(0.2).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on('drag', (e, d) => {
      d.fx = e.x;
      d.fy = e.y;
      if (d.type !== 'memo') return;
      const near = nodes.find((n) => n !== d && n.type === 'memo' && Math.hypot(n.x - e.x, n.y - e.y) < 16);
      if (near !== dropTarget) {
        nodeSel.classed('drop-target', (n) => n === near);
        dropTarget = near || null;
      }
    })
    .on('end', (e, d) => {
      if (!e.active) sim.alphaTarget(0);
      d.fx = null;
      d.fy = null;
      if (dropTarget) {
        const target = dropTarget;
        dropTarget = null;
        nodeSel.classed('drop-target', false);
        handlers.onConnect(d.ref, target.ref);
      }
    });
  nodeSel.call(drag);
  nodeSel.on('click', (e, d) => {
    if (d.type === 'box') handlers.onOpenBox(d.ref);
    else handlers.onOpenMemo(d.ref);
  });

  return () => {
    sim.stop();
    const pos = {};
    for (const n of nodes) if (n.x != null) pos[n.id] = [Math.round(n.x), Math.round(n.y)];
    savePositions(pos);
    const t = d3.zoomTransform(svg.node());
    saveZoom({ x: t.x, y: t.y, k: t.k });
  };
}

// 位置やズームは端末ごとの見た目の好みなので localStorage に置く（消えても困らない）
function loadPositions() {
  try { return JSON.parse(localStorage.getItem('yozora.mapPos') || '{}'); } catch { return {}; }
}
function savePositions(p) {
  try { localStorage.setItem('yozora.mapPos', JSON.stringify(p)); } catch { /* 無視 */ }
}
function loadZoom() {
  try { return JSON.parse(localStorage.getItem('yozora.mapZoom') || 'null'); } catch { return null; }
}
function saveZoom(z) {
  try { localStorage.setItem('yozora.mapZoom', JSON.stringify(z)); } catch { /* 無視 */ }
}
