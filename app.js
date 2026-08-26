'use strict';

/* =========================================================
   LOUNGE'X 후보지 관리

   데이터 구조는 구글 시트 "4. 후보지" 표를 그대로 따른다.
   금액은 시트와 같은 천원 단위로 저장하고, 화면에서만 억·만원으로 환산해 보여준다.
   ========================================================= */

const STORAGE_KEY = 'loungex.candidates.v2';
const SEED_URL = 'data/candidates.json';

/* 시트의 "결과" 열 값. key 는 저장값이라 바꾸면 기존 데이터가 깨진다. */
const STATUSES = [
  { key: 'review',   label: '후보지',   cls: 'st-review',   color: '#4263eb' },
  { key: 'progress', label: '진행중',   cls: 'st-progress', color: '#f08c00' },
  { key: 'signed',   label: '계약완료', cls: 'st-signed',   color: '#2f9e44' },
  { key: 'etc',      label: '기타',     cls: 'st-etc',      color: '#adb5bd' },
];
const STATUS_MAP = Object.fromEntries(STATUSES.map((s) => [s.key, s]));
const ACTIVE_KEYS = ['progress'];
const KINDS = ['직영', '가맹', '베이커리'];

const state = {
  items: [],
  view: 'list',
  search: '',
  statusFilter: '',
  regionFilter: '',
  ownerFilter: '',
  kindFilter: '',
  sortKey: 'name',
  sortDir: 'asc',
  editingId: null,
  savedAt: null,
};

const charts = { status: null, region: null, scatter: null };

/* ===== 유틸 ===== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function uid() {
  return 'c_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* 천원 → 사람이 읽는 단위. 1억원 = 100,000천원 */
function money(v) {
  const n = num(v);
  if (!n) return '-';
  if (n >= 100000) {
    const eok = n / 100000;
    return (Number.isInteger(eok) ? String(eok) : eok.toFixed(1)) + '억';
  }
  const man = n / 10;
  return (Number.isInteger(man) ? man.toLocaleString('ko-KR') : man.toFixed(1)) + '만';
}
function moneyWon(v) {
  const s = money(v);
  return s === '-' ? '-' : s + '원';
}
function dateStr(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}
function timeStr(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function todayISO() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function naverPlaceId(url) {
  const m = String(url || '').match(/place\/(\d+)/);
  return m ? m[1] : '';
}
function mapUrl(item) {
  if (item.naverUrl) return item.naverUrl;
  if (item.placeId) return `https://map.naver.com/p/entry/place/${item.placeId}`;
  const q = encodeURIComponent(item.address || item.name || '');
  return `https://map.naver.com/p/search/${q}`;
}
/* 임차료 표기 — 고정 임차료가 없고 수수료율만 있는 물건이 많다 */
function rentLabel(it) {
  if (num(it.rent)) return money(it.rent);
  if (num(it.feeRate)) return `수수료 ${num(it.feeRate)}%`;
  return '-';
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2400);
}
function icons() {
  if (window.lucide) window.lucide.createIcons();
}

/* ===== 저장소 ===== */
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { items: [], savedAt: null };
    const parsed = JSON.parse(raw);
    return { items: Array.isArray(parsed.items) ? parsed.items : [], savedAt: parsed.savedAt || null };
  } catch (e) {
    console.error('저장 데이터를 읽지 못했습니다', e);
    return { items: [], savedAt: null };
  }
}

