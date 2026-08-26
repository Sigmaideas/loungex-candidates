/**
 * loungex-candidates-api — Cloudflare Worker + KV
 *
 * 후보지 데이터를 팀이 공유하기 위한 저장소. GitHub Pages 에 올린 정적 대시보드가
 * 이 워커를 호출한다.
 *
 * 엔드포인트
 *   GET  /candidates        → { items, savedAt, rev }
 *   POST /candidates/sync   → { items: [...], deletes: {id: iso} } 를 병합하고 병합 결과를 돌려준다
 *   GET  /ping              → 연결 확인용
 *
 * 인증
 *   없다. 사내 공유 대시보드라 암호 없이 쓰기로 했다. 방어선은 ALLOW_ORIGINS 뿐이고
 *   이건 브라우저만 막는다 — 주소를 아는 사람은 curl 로 그냥 쓸 수 있다.
 *
 * 병합 규칙 (동시 편집 대응)
 *   항목마다 updatedAt 을 비교해 더 최신인 쪽이 이긴다(Last-Write-Wins).
 *   삭제는 tombstone 으로 남겨서, 오프라인이던 클라이언트가 삭제된 항목을
 *   되살리지 못하게 한다. tombstone 은 TOMBSTONE_DAYS 지나면 정리한다.
 */

const KEY = 'candidates';
const TOMBSTONE_DAYS = 60;

const ALLOW_ORIGINS = [
  'https://sigmaideas.github.io',
  'http://localhost:8899',
  'http://127.0.0.1:8899',
  'http://localhost:8000',
];

function corsHeaders(reqOrigin) {
  const allow = ALLOW_ORIGINS.includes(reqOrigin) ? reqOrigin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
  });
}

function emptyDoc() {
  return { rev: 0, savedAt: null, items: [], tombstones: {} };
}

async function readDoc(env) {
  const raw = await env.DATA.get(KEY);
  if (!raw) return emptyDoc();
  try {
    const d = JSON.parse(raw);
    return {
      rev: d.rev || 0,
      savedAt: d.savedAt || null,
      items: Array.isArray(d.items) ? d.items : [],
      tombstones: d.tombstones && typeof d.tombstones === 'object' ? d.tombstones : {},
    };
  } catch (_) {
    return emptyDoc();
  }
}

function pruneTombstones(tombstones) {
  const cutoff = Date.now() - TOMBSTONE_DAYS * 86400000;
  const out = {};
  for (const [id, iso] of Object.entries(tombstones)) {
    const t = Date.parse(iso);
    if (Number.isFinite(t) && t >= cutoff) out[id] = iso;
  }
  return out;
}

function merge(doc, incomingItems, incomingDeletes) {
  const byId = new Map(doc.items.map((i) => [i.id, i]));
  const tombstones = Object.assign({}, doc.tombstones);
  let changed = 0;

  for (const [id, iso] of Object.entries(incomingDeletes || {})) {
    if (typeof id !== 'string' || !id) continue;
    const prev = tombstones[id];
    if (!prev || Date.parse(iso) > Date.parse(prev)) tombstones[id] = iso;
    const existing = byId.get(id);
    if (existing && Date.parse(existing.updatedAt || 0) <= Date.parse(tombstones[id])) {
      byId.delete(id);
      changed++;
    }
  }

  for (const item of incomingItems || []) {
    if (!item || typeof item.id !== 'string' || !item.id) continue;
    const t = tombstones[item.id];
    // 삭제 이후에 수정된 항목만 되살린다
    if (t && Date.parse(item.updatedAt || 0) <= Date.parse(t)) continue;
    if (t) delete tombstones[item.id];
    const existing = byId.get(item.id);
    if (!existing || Date.parse(item.updatedAt || 0) > Date.parse(existing.updatedAt || 0)) {
      byId.set(item.id, item);
      changed++;
    }
  }

  return {
    rev: doc.rev + (changed ? 1 : 0),
    savedAt: changed ? new Date().toISOString() : doc.savedAt,
    items: Array.from(byId.values()),
    tombstones: pruneTombstones(tombstones),
    changed,
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (!env.DATA) return json({ error: 'kv_not_bound' }, 500, cors);

    if (url.pathname === '/ping') return json({ ok: true }, 200, cors);

    if (url.pathname === '/candidates' && request.method === 'GET') {
      const doc = await readDoc(env);
      return json({ items: doc.items, savedAt: doc.savedAt, rev: doc.rev }, 200, cors);
    }

    if (url.pathname === '/candidates/sync' && (request.method === 'POST' || request.method === 'PUT')) {
      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'invalid_json' }, 400, cors);
      }
      const doc = await readDoc(env);
      const merged = merge(doc, body.items, body.deletes);
      if (merged.changed) {
        await env.DATA.put(
          KEY,
          JSON.stringify({ rev: merged.rev, savedAt: merged.savedAt, items: merged.items, tombstones: merged.tombstones })
        );
      }
      return json({ items: merged.items, savedAt: merged.savedAt, rev: merged.rev, changed: merged.changed }, 200, cors);
    }

    return json({ error: 'not_found' }, 404, cors);
  },
};
