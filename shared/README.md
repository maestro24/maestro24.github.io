# shared/ — 300project 공유 블록 소스 오브 트루스

19개 사이트에 손복사돼 있던 공통 블록(GA4, 쿠팡 고지문)의 **유일한 수정 지점.**
여기서 고치고 `tools/propagate.mjs`로 전파한다. 사이트 파일의 마커 영역을 직접 편집하지 말 것 —
다음 전파 때 덮어써짐.

## 구성
- `templates/ga4.html` — GA4 스니펫 (전 사이트 단일 ID `G-2P73L29BH7`)
- `templates/disclosure.html` — 쿠팡 파트너스 고지문 (쿠팡 링크 있는 페이지 필수)
- `sites.json` — 사이트 레지스트리: 쿠팡 여부, 데이터 신선도 규칙

## 사용법
```bash
cd maestro24.github.io
node tools/propagate.mjs              # dry-run: 뭐가 바뀔지 리포트
node tools/propagate.mjs --apply      # 실제 적용 (이후 각 사이트 repo에서 커밋)
node tools/check-freshness.mjs        # 데이터 신선도 리포트
node tools/check-freshness.mjs --fail # cron/CI용 (초과 시 exit 1)
```

## 마커 규약
사이트 파일 안의 공유 블록은 마커로 감싸져 있음:
```html
<!-- shared:ga4 -->
...전파된 내용 (직접 수정 금지)...
<!-- /shared:ga4 -->
```

## 주의
- **check-freshness는 로컬 파일 기준.** baroconvert/stockcal은 봇이 origin에 커밋하므로
  체크 전에 `git pull` 필수 — 안 하면 로컬 랙을 프로덕션 장애로 오판함 (2026-07-19 실제 사례).
- propagate 후 각 사이트는 독립 repo라서 **개별 commit/push 필요.** push가 곧 배포(GH Pages).
- 신규 사이트는 `.claude/skills/new-tool-site` 스킬로 생성 → sites.json 등록까지가 완성.

## 알려진 잔여 이슈 (2026-07-19 감사)
- 유령 coupang.js 4개: curtainsize, diaperlab, kimjang, petfeed — 파일은 있는데 HTML이 로드 안 함 (링크는 하드코딩으로 동작 중). 삭제 또는 로드 전환 결정 필요.
- 링크 코드 불일치: diaperlab (js `fnv2guqgGO` vs html `fnvVW9OMs8`), replacelab (js `fnxIjnErXE` vs html `flCfhuxEJM`) — 어느 쪽이 canonical인지 확인 필요.
- baroconvert 리프 ~374페이지 무수익화 (허브 43페이지만 쿠팡 있음) — generate.py 수정으로 확장 가능.
- damoatool index 무수익화, nohoolab 전체 무수익화 (의도인지 확인).
- GA4 단일 속성 공유 — 사이트별 분리는 GA4에서 hostname 필터로 가능.