function normalize(o) {
  const item = Object.assign(
    {
      id: uid(), name: '', kind: '', channel: '', owner: '',
      address: '', naverUrl: '', placeId: '', region: '',
      status: 'review', floor: '', area: 0,
      deposit: 0, rent: 0, feeRate: 0, maintenance: 0, premium: 0,
      termsNote: '', pnl: '', availableAt: '', memo: '', contractNote: '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    o
  );
  // 제안완료·드랍 폐지. 이미 저장된 값은 옮겨 받는다
  if (item.status === 'proposed') item.status = 'progress';
  if (item.status === 'drop') item.status = 'etc';
  if (!STATUS_MAP[item.status]) item.status = 'review';
  // 정렬·표시에 쓰는 파생값
  item.initial = num(item.deposit) + num(item.premium);
  item.rentPerPyeong = num(item.area) && num(item.rent) ? num(item.rent) / num(item.area) : 0;
  return item;
}

function filtered() {
  const q = state.search.trim().toLowerCase();
  return state.items.filter((it) => {
    if (state.statusFilter && it.status !== state.statusFilter) return false;
    if (state.regionFilter && (it.region || '') !== state.regionFilter) return false;
    if (state.ownerFilter && (it.owner || '') !== state.ownerFilter) return false;
    if (state.kindFilter && (it.kind || '') !== state.kindFilter) return false;
    if (!q) return true;
    return [it.name, it.address, it.region, it.memo, it.owner, it.floor, it.termsNote, it.pnl, it.contractNote]
      .some((v) => String(v || '').toLowerCase().includes(q));
  });
}

function sorted(list) {
  const k = state.sortKey;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const order = (s) => STATUSES.findIndex((x) => x.key === s);
  return list.slice().sort((a, b) => {
    let va, vb;
    if (k === 'status') { va = order(a.status); vb = order(b.status); }
    else { va = a[k]; vb = b[k]; }
    if (typeof va === 'number' || typeof vb === 'number') return (num(va) - num(vb)) * dir;
    // 빈 값은 방향과 상관없이 항상 뒤로
    const sa = String(va || ''), sb = String(vb || '');
    if (!sa && sb) return 1;
    if (sa && !sb) return -1;
    return sa.localeCompare(sb, 'ko') * dir;
  });
}

const uniq = (key) =>
  Array.from(new Set(state.items.map((i) => i[key]).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ko'));

/* ===== 렌더 ===== */
function render() {
  $('#navCountList').textContent = state.items.length;
  $('#navCountBoard').textContent = state.items.filter((i) => ACTIVE_KEYS.includes(i.status)).length;
  renderKpis();
  renderChips();
  renderFilters();
  renderTable();
  renderBoard();
  if (state.view === 'stats') renderStats();
  icons();
}

function kpiCard(o) {
  return `
    <div class="kpi-card${o.accent ? ' accent' : ''}">
      <div class="kpi-icon"><i data-lucide="${o.icon}"></i></div>
      <div class="kpi-label">${esc(o.label)}</div>
      <div class="kpi-value">${o.value}${o.unit ? `<small>${esc(o.unit)}</small>` : ''}</div>
      <div class="kpi-sub">${esc(o.sub)}</div>
    </div>`;
}

function renderKpis() {
  const items = state.items;
  const by = (k) => items.filter((i) => i.status === k).length;
  const kinds = KINDS.map((k) => `${k} ${items.filter((i) => i.kind === k).length}`).join(' · ');

  $('#kpiRow').innerHTML = [
    kpiCard({ accent: true, icon: 'map-pin', label: '전체 후보지', value: items.length, unit: '곳', sub: kinds }),
    kpiCard({ icon: 'search-check', label: '후보지', value: by('review'), unit: '곳', sub: `기타 ${by('etc')}곳` }),
    kpiCard({ icon: 'activity', label: '진행중', value: by('progress'), unit: '곳', sub: `전체의 ${items.length ? Math.round((by('progress') / items.length) * 100) : 0}%` }),
    kpiCard({ icon: 'circle-check', label: '계약완료', value: by('signed'), unit: '곳', sub: `진행중 포함 ${by('progress') + by('signed')}곳` }),
  ].join('');
}

function renderChips() {
  const counts = {};
  state.items.forEach((i) => { counts[i.status] = (counts[i.status] || 0) + 1; });
  const chip = (key, label, n) => `
    <button class="chip${state.statusFilter === key ? ' active' : ''}" data-status="${key}">
      ${esc(label)}<span class="chip-count">${n}</span>
    </button>`;
  $('#statusChips').innerHTML =
    chip('', '전체', state.items.length) +
    STATUSES.map((s) => chip(s.key, s.label, counts[s.key] || 0)).join('');
}

function fillSelect(sel, values, cur, allLabel) {
  sel.innerHTML = `<option value="">${allLabel}</option>` +
    values.map((v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

function renderFilters() {
  fillSelect($('#regionFilter'), uniq('region'), state.regionFilter, '전체 지역');
  fillSelect($('#ownerFilter'), uniq('owner'), state.ownerFilter, '전체 담당자');
  fillSelect($('#kindFilter'), uniq('kind'), state.kindFilter, '전체 구분');
  $('#regionList').innerHTML = uniq('region').map((r) => `<option value="${esc(r)}"></option>`).join('');
  $('#ownerList').innerHTML = uniq('owner').map((r) => `<option value="${esc(r)}"></option>`).join('');
}

function kindTag(kind) {
  if (!kind) return '<span class="kind-tag none">-</span>';
  const cls = { 직영: 'direct', 가맹: 'fc', 베이커리: 'bakery' }[kind] || 'none';
  return `<span class="kind-tag ${cls}">${esc(kind)}</span>`;
}

function renderTable() {
  const rows = sorted(filtered());
  const body = $('#tableBody');

  $$('#tableCard thead th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sortKey);
  });

  if (!state.items.length) {
    $('#tableCard').hidden = true;
    $('#listEmpty').hidden = false;
    $('#listEmpty').innerHTML = `
      <div class="empty-state">
        <div class="ei"><i data-lucide="map-pinned"></i></div>
        <h3>등록된 후보지가 없습니다</h3>
        <p>구글 시트의 후보지 표를 불러오거나, 직접 추가하세요.</p>
        <div class="empty-actions">
          <button class="btn" id="emptySeed"><i data-lucide="rotate-ccw"></i><span>시트 원본 불러오기</span></button>
          <button class="btn ghost" id="emptyAdd"><i data-lucide="plus"></i><span>직접 추가</span></button>
        </div>
      </div>`;
    $('#emptyAdd').onclick = () => openForm();
    $('#emptySeed').onclick = () => loadSeed(true);
    $('#tableHint').textContent = '';
    return;
  }

  $('#tableCard').hidden = false;
  $('#listEmpty').hidden = true;
  $('#tableHint').textContent =
    rows.length === state.items.length ? `${rows.length}곳` : `${rows.length}곳 / 전체 ${state.items.length}곳`;

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="13" style="text-align:center;color:var(--text-dim);padding:36px 0">조건에 맞는 후보지가 없습니다</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((it) => {
    const st = STATUS_MAP[it.status];
    const sub = [it.address, it.channel].filter(Boolean).join(' · ');
    return `
      <tr data-id="${it.id}">
        <td>${kindTag(it.kind)}</td>
        <td class="cell-name">
          <div class="cand-name" data-act="detail">${esc(it.name)}
            <a class="map-link" href="${esc(mapUrl(it))}" target="_blank" rel="noopener" title="네이버 지도에서 보기" data-act="map"><i data-lucide="external-link"></i></a>
          </div>
          ${sub ? `<div class="cand-addr">${esc(sub)}</div>` : ''}
        </td>
        <td>${esc(it.region || '-')}</td>
        <td>${esc(it.owner || '-')}</td>
        <td>${esc(it.floor || '-')}</td>
        <td class="num">${num(it.area) ? num(it.area).toLocaleString() + '평' : '-'}</td>
        <td class="num">${money(it.deposit)}</td>
        <td class="num">${esc(rentLabel(it))}</td>
        <td class="num">${money(it.premium)}</td>
        <td class="num strong">${money(it.initial)}</td>
        <td><span class="tag ${st.cls}">${esc(st.label)}</span></td>
        <td>${esc(it.availableAt || '-')}</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn" data-act="edit" title="수정"><i data-lucide="pencil"></i></button>
            <button class="icon-btn del" data-act="delete" title="삭제"><i data-lucide="trash-2"></i></button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

function renderBoard() {
  const board = $('#board');
  board.innerHTML = STATUSES.map((s) => {
    const list = state.items.filter((i) => i.status === s.key);
    const cards = list.length
      ? list.map((it) => `
        <div class="board-card" draggable="true" data-id="${it.id}">
          <div class="board-card-name">${esc(it.name)}</div>
          <div class="board-card-addr">${esc([it.region, it.owner].filter(Boolean).join(' · ') || '-')}</div>
          <div class="board-card-foot">
            <span class="board-card-cost">${esc(rentLabel(it))}</span>
            ${it.kind ? kindTag(it.kind) : ''}
          </div>
        </div>`).join('')
      : '<div class="board-empty">비어 있음</div>';
    return `
      <div class="board-col" data-status="${s.key}">
        <div class="board-col-head">
          <span class="board-col-title"><span class="col-dot" style="background:${s.color}"></span>${esc(s.label)}</span>
          <span class="board-col-count">${list.length}</span>
        </div>
        ${cards}
      </div>`;
  }).join('');
}

function renderStats() {
  const items = state.items;
  // 기타(옛 드랍 포함)는 평균·합계에서 뺀다
  const alive = items.filter((i) => i.status !== 'etc');
  const areas = alive.filter((i) => num(i.area) > 0);
  const avgArea = areas.length ? Math.round(areas.reduce((s, i) => s + num(i.area), 0) / areas.length) : 0;
  const perP = alive.filter((i) => i.rentPerPyeong > 0);
  const avgPer = perP.length ? Math.round(perP.reduce((s, i) => s + i.rentPerPyeong, 0) / perP.length) : 0;
  const totalDeposit = alive.reduce((s, i) => s + num(i.deposit), 0);
  const totalRent = alive.reduce((s, i) => s + num(i.rent), 0);

  $('#statsKpiRow').innerHTML = [
    kpiCard({ accent: true, icon: 'landmark', label: '지역', value: uniq('region').length, unit: '개', sub: `드랍 제외 ${alive.length}곳` }),
    kpiCard({ icon: 'ruler', label: '평균 전용면적', value: avgArea, unit: '평', sub: avgPer ? `평당 임차료 ${moneyWon(avgPer)}` : '면적 미입력' }),
    kpiCard({ icon: 'piggy-bank', label: '보증금 합계', value: money(totalDeposit), unit: '', sub: '드랍 제외 · 고정 임차료 기준' }),
    kpiCard({ icon: 'wallet', label: '월 임차료 합계', value: money(totalRent), unit: '', sub: '수수료 방식 미포함' }),
  ].join('');

  const font = { family: "'Pretendard', sans-serif", size: 12 };
  Object.values(charts).forEach((c) => c && c.destroy());

  charts.status = new Chart($('#statusChart'), {
    type: 'doughnut',
    data: {
      labels: STATUSES.map((s) => s.label),
      datasets: [{ data: STATUSES.map((s) => items.filter((i) => i.status === s.key).length),
                   backgroundColor: STATUSES.map((s) => s.color), borderWidth: 0, hoverOffset: 6 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: { legend: { position: 'right', labels: { font, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle', padding: 14 } } },
    },
  });

  const counts = {};
  items.forEach((i) => { if (i.region) counts[i.region] = (counts[i.region] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  charts.region = new Chart($('#regionChart'), {
    type: 'bar',
    data: {
      labels: top.map((r) => r[0].replace('서울 ', '')),
      datasets: [{ label: '후보지', data: top.map((r) => r[1]), backgroundColor: '#4263eb', borderRadius: 6, maxBarThickness: 30 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font } },
        y: { beginAtZero: true, ticks: { precision: 0, font }, grid: { color: '#ececf1' }, border: { display: false } },
      },
    },
  });

  charts.scatter = new Chart($('#scatterChart'), {
    type: 'scatter',
    data: {
      datasets: STATUSES.filter((s) => items.some((i) => i.status === s.key && num(i.area) && num(i.rent))).map((s) => ({
        label: s.label,
        data: items.filter((i) => i.status === s.key && num(i.area) && num(i.rent))
                   .map((i) => ({ x: num(i.area), y: num(i.rent), name: i.name })),
        backgroundColor: s.color, pointRadius: 6, pointHoverRadius: 8,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font, boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 14 } },
        tooltip: { callbacks: { label: (c) => `${c.raw.name} · ${c.raw.x}평 · ${money(c.raw.y)}원` } },
      },
      scales: {
        x: { beginAtZero: true, title: { display: true, text: '전용면적 (평)', font }, ticks: { font }, grid: { color: '#ececf1' }, border: { display: false } },
        y: { beginAtZero: true, title: { display: true, text: '고정 임차료 (천원)', font },
             ticks: { font, callback: (v) => v.toLocaleString() }, grid: { color: '#ececf1' }, border: { display: false } },
      },
    },
  });
}

/* ===== 뷰 전환 ===== */
const VIEW_TITLE = { list: '후보지 목록', board: '진행 현황', stats: '분석' };
function setView(v) {
  state.view = v;
  $$('.nav-item[data-view]').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
  ['list', 'board', 'stats'].forEach((k) => { $(`#${k}View`).hidden = k !== v; });
  $('#pageTitle').textContent = VIEW_TITLE[v];
  if (v === 'stats') renderStats();
  icons();
}

/* ===== 입력 폼 ===== */
const FORM_FIELDS = ['name', 'kind', 'channel', 'owner', 'status', 'region', 'floor', 'address', 'naverUrl',
  'area', 'deposit', 'rent', 'feeRate', 'maintenance', 'premium', 'termsNote', 'pnl', 'availableAt', 'memo', 'contractNote'];
const NUM_FIELDS = ['area', 'deposit', 'rent', 'feeRate', 'maintenance', 'premium'];

function openForm(id) {
  const form = $('#candidateForm');
  const item = id ? state.items.find((i) => i.id === id) : null;
  state.editingId = item ? item.id : null;

  $('#formTitle').textContent = item ? '후보지 수정' : '후보지 추가';
  $('#deleteBtn').hidden = !item;

  const base = item || normalize({});
  form.reset();
  FORM_FIELDS.forEach((k) => {
    const v = base[k];
    form[k].value = NUM_FIELDS.includes(k) ? (num(v) || '') : (v || '');
  });

  syncMoneyHints();
  updateUrlHint();
  openModal('formModal');
  setTimeout(() => form.name.focus(), 50);
}

/* 천원으로 입력한 값을 바로 아래에 억·만원으로 환산해 보여준다 */
function syncMoneyHints() {
  $$('#candidateForm input[data-money]').forEach((input) => {
    const hint = input.parentElement.querySelector('.money-hint');
    if (!hint) return;
    const v = num(input.value);
    hint.textContent = v ? '= ' + moneyWon(v) : '';
    hint.classList.toggle('on', Boolean(v));
  });
}

function updateUrlHint() {
  const url = $('#f_naverUrl').value.trim();
  const hint = $('#urlHint');
  if (!url) {
    hint.textContent = '비워 두면 후보지명으로 네이버 지도를 검색합니다.';
    hint.style.color = '';
    return;
  }
  const pid = naverPlaceId(url);
  if (pid) {
    hint.textContent = `네이버 플레이스 ID ${pid} 인식됨`;
    hint.style.color = 'var(--positive)';
  } else {
    hint.textContent = '링크를 그대로 저장합니다.';
    hint.style.color = 'var(--text-dim)';
  }
}

function submitForm(e) {
  e.preventDefault();
  const form = e.target;
  const data = {};
  FORM_FIELDS.forEach((k) => {
    data[k] = NUM_FIELDS.includes(k) ? num(form[k].value) : form[k].value.trim();
  });
  if (!data.name) { toast('후보지명을 입력해 주세요'); return; }
  data.placeId = naverPlaceId(data.naverUrl);
  data.updatedAt = new Date().toISOString();

  if (state.editingId) {
    const idx = state.items.findIndex((i) => i.id === state.editingId);
    state.items[idx] = normalize(Object.assign({}, state.items[idx], data));
    toast('수정했습니다');
  } else {
    state.items.unshift(normalize(Object.assign({ createdAt: data.updatedAt }, data)));
    toast('후보지를 추가했습니다');
  }
  save();
  render();
  closeModal('formModal');
}

function removeItem(id) {
  const it = state.items.find((i) => i.id === id);
  if (!it) return;
  if (!confirm(`"${it.name}" 후보지를 삭제할까요?`)) return;
  state.items = state.items.filter((i) => i.id !== id);
  save();
  render();
  toast('삭제했습니다');
}

/* ===== 상세 ===== */
function openDetail(id) {
  const it = state.items.find((i) => i.id === id);
  if (!it) return;
  const st = STATUS_MAP[it.status];
  const cell = (k, v) => `<div class="detail-cell"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
  const memoBlock = (title, text) =>
    text ? `<div class="detail-memo"><div class="detail-memo-title">${esc(title)}</div>${esc(text)}</div>` : '';

  $('#detailBody').innerHTML = `
    <div class="detail-head">
      <h3 style="margin:0">${esc(it.name)}</h3>
      ${kindTag(it.kind)}
      <span class="tag ${st.cls}">${esc(st.label)}</span>
      <a class="btn ghost" style="margin-left:auto" href="${esc(mapUrl(it))}" target="_blank" rel="noopener">
        <i data-lucide="map"></i><span>지도</span>
      </a>
    </div>
    <p class="modal-sub" style="margin:-12px 0 20px">${esc([it.address, it.region, it.channel].filter(Boolean).join(' · ') || '위치 미입력')}</p>
    <div class="detail-grid">
      ${cell('담당자', esc(it.owner || '-'))}
      ${cell('층수', esc(it.floor || '-'))}
      ${cell('전용면적', num(it.area) ? num(it.area).toLocaleString() + '평' : '-')}
      ${cell('보증금', moneyWon(it.deposit))}
      ${cell('고정 임차료', num(it.rent) ? moneyWon(it.rent) : '-')}
      ${cell('수수료율', num(it.feeRate) ? num(it.feeRate) + '%' : '-')}
      ${cell('건물 관리비', moneyWon(it.maintenance))}
      ${cell('권리금', moneyWon(it.premium))}
      ${cell('초기투자', `<b>${moneyWon(it.initial)}</b>`)}
      ${cell('평당 임차료', it.rentPerPyeong ? moneyWon(Math.round(it.rentPerPyeong)) : '-')}
      ${cell('계약 가능시기', esc(it.availableAt || '-'))}
      ${cell('예상손익', esc(it.pnl || '-'))}
    </div>
    ${it.termsNote ? `<div class="detail-note"><i data-lucide="info"></i>조건 비고 — ${esc(it.termsNote)}</div>` : ''}
    ${memoBlock('기타', it.memo)}
    ${memoBlock('계약 완료', it.contractNote)}
    <div class="detail-foot-meta">등록 ${dateStr(it.createdAt)} · 최종 수정 ${dateStr(it.updatedAt)}</div>
    <div class="form-foot">
      <button class="btn danger" data-detail-del="${it.id}"><i data-lucide="trash-2"></i><span>삭제</span></button>
      <div class="form-foot-right">
        <button class="btn" data-detail-edit="${it.id}"><i data-lucide="pencil"></i><span>수정</span></button>
      </div>
    </div>`;
  openModal('detailModal');
  icons();
}

/* ===== 모달 ===== */
function openModal(id) { $(`#${id}`).hidden = false; document.body.style.overflow = 'hidden'; }
function closeModal(id) {
  $(`#${id}`).hidden = true;
  if ($$('.modal:not([hidden])').length === 0) document.body.style.overflow = '';
}

/* ===== 내보내기 · 가져오기 ===== */
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson() {
  download(`loungex-candidates-${todayISO()}.json`,
    JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), items: state.items }, null, 2));
  toast('JSON 파일을 내보냈습니다');
}

/* 시트와 같은 열 순서로 내보낸다 */
const CSV_COLS = [
  ['kind', '구분'], ['channel', '경로'], ['owner', '담당자'], ['name', '건물명'],
  ['locationOut', '위치'], ['statusLabel', '결과'], ['floor', '층수'], ['area', '전용 면적'],
  ['deposit', '보증금'], ['rent', '고정 임차료'], ['feeRate', '수수료율'],
  ['maintenance', '건물 관리비'], ['premium', '권리금'],
  ['pnl', '예상손익'], ['availableAt', '계약 가능시기'], ['memo', '기타'], ['contractNote', '계약 완료'],
  ['region', '지역'], ['termsNote', '조건 비고'],
];

function exportCsv() {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['"[단위 : 평 / 천 / %]"', CSV_COLS.map((c) => cell(c[1])).join(',')];
  state.items.forEach((it) => {
    const row = Object.assign({}, it, {
      statusLabel: (STATUS_MAP[it.status] || {}).label || it.status,
      locationOut: it.naverUrl || it.address,
      feeRate: num(it.feeRate) ? num(it.feeRate) + '%' : '',
    });
    NUM_FIELDS.filter((k) => k !== 'feeRate').forEach((k) => { if (!num(row[k])) row[k] = ''; });
    lines.push(CSV_COLS.map((c) => cell(row[c[0]])).join(','));
  });
  // 엑셀이 한글을 깨지 않게 BOM 을 붙인다
  download(`loungex-candidates-${todayISO()}.csv`, '﻿' + lines.join('\n'), 'text/csv;charset=utf-8');
  toast('CSV 파일을 내보냈습니다');
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const incoming = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(incoming)) throw new Error('items 배열이 없습니다');
      mergeItems(incoming);
      closeModal('dataModal');
    } catch (err) {
      console.error(err);
      toast('파일을 읽지 못했습니다 — 내보낸 JSON 인지 확인해 주세요');
    }
  };
  reader.readAsText(file);
}

function mergeItems(incoming) {
  const byId = new Map(state.items.map((i) => [i.id, i]));
  let added = 0, updated = 0;
  incoming.forEach((raw) => {
    const it = normalize(raw);
    if (byId.has(it.id)) { byId.set(it.id, Object.assign(byId.get(it.id), it)); updated++; }
    else { byId.set(it.id, it); added++; }
  });
  state.items = Array.from(byId.values());
  save();
  render();
  toast(`${added}곳 추가 · ${updated}곳 갱신`);
}

/* 구글 시트에서 뽑아 둔 원본 (data/candidates.json) */
async function loadSeed(silent) {
  try {
    const r = await fetch(SEED_URL + '?t=' + Date.now());
    if (!r.ok) throw new Error('status ' + r.status);
    const data = await r.json();
    mergeItems(data.items || []);
    closeModal('dataModal');
  } catch (e) {
    console.error(e);
    if (!silent) toast('시트 원본을 불러오지 못했습니다 (로컬 서버로 열어 주세요)');
  }
}

function clearAll() {
  if (!confirm('저장된 후보지를 모두 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return;
  state.items = [];
  save();
  render();
  closeModal('dataModal');
  toast('전체 삭제했습니다');
}

/* ===== 드래그 앤 드롭 ===== */
let draggingId = null;
function bindBoardDnd() {
  const board = $('#board');
  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.board-card');
    if (!card) return;
    draggingId = card.dataset.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox 는 데이터가 없으면 드래그를 시작하지 않는다
    e.dataTransfer.setData('text/plain', draggingId);
  });
  board.addEventListener('dragend', (e) => {
    const card = e.target.closest('.board-card');
    if (card) card.classList.remove('dragging');
    $$('.board-col').forEach((c) => c.classList.remove('drag-over'));
    draggingId = null;
  });
  board.addEventListener('dragover', (e) => {
    const col = e.target.closest('.board-col');
    if (!col || !draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.board-col').forEach((c) => c.classList.toggle('drag-over', c === col));
  });
  board.addEventListener('drop', (e) => {
    const col = e.target.closest('.board-col');
    if (!col || !draggingId) return;
    e.preventDefault();
    const it = state.items.find((i) => i.id === draggingId);
    const next = col.dataset.status;
    if (it && it.status !== next) {
      it.status = next;
      it.updatedAt = new Date().toISOString();
      save();
      render();
      toast(`${it.name} → ${STATUS_MAP[next].label}`);
    } else {
      $$('.board-col').forEach((c) => c.classList.remove('drag-over'));
    }
    draggingId = null;
  });
  board.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.board-card');
    if (card) openDetail(card.dataset.id);
  });
}

/* ===== 초기화 ===== */
async function init() {
  const stored = load();
  state.items = stored.items.map(normalize);
  state.savedAt = stored.savedAt;
  loadTeamConfig();
  renderSyncBadge();

  $('#f_status').innerHTML = STATUSES.map((s) => `<option value="${s.key}">${s.label}</option>`).join('');

  $$('.nav-item[data-view]').forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); setView(el.dataset.view); });
  });
  $('#dataBtn').addEventListener('click', () => openModal('dataModal'));
  $('#addBtn').addEventListener('click', () => openForm());

  // 필터
  $('#searchInput').addEventListener('input', (e) => { state.search = e.target.value; renderTable(); icons(); });
  $('#statusChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.statusFilter = chip.dataset.status;
    renderChips(); renderTable(); icons();
  });
  [['#regionFilter', 'regionFilter'], ['#ownerFilter', 'ownerFilter'], ['#kindFilter', 'kindFilter']]
    .forEach(([sel, key]) => {
      $(sel).addEventListener('change', (e) => { state[key] = e.target.value; renderTable(); icons(); });
    });

  // 정렬
  $$('#tableCard thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      const numeric = ['area', 'deposit', 'rent', 'premium', 'initial'].includes(k);
      if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortKey = k; state.sortDir = numeric ? 'desc' : 'asc'; }
      renderTable(); icons();
    });
  });

  // 행 액션
  $('#tableBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const act = e.target.closest('[data-act]');
    const kind = act ? act.dataset.act : '';
    if (kind === 'map') return;            // 링크는 기본 동작
    if (kind === 'edit') openForm(tr.dataset.id);
    else if (kind === 'delete') removeItem(tr.dataset.id);
    else openDetail(tr.dataset.id);
  });

  // 폼
  $('#candidateForm').addEventListener('submit', submitForm);
  $$('#candidateForm input[data-money]').forEach((i) => i.addEventListener('input', syncMoneyHints));
  $('#f_naverUrl').addEventListener('input', updateUrlHint);
  $('#deleteBtn').addEventListener('click', () => {
    const id = state.editingId;
    closeModal('formModal');
    if (id) removeItem(id);
  });

  $('#detailBody').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-detail-edit]');
    const del = e.target.closest('[data-detail-del]');
    if (edit) { closeModal('detailModal'); openForm(edit.dataset.detailEdit); }
    if (del) { closeModal('detailModal'); removeItem(del.dataset.detailDel); }
  });

  $$('[data-close]').forEach((el) => el.addEventListener('click', () => closeModal(el.dataset.close)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal:not([hidden])').forEach((m) => closeModal(m.id));
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); setView('list'); $('#searchInput').focus();
    }
  });

  // 데이터
  $('#exportJson').addEventListener('click', exportJson);
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#importJson').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = '';
  });
  $('#reloadSeed').addEventListener('click', () => loadSeed(false));
  $('#clearAll').addEventListener('click', clearAll);

  bindBoardDnd();
  bindSheetUi();
  updateTeamSetupDesc();
  render();
  setView('list');

  // 첫 실행이면 시트 원본을 자동으로 넣는다
  if (!state.items.length && !teamMode()) await loadSeed(true);
  if (teamMode()) { doSync(); startPolling(); }
}

