# 후보지 공유 저장소 (Cloudflare Worker + KV)

대시보드가 팀 전원에게 같은 목록을 보여주기 위한 저장소입니다. 이미 배포돼 있습니다.

**→ https://loungex-candidates-api.sigmaidea.workers.dev**

대시보드는 `config.js` 의 `LOUNGEX_CANDIDATES_API` 로 이 주소를 읽습니다.
비워 두면 브라우저에만 저장하는 로컬 모드로 떨어집니다.

## 다시 배포

```bash
cd worker
npx wrangler deploy
```

처음부터 새로 세우는 경우에만:

```bash
npx wrangler login
npx wrangler kv namespace create CANDIDATES   # 출력된 id 를 wrangler.toml 에 넣는다
npx wrangler deploy
```

KV 가 비어 있으면 대시보드가 `data/candidates.json` 을 넣고 첫 [저장하기] 때 올립니다.

## 엔드포인트

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/ping` | 연결 확인 |
| GET | `/candidates` | 전체 목록 `{ items, savedAt, rev }` |
| POST | `/candidates/sync` | `{ items, deletes }` 를 병합하고 병합 결과를 반환 |

## 동시 편집을 어떻게 다루나

대시보드는 **바뀐 항목만** 보냅니다(마지막으로 서버와 맞춘 스냅샷과 비교).
서버는 항목별 `updatedAt` 을 비교해 더 최신인 쪽을 남깁니다.

삭제는 지우고 끝이 아니라 **tombstone** 으로 60일간 기록합니다. 그래서 오래 열어 둔
브라우저가 나중에 저장해도 이미 삭제된 후보지를 되살리지 못합니다.
단, 삭제 이후에 수정된 항목은 되살아납니다("지우려던 걸 누가 다시 손봤다" 로 봅니다).

### 한계

KV 는 트랜잭션이 없어서, 두 사람이 **같은 순간에** 저장하면 한쪽 저장이 유실될 수 있습니다.
그다음 불러오기에서 대부분 드러나지만, 완전한 보장이 필요하면 Durable Objects 로 옮겨야 합니다.
후보지 관리처럼 편집 빈도가 낮은 용도에서는 실제로 부딪히기 어려운 조건입니다.

## 보안 — 인증이 없습니다

이 API 는 아무나 부를 수 있습니다. **주소를 아는 사람은 curl 로 후보지 데이터를 읽고, 고치고, 지울 수 있습니다.**
사내 도구라 편의를 택한 결정입니다.

`ALLOW_ORIGINS` 로 호출 출처를 제한하고는 있지만 이건 브라우저에서만 지켜지는 규칙이라
방어선으로 치기 어렵습니다.

막아야 할 때는 팀 공용 암호 하나를 두는 정도가 가장 싼 방법입니다.

```bash
npx wrangler secret put TEAM_KEY
```

그리고 `worker.js` 의 fetch 앞부분에 검사를 넣고, 대시보드가 요청에 `X-Team-Key` 헤더를 붙이게 합니다
(`Access-Control-Allow-Headers` 에도 추가). 팀원은 브라우저마다 한 번씩 키를 넣어야 합니다.

## 로컬 테스트

```bash
cd worker
npx wrangler dev --port 8788
curl -s -H 'Origin: http://localhost:8899' http://localhost:8788/ping
```

대시보드는 `http://localhost:8899` 로 띄우면 CORS 허용 목록에 이미 들어 있습니다.
단, `config.js` 가 **운영 워커**를 가리키므로 로컬에서 누른 [저장하기] 도 실제 팀 데이터에 반영됩니다.
