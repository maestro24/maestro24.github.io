#!/usr/bin/env node
/**
 * propagate.mjs — 공유 블록을 전 사이트에 전파하는 도구 (zero-dep, node >= 18)
 *
 * 문제: 19개 사이트 × 수백 HTML에 GA4/고지문이 손복사돼 있어, 한 줄 수정이
 * 수백 파일 편집이 됨. 이 스크립트가 "한 곳 수정 → 한 명령 전파"로 바꿈.
 *
 * 모델: 런타임 공유가 아니라 빌드타임 스탬핑.
 *   - 각 사이트는 독립 GitHub repo (GH Pages project page) → 런타임 /shared 참조는
 *     로컬 dev(python -m http.server)를 깨뜨림. 대신 파일 안에 마커로 감싼 블록을
 *     박아넣고, 변경 시 이 스크립트가 마커 영역만 갈아끼움.
 *   - 마커: <!-- shared:NAME --> ... <!-- /shared:NAME -->
 *   - 마커가 없는 기존 파일은 legacy 패턴(정규식)을 찾아 마커 블록으로 1회 치환(채택).
 *
 * 사용:
 *   node tools/propagate.mjs                  # dry-run (기본): 바꿀 내용 리포트만
 *   node tools/propagate.mjs --apply          # 실제 쓰기
 *   node tools/propagate.mjs --target ga4     # 특정 블록만 (ga4 | disclosure)
 *   node tools/propagate.mjs --site salarylab # 특정 사이트만
 *   node tools/propagate.mjs --add-missing    # 블록이 아예 없는 파일에도 삽입
 *
 * 소스 오브 트루스: shared/templates/*.html + shared/sites.json (이 repo에서만 수정)
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = resolve(HUB, '..')

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const ADD_MISSING = args.includes('--add-missing')
const targetArg = args.includes('--target') ? args[args.indexOf('--target') + 1] : 'all'
const siteArg = args.includes('--site') ? args[args.indexOf('--site') + 1] : null

const registry = JSON.parse(readFileSync(join(HUB, 'shared', 'sites.json'), 'utf8'))

function template(name) {
  return readFileSync(join(HUB, 'shared', 'templates', name), 'utf8').trim()
}

function marked(name, body) {
  return `<!-- shared:${name} -->\n${body}\n<!-- /shared:${name} -->`
}

/** 블록 정의: 마커 이름, 템플릿, legacy 감지 정규식, 삽입 위치 */
const BLOCKS = {
  ga4: {
    template: () => template('ga4.html'),
    files: (site) => htmlFiles(site),
    // 기존 gtag 스니펫 (멀티라인/미니파이 양쪽) — async 로더 + 인라인 config 쌍
    legacy: /<script\s+async\s+src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]+"><\/script>\s*<script>[\s\S]{0,600}?gtag\(\s*['"]config['"][\s\S]{0,200}?<\/script>/,
    insertAfter: /<head[^>]*>/,
    appliesTo: () => true,
  },
  disclosure: {
    template: () => template('disclosure.html'),
    files: (site) => [join(WORKSPACE, site.name, 'index.html')].filter(exists),
    // 기존 고지문 문구가 들어있는 컨테이너는 건드리지 않음 (있으면 준수 상태로 간주)
    legacy: /쿠팡\s*파트너스\s*활동의?\s*일환으로/,
    legacyReportOnly: true, // legacy 발견 시 치환하지 않고 "이미 있음" 처리
    insertBefore: /<\/body>/i,
    appliesTo: (site) => site.coupang === true,
    // 고지문 의무는 페이지 단위: 쿠팡 링크가 실제로 있는 페이지에만 적용
    fileApplies: (src) => /link\.coupang\.com|ads-partners\.coupang\.com/.test(src),
  },
}

function exists(p) { try { statSync(p); return true } catch { return false } }

// 스캔 제외: 방문자에게 서빙되지 않거나 GA4가 있어선 안 되는 파일
const EXCLUDE_DIRS = new Set(['node_modules', 'tests', 'test', 'fixtures', 'docs'])
const EXCLUDE_FILE = /^googlef58c|^naver[0-9a-f]*\.html$/

function htmlFiles(site) {
  const root = join(WORKSPACE, site.name)
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || EXCLUDE_DIRS.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.html') && !EXCLUDE_FILE.test(e.name)) out.push(p)
    }
  }
  if (exists(root)) walk(root)
  return out
}

const stats = { normalized: 0, adopted: 0, inserted: 0, alreadyOk: 0, skipped: 0, files: 0 }
const defects = []

for (const site of registry.sites) {
  if (siteArg && site.name !== siteArg) continue
  for (const [name, spec] of Object.entries(BLOCKS)) {
    if (targetArg !== 'all' && targetArg !== name) continue
    if (!spec.appliesTo(site)) continue
    const block = marked(name, spec.template())
    const markerRe = new RegExp(`<!-- shared:${name} -->[\\s\\S]*?<!-- /shared:${name} -->`)

    for (const file of spec.files(site)) {
      stats.files++
      let src
      try { src = readFileSync(file, 'utf8') } catch { continue }
      const rel = file.slice(WORKSPACE.length + 1)
      if (spec.fileApplies && !spec.fileApplies(src)) { stats.skipped++; continue }
      let next = src
      let action = null

      if (markerRe.test(src)) {
        next = src.replace(markerRe, block)
        action = next === src ? 'alreadyOk' : 'normalized'
      } else if (spec.legacy.test(src)) {
        if (spec.legacyReportOnly) {
          action = 'alreadyOk' // 기존 문구 존재 — 준수. 마커 채택은 강제하지 않음
        } else {
          next = src.replace(spec.legacy, block)
          action = 'adopted'
        }
      } else if (ADD_MISSING) {
        if (spec.insertAfter && spec.insertAfter.test(src)) {
          next = src.replace(spec.insertAfter, (m) => `${m}\n${block}`)
          action = 'inserted'
        } else if (spec.insertBefore && spec.insertBefore.test(src)) {
          next = src.replace(spec.insertBefore, `${block}\n$&`)
          action = 'inserted'
        } else {
          defects.push(`${rel}: ${name} 삽입 지점 없음`)
          action = 'skipped'
        }
      } else {
        defects.push(`${rel}: ${name} 블록/legacy 패턴 없음 (--add-missing 필요)`)
        action = 'skipped'
      }

      stats[action]++
      if (next !== src) {
        if (APPLY) writeFileSync(file, next)
        else console.log(`[dry] ${action}: ${rel} (${name})`)
      }
    }
  }
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'} — files scanned: ${stats.files}`)
console.log(`  normalized(마커 갱신): ${stats.normalized}`)
console.log(`  adopted(legacy→마커): ${stats.adopted}`)
console.log(`  inserted(신규 삽입): ${stats.inserted}`)
console.log(`  already-ok: ${stats.alreadyOk}`)
console.log(`  skipped: ${stats.skipped}`)
if (defects.length) {
  console.log(`\n확인 필요 (${defects.length}):`)
  for (const d of defects.slice(0, 40)) console.log('  - ' + d)
  if (defects.length > 40) console.log(`  ... 외 ${defects.length - 40}건`)
}