document.addEventListener('DOMContentLoaded', init);

/* =========================================================
   팀 공유 동기화 (Cloudflare Worker + KV)

   서버에 무엇을 보낼지는 "마지막으로 서버와 맞춘 시점의 스냅샷"과 현재 목록을
   비교해서 정한다. 그래서 각 수정 지점마다 따로 표시할 필요가 없다.
     - 스냅샷에 없거나 updatedAt 이 달라진 항목 → 보낼 항목
     - 스냅샷에는 있는데 지금 목록에 없는 id → 삭제
   ========================================================= */

const TEAM_STORE = 'loungex.candidates.team.v1';
const SNAPSHOT_STORE = 'loungex.candidates.snapshot.v2';
const POLL_MS = 20000;

const sync = {
  api: '', key: '',
  status: 'local',   // local | syncing | ok | error | auth | offline
  message: '', lastSync: null,
  debounce: null, poller: null, inFlight: false, again: false,
};

function loadTeamConfig() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(TEAM_STORE) || '{}'); } catch (_) { stored = {}; }
  sync.api = (stored.api || window.LOUNGEX_CANDIDATES_API || '').replace(/\/+$/, '');
  sync.key = stored.key || '';
  sync.status = sync.api && sync.key ? 'ok' : 'local';
}
function saveTeamConfig(api, key) {
  sync.api = (api || '').replace(/\/+$/, '');
  sync.key = key || '';
  localStorage.setItem(TEAM_STORE, JSON.stringify({ api: sync.api, key: sync.key }));
}
function clearTeamConfig() {
  sync.api = ''; sync.key = ''; sync.status = 'local';
  localStorage.removeItem(TEAM_STORE);
  localStorage.removeItem(SNAPSHOT_STORE);
  stopPolling();
}
function teamMode() { return Boolean(sync.api && sync.key); }

