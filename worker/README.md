# 후보지 공유 API (Cloudflare Worker + KV)

후보지 데이터를 팀이 같이 보게 해주는 저장소입니다. 이걸 배포하지 않으면 대시보드는
브라우저에만 저장하는 로컬 모드로 동작합니다.

## 배포

```bash
cd worker
npx wrangler login                                  # 한 번만: 브라우저로 Cloudflare 로그인
npx wrangler kv namespace create CANDIDATES         # 출력된 id 를 복사
```

`wrangler.toml` 의 `%%KV_NAMESPACE_ID%%` 를 방금 받은 id 로 바꾸고:

```bash
npx wrangler secret put TEAM_KEY                    # 팀원과 공유할 암호를 입력
npx wrangler deploy                                 # → https://loungex-candidates-api.<계정>.workers.dev
```

배포 주소와 팀 키를 대시보드의 **가져오기 · 내보내기 → 팀 공유 설정** 에 넣으면 끝입니다.
팀원도 같은 두 값을 각자 한 번 입력하면 같은 목록을 봅니다.
(`config.js` 에 주소를 적어 두면 주소는 안 물어보고 팀 키만 입력하면 됩니다.)

## 엔드포인트

모든 요청에 `X-Team-Key` 헤더가 필요합니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/ping` | 팀 키 확인 |
| GET | `/candidates` | 전체 목록 `{ items, savedAt, rev }` |
| POST | `/candidates/sync` | `{ items, deletes }` 를 병합하고 병합 결과를 반환 |
| GET | `/sheet?url=...` | 구글 시트 공개 CSV 중계 (docs.google.com 만 허용) |

## 동시 편집을 어떻게 다루나

클라이언트는 **바뀐 항목만** 보냅니다(마지막으로 서버와 맞춘 스냅샷과 비교).
서버는 항목별 `updatedAt` 을 비교해 더 최신인 쪽을 남깁니다.

삭제는 지우고 끝이 아니라 **tombstone** 으로 60일간 기록합니다. 그래서 오프라인이던
브라우저가 나중에 접속해도 이미 삭제된 후보지를 되살리지 못합니다.
단, 삭제 이후에 수정된 항목은 되살아납니다("지우려던 걸 누가 다시 손봤다" 로 봅니다).

클라이언트는 20초마다, 그리고 탭이 다시 활성화될 때 서버와 맞춥니다.

### 한계

KV 는 트랜잭션이 없어서, 두 사람이 **같은 순간에** 저장하면 한쪽 저장이 유실될 수 있습니다.
그다음 동기화에서 대부분 복구되지만, 완전한 보장이 필요하면 Durable Objects 로 옮겨야 합니다.
후보지 관리처럼 편집 빈도가 낮은 용도에서는 실제로 부딪히기 어려운 조건입니다.

## 보안

- `TEAM_KEY` 하나로 팀 전체를 가르는 구조입니다. 사용자별 계정·권한은 없습니다.
- 호출 가능한 출처는 `worker.js` 의 `ALLOW_ORIGINS` 로 제한합니다.
  자체 도메인에 올린다면 이 목록에 추가하세요.
- `/sheet` 는 `docs.google.com` 만 받습니다. 아무 URL 이나 대신 불러 주는 오픈 프록시가 되지 않게 한 제한입니다.

## 로컬 테스트

```bash
cd worker
npx wrangler dev --port 8788
# 다른 터미널
curl -s -H 'X-Team-Key: <키>' -H 'Origin: http://localhost:8899' http://localhost:8788/ping
```

대시보드는 `http://localhost:8899` 로 띄우면 CORS 허용 목록에 이미 들어 있습니다.
