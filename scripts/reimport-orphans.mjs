#!/usr/bin/env node
/**
 * reimport-orphans.mjs — BUG-0930 数据重灌：把桶 dailynote/ 里存在 .md 原文
 * 但库内无 files 行的孤儿日记重新入库（走 writeDiaryCore 全管线：Tag 闸门、
 * 嵌入、体检增量，与 memo_write 同一道闸）。
 *
 * 背景：genshin-ts 桶（4bde2299850f027e）9 篇日记行在进程启动边界被 WAL 回卷
 * 静默删除（根因复刻内核缺 keepalive，已修）；dailynote .md 是真源、库是派生面。
 *
 * 用法：node scripts/reimport-orphans.mjs <workspace-cwd> [bucketName]
 * 安全闸：config.native.kernel === 'reimpl' 时拒绝运行（旧 .node 无 keepalive
 * 会把刚灌的行再吃掉——必须先重启回 vcp 轨或用已移植内核）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { Config } from '../lib/index.js'
import { acquireWorkspace, releaseAllWorkspaces } from '../lib/workspace.js'
import { writeDiaryCore } from '../lib/tools.js'
import { parseTagLine } from '../lib/drafts.js'

const cwd = process.argv[2] ?? '/home/h/genshin-ts'
const bucketHint = process.argv[3] ?? 'genshin-ts'

const config = Config({})
if (config.native.kernel === 'reimpl') {
  console.error('拒绝：native.kernel=reimpl（旧内核无 keepalive，重灌行会被 WAL 回卷再吃）。先重启回 vcp 轨。')
  process.exit(2)
}

const ws = acquireWorkspace(cwd, config)
const bucketDir = join(ws.paths.root, 'dailynote', ws.paths.bucket)
const files = readdirSync(bucketDir).filter((f) => f.endsWith('.md')).sort()
const known = new Set(ws.store.files().map((r) => basename(r.path)))
const orphans = files.filter((f) => !known.has(f))
console.log(`桶=${ws.paths.hash} dailynote=${files.length} 篇，库内=${known.size} 行，孤儿=${orphans.length} 篇`)
if (orphans.length === 0) { releaseAllWorkspaces(); process.exit(0) }

let written = 0
const rejected = []
for (const name of orphans) {
  const content = readFileSync(join(bucketDir, name), 'utf8')
  const tags = parseTagLine(content)
  const title = (content.match(/^#\s+(.+)$/m) ?? [])[1]?.trim() ?? ''
  const date = (name.match(/^(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? new Date().toISOString().slice(0, 10)
  const res = await writeDiaryCore(ws, {
    content,
    tags,
    title,
    date,
    bucket: ws.paths.diaryName ?? bucketHint,
    newTagReason: 'BUG-0930 重灌：原日记行随 WAL 回卷丢失，恢复原 Tag 词汇',
    toolName: 'reimport-orphans',
    preamble: `BUG-0930 重灌 ${name}`,
  })
  if (res.status === 'written') { written++; console.log(`✅ ${name} → chunkId=${res.chunkId} tags=${res.tags?.join('/')}`) }
  else { rejected.push(name); console.log(`❌ ${name} :: ${res.report.split('\n')[0]}`) }
}
const after = ws.store.files().length
console.log(`\n重灌完成：written=${written} rejected=${rejected.length} 库内 files=${known.size}→${after}`)
releaseAllWorkspaces()