function snapshotLoad() {
  try { return JSON.parse(localStorage.getItem(SNAPSHOT_STORE) || '{}'); } catch (_) { return {}; }
}
function snapshotSave(items) {
  const snap = {};
  items.forEach((i) => { snap[i.id] = i.updatedAt; });
  localStorage.setItem(SNAPSHOT_STORE, JSON.stringify(snap));
}

/* localStorage 에만 쓴다. save() 와 달리 서버 동기화를 부르지 않는다. */
function persistLocal() {
  const savedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, savedAt, items: state.items }));
    state.savedAt = savedAt;
  } catch (e) {
    console.error(e);
    toast('저장에 실패했습니다 (저장 공간 부족)');
  }
}

/* 로컬에 쓰고, 팀 공유가 켜져 있으면 서버로도 보낸다 */
function save() {
  persistLocal();
  renderSyncBadge();
  queueSync();
}

function apiFetch(path, init) {
  return fetch(sync.api + path, Object.assign({}, init, {
    headers: Object.assign({ 'X-Team-Key': sync.key }, (init && init.headers) || {}),
  }));
}

function queueSync() {
  if (!teamMode()) { renderSyncBadge(); return; }
  clearTimeout(sync.debounce);
  sync.debounce = setTimeout(doSync, 700);
  sync.status = 'syncing';
  renderSyncBadge();
}

