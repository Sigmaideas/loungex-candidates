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
  dirty: false,   // 저장 안 한 변경이 있는지
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
  // 제안완료·드랍·기타 폐지. 이미 저장된 값은 옮겨 받는다
  if (item.status === 'proposed') item.status = 'progress';
  if (!STATUS_MAP[item.status]) item.status = 'review';   // drop · etc · 미상 → 후보지
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
  const pct = (n) => (items.length ? Math.round((n / items.length) * 100) : 0);
  const kinds = KINDS.map((k) => `${k} ${items.filter((i) => i.kind === k).length}`).join(' · ');

  $('#kpiRow').innerHTML = [
    kpiCard({ accent: true, icon: 'map-pin', label: '전체 후보지', value: items.length, unit: '곳', sub: kinds }),
    kpiCard({ icon: 'search-check', label: '후보지', value: by('review'), unit: '곳', sub: `전체의 ${pct(by('review'))}%` }),
    kpiCard({ icon: 'activity', label: '진행중', value: by('progress'), unit: '곳', sub: `전체의 ${pct(by('progress'))}%` }),
    kpiCard({ icon: 'circle-check', label: '계약완료', value: by('signed'), unit: '곳', sub: `파이프라인 ${by('progress') + by('signed')}곳` }),
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
        <p>우측 위 <b>후보지 추가</b> 로 첫 후보지를 등록하세요.</p>
        <div class="empty-actions">
          <button class="btn" id="emptyAdd"><i data-lucide="plus"></i><span>후보지 추가</span></button>
        </div>
      </div>`;
    $('#emptyAdd').onclick = () => openForm();
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
  const alive = items;
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

/* 서버에 아무것도 없을 때만 쓰는 초기 데이터 (data/candidates.json) */
async function loadSeed(silent) {
  try {
    const r = await fetch(SEED_URL + '?t=' + Date.now());
    if (!r.ok) throw new Error('status ' + r.status);
    const data = await r.json();
    state.items = (data.items || []).map(normalize);
    persistLocal();
    render();
  } catch (e) {
    console.error(e);
    if (!silent) toast('초기 데이터를 불러오지 못했습니다');
  }
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
  sync.api = (window.LOUNGEX_CANDIDATES_API || '').replace(/\/+$/, '');
  renderSyncBadge();

  $('#f_status').innerHTML = STATUSES.map((s) => `<option value="${s.key}">${s.label}</option>`).join('');

  $$('.nav-item[data-view]').forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); setView(el.dataset.view); });
  });
  $('#addBtn').addEventListener('click', () => openForm());
  $('#saveBtn').addEventListener('click', () => saveToServer(true));

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

  // 저장 안 한 변경이 있는 채로 탭을 닫으려 하면 잡는다
  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  bindBoardDnd();
  render();
  setView('list');

  if (shared()) {
    await pull(true);
    startPolling();
  } else if (!state.items.length) {
    await loadSeed(true);   // 공유 서버가 설정 안 된 로컬 모드
  }
  renderSyncBadge();
}

document.addEventListener('DOMContentLoaded', init);

/* =========================================================
   팀 공유 저장 (Cloudflare Worker + KV)

   읽기는 자동, 쓰기는 수동이다. 열면 서버 목록을 받아오고 20초마다 다시 받는다.
   편집은 이 브라우저에만 쌓이고(state.dirty), [저장하기] 를 눌러야 팀에 반영된다.

   무엇을 보낼지는 "마지막으로 서버와 맞춘 시점의 스냅샷"과 현재 목록을 비교해 정한다.
     - 스냅샷에 없거나 updatedAt 이 달라진 항목 → 보낼 항목
     - 스냅샷에는 있는데 지금 목록에 없는 id → 삭제
   ========================================================= */

const SNAPSHOT_STORE = 'loungex.candidates.snapshot.v2';
const POLL_MS = 20000;

const sync = {
  api: '',
  status: 'idle',    // idle | loading | saving | ok | error | offline | local
  message: '', lastSync: null,
  poller: null, inFlight: false,
};

function shared() { return Boolean(sync.api); }

function snapshotLoad() {
  try { return JSON.parse(localStorage.getItem(SNAPSHOT_STORE) || '{}'); } catch (_) { return {}; }
}
function snapshotSave(items) {
  const snap = {};
  items.forEach((i) => { snap[i.id] = i.updatedAt; });
  localStorage.setItem(SNAPSHOT_STORE, JSON.stringify(snap));
}

/* localStorage 에만 쓴다. 서버로는 보내지 않는다. */
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

/* 편집 지점에서 부르는 저장. 서버 반영은 [저장하기] 가 할 일이라 여기선 표시만 남긴다. */
function save() {
  persistLocal();
  state.dirty = true;
  renderSyncBadge();
}

function apiFetch(path, init) {
  return fetch(sync.api + path, init);
}

/* 서버 목록 받아오기. 저장 안 한 편집이 있으면 덮어쓰지 않는다. */
async function pull(initial) {
  if (!shared() || sync.inFlight) return;
  if (state.dirty && !initial) return;
  sync.inFlight = true;
  if (initial) { sync.status = 'loading'; renderSyncBadge(); }
  try {
    const r = await apiFetch('/candidates');
    if (!r.ok) throw new Error('status ' + r.status);
    const data = await r.json();
    const incoming = (data.items || []).map(normalize);
    // 첫 로드인데 서버가 비어 있으면 초기 데이터를 넣을 수 있게 둔다
    if (initial && !incoming.length) {
      sync.status = 'ok';
      sync.lastSync = null;
      if (!state.items.length) await loadSeed(true);
      state.dirty = Boolean(state.items.length);
      renderSyncBadge();
      return;
    }
    if (state.dirty) return;   // 받아오는 사이에 편집이 생겼다
    state.items = incoming;
    snapshotSave(incoming);
    persistLocal();
    state.dirty = false;
    sync.status = 'ok';
    sync.message = '';
    sync.lastSync = data.savedAt || null;
    render();
  } catch (e) {
    console.error('불러오기 실패', e);
    sync.status = navigator.onLine ? 'error' : 'offline';
    sync.message = navigator.onLine ? '서버에 연결하지 못했습니다' : '오프라인';
  } finally {
    sync.inFlight = false;
    renderSyncBadge();
  }
}

/* [저장하기] — 바뀐 항목만 올리고, 서버가 병합한 결과를 그대로 받는다 */
async function saveToServer(manual) {
  if (!shared()) {
    persistLocal();
    state.dirty = false;
    renderSyncBadge();
    if (manual) toast('이 브라우저에 저장했습니다 (팀 공유 미설정)');
    return;
  }
  if (sync.inFlight) return;
  sync.inFlight = true;
  sync.status = 'saving';
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
    if (!r.ok) throw new Error('status ' + r.status);
    const data = await r.json();
    const incoming = (data.items || []).map(normalize);
    state.items = incoming;
    snapshotSave(incoming);
    persistLocal();
    state.dirty = false;
    sync.status = 'ok';
    sync.message = '';
    sync.lastSync = data.savedAt || new Date().toISOString();
    render();
    if (manual) toast(`팀 전체에 저장했습니다 · 후보지 ${incoming.length}곳`);
  } catch (e) {
    console.error('저장 실패', e);
    sync.status = navigator.onLine ? 'error' : 'offline';
    sync.message = navigator.onLine ? '서버에 연결하지 못했습니다' : '오프라인 — 연결되면 다시 시도하세요';
    if (manual) toast('저장하지 못했습니다. 잠시 후 다시 눌러 주세요');
  } finally {
    sync.inFlight = false;
    renderSyncBadge();
  }
}

function startPolling() {
  stopPolling();
  if (!shared()) return;
  sync.poller = setInterval(() => {
    if (document.visibilityState === 'visible') pull(false);
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pull(false);
  });
}
function stopPolling() {
  if (sync.poller) clearInterval(sync.poller);
  sync.poller = null;
}

function renderSyncBadge() {
  const el = $('#lastSaved');
  const label = $('#syncLabel');
  const btn = $('#saveBtn');
  const btnText = $('#saveBtnText');

  if (btn) {
    btn.disabled = !state.dirty || sync.status === 'saving';
    btn.classList.toggle('ghost', !state.dirty);
    btnText.textContent = sync.status === 'saving' ? '저장 중…'
      : state.dirty ? '저장하기' : '저장됨';
  }

  if (!shared()) {
    label.textContent = '이 브라우저';
    el.className = 'meta-value';
    el.title = '팀 공유 서버가 설정되지 않았습니다 (config.js)';
    el.innerHTML = `<span class="sync-dot"></span>${state.savedAt ? timeStr(state.savedAt) : '저장 내역 없음'}`;
    return;
  }
  const map = {
    loading: ['syncing', '불러오는 중…'],
    saving: ['syncing', '저장 중…'],
    ok: ['ok', state.dirty ? '저장 안 한 변경 있음' : (sync.lastSync ? timeStr(sync.lastSync) : '동기화됨')],
    error: ['error', '연결 실패'],
    offline: ['error', '오프라인'],
  };
  const [cls, text] = map[sync.status] || ['', '-'];
  label.textContent = '팀 공유';
  el.className = 'meta-value';
  el.title = sync.message || '팀 전체가 같은 목록을 봅니다';
  el.innerHTML = `<span class="sync-dot ${state.dirty && sync.status === 'ok' ? 'auth' : cls}"></span>${esc(text)}`;
}
