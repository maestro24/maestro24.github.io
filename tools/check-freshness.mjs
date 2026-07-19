#!/usr/bin/env node
/**
 * check-freshness.mjs — 계산기 사이트 데이터 신선도 감시 (zero-dep, node >= 18)
 *
 * 계산기 사이트에서 낡은 상수(세율·환율·요율)는 "조용히 틀린 답"을 냄 — 에러도
 * 안 나고 사용자만 손해봄. pension-blog의 constantsLastVerified 패턴을 전 사이트로
 * 일반화한 것. shared/sites.json의 freshness 규칙을 읽어 각 데이터 파일의 나이를
 * 판정하고, 한도 초과를 리포트함.
 *
 * 날짜 판정 우선순위:
 *   1) JSON 내부 날짜 필드: verifiedAt > updated > asOf > version(YYYY-MM-DD형) > date
 *   2) 없으면 git 마지막 커밋 날짜 (각 사이트는 독립 repo)
 *   3) 그것도 없으면 파일 mtime
 *
 * 사용:
 *   node tools/check-freshness.mjs           # 전체 리포트
 *   node tools/check-freshness.mjs --fail    # 초과 항목 있으면 exit 1 (CI/cron용)
 *
 * 주기 실행 권장: 주 1회. (수동이면 월요일 아침, 자동이면 스케줄러에 등록)
 */

import { readFileSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = resolve(HUB, '..')
const FAIL_MODE = process.argv.includes('--fail')

const registry = JSON.parse(readFileSync(join(HUB, 'shared', 'sites.json'), 'utf8'))
const DATE_FIELDS = ['verifiedAt', 'updated', 'asOf', 'version', 'date']
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/

function findDateInJson(obj, depth = 0) {
  if (depth > 3 || typeof obj !== 'object' || obj === null) return null
  for (const f of DATE_FIELDS) {
    const v = obj[f] ?? obj.meta?.[f]
    if (typeof v === 'string') {
      const m = v.match(DATE_RE)
      if (m) return new Date(m[0])
    }
  }
  for (const v of Object.values(obj)) {
    const found = findDateInJson(v, depth + 1)
    if (found) return found
  }
  return null
}

function gitDate(siteDir, relFile) {
  try {
    const out = execSync(`git log -1 --format=%cI -- "${relFile}"`, {
      cwd: siteDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out ? new Date(out) : null
  } catch { return null }
}

const rows = []
let breaches = 0

for (const site of registry.sites) {
  for (const rule of site.freshness ?? []) {
    const siteDir = join(WORKSPACE, site.name)
    const filePath = join(siteDir, rule.file)
    let date = null
    let source = '-'
    try {
      const raw = readFileSync(filePath, 'utf8')
      date = findDateInJson(JSON.parse(raw))
      if (date) source = 'json'
    } catch { /* 파일 없음/파싱 실패 → 아래 폴백 */ }
    if (!date) { date = gitDate(siteDir, rule.file); if (date) source = 'git' }
    if (!date) { try { date = statSync(filePath).mtime; source = 'mtime' } catch { /* missing */ } }

    if (!date) {
      rows.push({ site: site.name, file: rule.file, age: 'FILE MISSING', status: '❌', rule })
      breaches++
      continue
    }
    const ageDays = Math.floor((Date.now() - date.getTime()) / 86_400_000)
    const over = ageDays > rule.maxAgeDays
    if (over) breaches++
    rows.push({
      site: site.name, file: rule.file,
      age: `${ageDays}d (${source}, 한도 ${rule.maxAgeDays}d)`,
      status: over ? (rule.risk === 'HIGH' ? '🔥 초과' : '⚠️ 초과') : '✅', rule,
    })
  }
}

console.log('데이터 신선도 리포트 — ' + new Date().toISOString().slice(0, 10) + '\n')
for (const r of rows) {
  console.log(`${r.status}  ${r.site}/${r.file} — ${r.age}`)
  if (r.status !== '✅') console.log(`      ↳ ${r.rule.label}`)
}
console.log(`\n총 ${rows.length}개 규칙, 초과 ${breaches}건`)
if (breaches && FAIL_MODE) process.exit(1)