async function doSync() {
  if (!teamMode()) return;
  if (sync.inFlight) { sync.again = true; return; }
  sync.inFlight = true;
  sync.status = 'syncing';
  renderSyncBadge();

  const snap = snapshotLoad();
  const changed = state.items.filter((i) => snap[i.id] !== i.updatedAt);
  const now = new Date().toISOString();
  const alive = new Set(state.items.map((i) => i.id));
  const deletes = {};
  Object.keys(snap).forEach((id) => { if (!alive.has(id)) deletes[id] = now; });

  try {
    const r = await apiFetch('/candidates/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: changed, deletes }),
    });
    if (r.status === 401) {
      sync.status = 'auth';
      sync.message = '팀 키가 맞지 않습니다';
      renderSyncBadge();
      return;
    }
    if (!r.ok) throw new Error('status ' + r.status);
    const data = await r.json();
    const incoming = (data.items || []).map(normalize);
    state.items = incoming;          // 서버가 병합한 결과를 그대로 받는다
    snapshotSave(incoming);
    persistLocal();
    sync.status = 'ok';
    sync.message = '';
    sync.lastSync = data.savedAt || new Date().toISOString();
    render();
  } catch (e) {
    console.error('동기화 실패', e);
    sync.status = navigator.onLine ? 'error' : 'offline';
    sync.message = navigator.onLine ? '서버에 연결하지 못했습니다' : '오프라인 — 연결되면 다시 보냅니다';
  } finally {
    sync.inFlight = false;
    renderSyncBadge();
    if (sync.again) { sync.again = false; queueSync(); }
  }
}

function startPolling() {
  stopPolling();
  if (!teamMode()) return;
  sync.poller = setInterval(() => {
    if (document.visibilityState === 'visible' && !sync.inFlight) doSync();
  }, POLL_MS);
}
function stopPolling() {
  if (sync.poller) clearInterval(sync.poller);
  sync.poller = null;
}

function renderSyncBadge() {
  const el = $('#lastSaved');
  const label = $('#syncLabel');
  if (!teamMode()) {
    label.textContent = '마지막 저장';
    el.className = 'meta-value clickable';
    el.title = '이 브라우저에만 저장됩니다. 눌러서 팀 공유를 설정하세요';
    el.innerHTML = `<span class="sync-dot"></span>${state.savedAt ? timeStr(state.savedAt) : '저장 내역 없음'}`;
    return;
  }
  const map = {
    syncing: ['syncing', '동기화 중…'],
    ok: ['ok', sync.lastSync ? timeStr(sync.lastSync) : '동기화됨'],
    auth: ['auth', '팀 키 확인 필요'],
    error: ['error', '연결 실패'],
    offline: ['error', '오프라인'],
  };
  const [cls, text] = map[sync.status] || ['', '-'];
  label.textContent = '팀 공유';
  el.className = 'meta-value clickable';
  el.title = sync.message || '팀 공유 설정 열기';
  el.innerHTML = `<span class="sync-dot ${cls}"></span>${esc(text)}`;
}

/* ===== 팀 설정 모달 ===== */
function openTeamModal() {
  $('#teamApi').value = sync.api || window.LOUNGEX_CANDIDATES_API || '';
  $('#teamKey').value = sync.key || '';
  $('#teamDisconnect').hidden = !teamMode();
  const st = $('#teamStatus');
  if (teamMode()) {
    st.hidden = false;
    st.className = 'team-status info';
    st.textContent = `연결됨 · 후보지 ${state.items.length}곳을 팀과 공유 중입니다.`;
  } else {
    st.hidden = true;
  }
  openModal('teamModal');
}

async function connectTeam() {
  const api = $('#teamApi').value.trim().replace(/\/+$/, '');
  const key = $('#teamKey').value.trim();
  const st = $('#teamStatus');
  st.hidden = false;
  st.className = 'team-status info';
  st.textContent = '연결 확인 중…';
  if (!api || !key) {
    st.className = 'team-status error';
    st.textContent = '워커 주소와 팀 키를 모두 입력해 주세요.';
    return;
  }
  try {
    const r = await fetch(api + '/ping', { headers: { 'X-Team-Key': key } });
    if (r.status === 401) {
      st.className = 'team-status error';
      st.textContent = '팀 키가 맞지 않습니다.';
      return;
    }
    if (!r.ok) throw new Error('status ' + r.status);
    saveTeamConfig(api, key);
    st.className = 'team-status ok';
    st.textContent = '연결됐습니다. 지금 목록을 서버와 맞춥니다…';
    $('#teamDisconnect').hidden = false;
    await doSync();
    startPolling();
    updateTeamSetupDesc();
    closeModal('teamModal');
    closeModal('dataModal');
    toast('팀 공유가 켜졌습니다');
  } catch (e) {
    console.error(e);
    st.className = 'team-status error';
    st.textContent = '연결하지 못했습니다. 주소가 맞는지, 워커가 배포됐는지 확인해 주세요.';
  }
}

function disconnectTeam() {
  if (!confirm('팀 공유를 끕니다. 지금 목록은 이 브라우저에 그대로 남습니다. 계속할까요?')) return;
  clearTeamConfig();
  updateTeamSetupDesc();
  renderSyncBadge();
  closeModal('teamModal');
  toast('팀 공유를 껐습니다');
}

function updateTeamSetupDesc() {
  const el = $('#teamSetupDesc');
  if (!el) return;
  el.textContent = teamMode()
    ? `연결됨 · ${sync.api.replace(/^https?:\/\//, '')}`
    : '워커 주소와 팀 키를 입력하면 팀원과 같은 데이터를 봅니다';
}

/* =========================================================
   구글 시트 · 엑셀 가져오기
   ========================================================= */

/* kw: 머리글에 이 말이 들어 있으면 자동으로 연결한다 (앞에 있을수록 우선) */
const SHEET_FIELDS = [
  { key: 'name',         label: '건물명',      req: true, type: 'text',   kw: ['건물명', '후보지명', '후보지', '물건명', '이름', 'name'] },
  { key: 'kind',         label: '구분',        type: 'kind',     kw: ['구분', 'kind'] },
  { key: 'channel',      label: '경로',        type: 'text',     kw: ['경로', 'channel'] },
  { key: 'owner',        label: '담당자',      type: 'text',     kw: ['담당자', '담당', 'owner'] },
  { key: 'location',     label: '위치',        type: 'location', kw: ['위치', '주소', '소재지', 'location', 'address'] },
  { key: 'status',       label: '결과',        type: 'status',   kw: ['결과', '진행상태', '상태', '단계', 'status'] },
  { key: 'floor',        label: '층수',        type: 'text',     kw: ['층수', '층', 'floor'] },
  { key: 'area',         label: '전용 면적',   type: 'number',   kw: ['전용면적', '전용', '면적', '평수', 'area'] },
  { key: 'deposit',      label: '보증금',      type: 'money',    kw: ['보증금', '보증', 'deposit'] },
  { key: 'rent',         label: '고정 임차료', type: 'money',    kw: ['고정임차료', '임차료', '월세', '임대료', 'rent'] },
  { key: 'feeRate',      label: '수수료율',    type: 'percent',  kw: ['수수료율', '수수료', 'fee'] },
  { key: 'maintenance',  label: '건물 관리비', type: 'money',    kw: ['건물관리비', '관리비', 'maintenance'] },
  { key: 'premium',      label: '권리금',      type: 'money',    kw: ['권리금', '권리', 'premium'] },
  { key: 'pnl',          label: '예상손익',    type: 'text',     kw: ['예상손익', '손익', 'pnl'] },
  { key: 'availableAt',  label: '계약 가능시기', type: 'text',   kw: ['계약가능시기', '가능시기', '입점시기', '시기'] },
  { key: 'memo',         label: '기타',        type: 'text',     kw: ['기타', '메모', '비고', '특이사항', 'memo', 'note'] },
  { key: 'contractNote', label: '계약 완료',   type: 'text',     kw: ['계약완료', '계약', 'contract'] },
  { key: 'region',       label: '지역',        type: 'text',     kw: ['지역', '상권', '권역', 'region'] },
  { key: 'termsNote',    label: '조건 비고',   type: 'text',     kw: ['조건비고', '조건'] },
];

const sheetState = { headers: [], rows: [], mapping: {} };

/* 지역 열이 없는 시트가 많아서, 건물명·위치에서 구/시를 뽑아 채워 준다 */
const REGION_KW = [
  ['여의도', '서울 영등포구'], ['문래', '서울 영등포구'], ['강남', '서울 강남구'], ['선릉', '서울 강남구'],
  ['한티역', '서울 강남구'], ['압구정', '서울 강남구'], ['삼성역', '서울 강남구'], ['삼성동', '서울 강남구'],
  ['테헤란', '서울 강남구'], ['역삼', '서울 강남구'], ['대치', '서울 강남구'], ['교대역', '서울 서초구'],
  ['서초', '서울 서초구'], ['서래마을', '서울 서초구'], ['염곡', '서울 서초구'], ['종각', '서울 종로구'],
  ['종로', '서울 종로구'], ['안국', '서울 종로구'], ['광화문', '서울 종로구'], ['공평', '서울 종로구'],
  ['인사동', '서울 종로구'], ['와룡동', '서울 종로구'], ['을지', '서울 중구'], ['시청역', '서울 중구'],
  ['충무로', '서울 중구'], ['서울역', '서울 중구'], ['서울스퀘어', '서울 중구'], ['두타', '서울 중구'],
  ['신당', '서울 중구'], ['마포', '서울 마포구'], ['합정', '서울 마포구'], ['상암', '서울 마포구'],
  ['홍대', '서울 마포구'], ['용산', '서울 용산구'], ['남영', '서울 용산구'], ['원효로', '서울 용산구'],
  ['잠실', '서울 송파구'], ['가락', '서울 송파구'], ['천호', '서울 강동구'], ['건대', '서울 광진구'],
  ['뚝섬', '서울 성동구'], ['성수', '서울 성동구'], ['서울숲', '서울 성동구'], ['사근동', '서울 성동구'],
  ['답십리', '서울 동대문구'], ['청량리', '서울 동대문구'], ['노량진', '서울 동작구'], ['구로', '서울 구로구'],
  ['충정로', '서울 서대문구'], ['마곡', '서울 강서구'], ['광운대', '서울 노원구'], ['신림', '서울 관악구'],
  ['양평', '경기 양평군'], ['일산', '경기 고양시'], ['구리', '경기 구리시'], ['광명', '경기 광명시'],
  ['백운호수', '경기 의왕시'], ['마시안', '인천 중구'], ['해운대', '부산 해운대구'],
];
function regionOf(text) {
  const t = String(text || '');
  const pats = [
    [/서울(?:특별시|시)?\s*([가-힣]{1,4}구)/, '서울 '],
    [/경기(?:도)?\s*([가-힣]{1,5}시)/, '경기 '],
    [/부산(?:광역시)?\s*([가-힣]{1,4}구)/, '부산 '],
    [/인천(?:광역시)?\s*([가-힣]{1,4}구)/, '인천 '],
  ];
  for (const [re, prefix] of pats) {
    const m = t.match(re);
    if (m) return prefix + m[1];
  }
  for (const [kw, reg] of REGION_KW) if (t.includes(kw)) return reg;
  return '';
}

/* 따옴표 안의 구분자·줄바꿈까지 처리하는 CSV/TSV 파서 */
function parseDelimited(text) {
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const head = clean.split('\n')[0] || '';
  const delim = (head.match(/\t/g) || []).length > (head.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some((v) => v !== ''));
}

let xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxLoading) return xlsxLoading;
  xlsxLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('XLSX 로더를 불러오지 못했습니다'));
    document.head.appendChild(s);
  });
  return xlsxLoading;
}

async function readSheetFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'xlsx' || ext === 'xls') {
    const XLSX = await loadXlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
    return aoa.map((r) => r.map((v) => String(v ?? '').trim())).filter((r) => r.some((v) => v !== ''));
  }
  return parseDelimited(await file.text());
}

/* 시트 위쪽에 제목·단위 표기 줄이 있는 경우가 많다. 머리글다운 줄을 찾아 거기서부터 읽는다. */
function findHeaderRow(rows) {
  const hint = /건물명|후보지|담당자|보증금|결과|위치/;
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const filled = rows[i].filter((c) => c !== '').length;
    if (filled >= 4 && rows[i].some((c) => hint.test(c))) return i;
  }
  return 0;
}

function startMapping(rows) {
  if (!rows || rows.length < 2) {
    toast('머리글 한 줄과 데이터가 최소 한 줄은 있어야 합니다');
    return;
  }
  const h = findHeaderRow(rows);
  sheetState.headers = rows[h];
  sheetState.rows = rows.slice(h + 1);
  sheetState.mapping = guessMapping(sheetState.headers);
  renderMapping();
  $('#sheetStep1').hidden = true;
  $('#sheetStep2').hidden = false;
  openModal('sheetModal');
  icons();
}

function guessMapping(headers) {
  const norm = headers.map((h) => String(h).toLowerCase().replace(/[\s()（）·.,_/-]/g, ''));
  const used = new Set();
  const map = {};
  SHEET_FIELDS.forEach((f) => {
    for (const kw of f.kw) {
      const k = kw.toLowerCase();
      const idx = norm.findIndex((h, i) => !used.has(i) && h.includes(k));
      if (idx >= 0) { map[f.key] = idx; used.add(idx); return; }
    }
  });
  return map;
}

function renderMapping() {
  const matched = Object.keys(sheetState.mapping).length;
  $('#mapSummary').innerHTML =
    `<b>${sheetState.rows.length}행</b> · 열 ${sheetState.headers.length}개를 읽었습니다. ` +
    `그중 <b>${matched}개</b>를 자동으로 연결했습니다. 틀린 곳만 바꾸고 가져오세요.`;

  const opts = (sel) =>
    '<option value="">— 없음 —</option>' +
    sheetState.headers.map((h, i) =>
      `<option value="${i}"${sel === i ? ' selected' : ''}>${esc(h || '(빈 머리글 ' + (i + 1) + ')')}</option>`
    ).join('');

  $('#mapGrid').innerHTML = SHEET_FIELDS.map((f) => {
    const sel = sheetState.mapping[f.key];
    const has = sel !== undefined && sel !== null;
    return `
      <div class="map-row">
        <label for="map_${f.key}">${esc(f.label)}${f.req ? ' <span class="req">*</span>' : ''}</label>
        <select id="map_${f.key}" data-field="${f.key}" class="${has ? 'mapped' : ''}">${opts(has ? Number(sel) : '')}</select>
      </div>`;
  }).join('');

  $('#mapGrid').querySelectorAll('select').forEach((s) => {
    s.addEventListener('change', () => {
      const v = s.value;
      if (v === '') delete sheetState.mapping[s.dataset.field];
      else sheetState.mapping[s.dataset.field] = Number(v);
      s.classList.toggle('mapped', v !== '');
    });
  });
}

/* 시트 금액은 천원 단위. "1억5000만" 처럼 적혀 있어도 천원으로 환산한다. */
function parseMoney(v) {
  const s = String(v ?? '').replace(/\s/g, '');
  if (!s) return 0;
  const eok = s.match(/([\d.]+)억/);
  const man = s.match(/([\d,.]+)만/);
  if (eok || man) {
    const a = eok ? parseFloat(eok[1]) * 100000 : 0;
    const b = man ? parseFloat(man[1].replace(/,/g, '')) * 10 : 0;
    return Math.round(a + b);
  }
  const n = parseFloat(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function parseStatus(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'review';
  const flat = s.replace(/\s/g, '');
  const hit = STATUSES.find((x) => x.label === flat || x.key === s.toLowerCase());
  if (hit) return hit.key;
  if (/드랍|드롭|종결|불가/.test(flat)) return 'etc';
  if (/제안|의향|진행|협의|소개/.test(flat)) return 'progress';
  if (/완료|계약/.test(flat)) return 'signed';
  if (/검토|후보/.test(flat)) return 'review';
  return 'etc';
}
function parseKind(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.startsWith('직')) return '직영';
  if (s.startsWith('가')) return '가맹';
  if (s.startsWith('베')) return '베이커리';
  return '';
}

function applyImport() {
  const map = sheetState.mapping;
  if (map.name === undefined) { toast('건물명 열은 반드시 연결해야 합니다'); return; }

  const upsert = $('#mapUpsert').checked;
  const byName = new Map(state.items.map((i) => [i.name.trim(), i]));
  const now = new Date().toISOString();
  let added = 0, updated = 0, skipped = 0;

  sheetState.rows.forEach((row) => {
    const name = String(row[map.name] ?? '').trim().replace(/\s{2,}/g, ' ');
    if (!name) { skipped++; return; }

    const data = { name };
    SHEET_FIELDS.forEach((f) => {
      if (f.key === 'name' || map[f.key] === undefined) return;
      const raw = row[map[f.key]];
      if (raw === undefined || String(raw).trim() === '') return;
      const s = String(raw).trim();
      if (f.type === 'money') data[f.key] = parseMoney(s);
      else if (f.type === 'number') { const n = parseFloat(s.replace(/[^\d.]/g, '')); data[f.key] = Number.isFinite(n) ? n : 0; }
      else if (f.type === 'percent') { const n = parseFloat(s.replace(/[^\d.]/g, '')); data[f.key] = Number.isFinite(n) ? n : 0; }
      else if (f.type === 'status') data[f.key] = parseStatus(s);
      else if (f.type === 'kind') data[f.key] = parseKind(s);
      else if (f.type === 'location') {
        // 위치 칸에는 링크가 들어 있기도 하고 주소가 적혀 있기도 하다
        if (/^https?:\/\//.test(s)) data.naverUrl = s;
        else data.address = s.replace(/\s*[-–]\s*네이버\s*지도\s*$/, '').replace(/\s*검색\s*$/, '').trim();
      }
      else data[f.key] = s.replace(/\s{2,}/g, ' ');
    });
    if (data.naverUrl) data.placeId = naverPlaceId(data.naverUrl);
    if (!data.region) data.region = regionOf(name + ' ' + (data.address || ''));
    data.updatedAt = now;

    const existing = upsert ? byName.get(name) : null;
    if (existing) {
      Object.assign(existing, normalize(Object.assign({}, existing, data)));
      updated++;
    } else {
      const item = normalize(Object.assign({ createdAt: now }, data));
      state.items.unshift(item);
      byName.set(name, item);
      added++;
    }
  });

  save();
  render();
  closeModal('sheetModal');
  closeModal('dataModal');
  toast(`${added}곳 추가 · ${updated}곳 갱신${skipped ? ` · ${skipped}행 건너뜀` : ''}`);
}

function openSheetModal() {
  $('#sheetStep1').hidden = false;
  $('#sheetStep2').hidden = true;
  $('#sheetPaste').value = '';
  $('#sheetUrl').value = '';
  openModal('sheetModal');
  icons();
}

async function loadSheetUrl() {
  const url = $('#sheetUrl').value.trim();
  if (!url) { toast('시트 주소를 입력해 주세요'); return; }
  toast('시트를 불러오는 중…');
  try {
    // 게시된 CSV 는 대개 브라우저에서 바로 받아진다. 막히면 워커로 우회한다.
    let text;
    try {
      const direct = await fetch(url);
      if (!direct.ok) throw new Error('status ' + direct.status);
      text = await direct.text();
    } catch (_) {
      if (!teamMode()) throw new Error('브라우저에서 직접 받을 수 없습니다. 팀 공유 설정을 먼저 하거나 파일로 올려 주세요.');
      const r = await apiFetch('/sheet?url=' + encodeURIComponent(url));
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.hint || err.error || '워커가 시트를 받지 못했습니다');
      }
      text = await r.text();
    }
    if (text.trim().startsWith('<')) throw new Error('CSV 가 아니라 HTML 이 왔습니다. "웹에 게시"한 CSV 주소인지 확인해 주세요.');
    startMapping(parseDelimited(text));
  } catch (e) {
    console.error(e);
    toast(e.message || '시트를 불러오지 못했습니다');
  }
}

function bindSheetUi() {
  $('#importSheet').addEventListener('click', openSheetModal);
  $('#sheetPickFile').addEventListener('click', () => $('#sheetFile').click());
  $('#sheetFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      startMapping(await readSheetFile(file));
    } catch (err) {
      console.error(err);
      toast('파일을 읽지 못했습니다');
    }
  });
  $('#sheetUrlLoad').addEventListener('click', loadSheetUrl);
  $('#sheetPasteLoad').addEventListener('click', () => {
    const text = $('#sheetPaste').value;
    if (!text.trim()) { toast('붙여넣은 내용이 없습니다'); return; }
    startMapping(parseDelimited(text));
  });
  $('#mapBack').addEventListener('click', () => { $('#sheetStep2').hidden = true; $('#sheetStep1').hidden = false; });
  $('#mapConfirm').addEventListener('click', applyImport);

  $('#teamSetup').addEventListener('click', openTeamModal);
  $('#teamConnect').addEventListener('click', connectTeam);
  $('#teamDisconnect').addEventListener('click', disconnectTeam);
  $('#lastSaved').addEventListener('click', openTeamModal);

  window.addEventListener('online', () => { if (teamMode()) doSync(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && teamMode()) doSync();
  });
}
