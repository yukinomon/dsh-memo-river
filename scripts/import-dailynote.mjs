#!/usr/bin/env node
/**
 * import-dailynote.mjs — 把一篇日记语料导入某个工作区知识库（P1 验证素材）。
 *
 * 用法：
 *   node scripts/import-dailynote.mjs \
 *     --src /home/h/app/VCPToolBox/dailynote/教室建模归档 \
 *     --cwd /home/h/app/dsh-memo-river/.selftest/classroom \
 *     --bucket 教室建模归档
 *
 * 走**插件自己的**入库路径（src/store.ts 的 VCP schema + src/embed.ts 的 relayrouter 调用形状），
 * 不复用参考库——这样嵌入与建表两条链都被真实验证。嵌入结果写入工作区 emb-cache.json，重跑免费。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { KnowledgeStore } from '../lib/store.js'
import { EmbedClient } from '../lib/embed.js'
import { Logger, ensureWorkspaceDirs, workspacePaths } from '../lib/runtime.js'
import { resolveEmbed } from '../lib/workspace.js'
import { Config as ConfigSchema } from '../lib/config.js'

/** 参数解析：`--key value` 与裸布尔 `--force` 都要吃
 * （早期版本按固定步长配对，布尔开关会把后面整串参数错位——实测曾把孤岛语料导进了河流库）。 */
const args = new Map()
const flags = new Set()
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i]
  if (!token.startsWith('--')) continue
  const key = token.replace(/^--/, '')
  const next = process.argv[i + 1]
  if (next === undefined || next.startsWith('--')) {
    flags.add(key)
    continue
  }
  args.set(key, next)
  i += 1
}

const SRC = args.get('src') || '/home/h/app/VCPToolBox/dailynote/教室建模归档'
const CWD = args.get('cwd') || new URL('../.selftest/classroom', import.meta.url).pathname
const BUCKET = args.get('bucket') || basename(SRC)
const FORCE = flags.has('force')

/** 解析 schemastery Config 的默认值（与插件运行时同一份 schema）。
 *
 * ⚠️ vcpRoot 原来硬编码 Linux 路径 `/home/h/app/VCPToolBox`，在别的机器上必然
 *    `resolveEmbed` 返回 source=none（本机 2026-10-01 实测）。改为可覆盖。
 *
 * ⚠️ model / dimension 的 schema **带非空默认值**（gemini-embedding-2-preview / 3072），
 *    而 `resolveEmbed` 的 pick() 判据是「config 有值就不读 env」——默认值会把 config.env 里的
 *    `WhitelistEmbeddingModel` / `VECTORDB_DIMENSION` 彻底挡住（apiUrl/apiKey 默认是空串所以能回落）。
 *    因此要用 config.env 里的模型时，必须显式传 --model / --dimension。 */
const VCP_ROOT = args.get('vcp-root') || process.env.VCP_ROOT || '/home/h/app/VCPToolBox'
const MODEL = args.get('model')
const DIMENSION = args.get('dimension') ? Number(args.get('dimension')) : undefined

const embedOverride = {}
/* 提速资产（0916）：EMBED_STUB_URL 环境变量 → 走本地嵌入桩（setup-selftest 快循环用）。 */
if (process.env.EMBED_STUB_URL) {
  embedOverride.apiUrl = process.env.EMBED_STUB_URL
  embedOverride.apiKey = 'stub'
}
if (MODEL) embedOverride.model = MODEL
if (DIMENSION) embedOverride.dimension = DIMENSION
const config = ConfigSchema({
  bucket: BUCKET,
  native: { vcpRoot: VCP_ROOT },
  ...(Object.keys(embedOverride).length ? { embed: embedOverride } : {}),
})

const paths = workspacePaths(CWD, BUCKET)
ensureWorkspaceDirs(paths)
const logger = new Logger(paths.logPath)
const resolved = resolveEmbed(config, paths)
if (resolved.source === 'none') {
  const envPath = config.native.configEnv || `${VCP_ROOT}/config.env`
  console.error(`❌ 嵌入未配置：检查 ${envPath} 的 API_URL / API_Key（或传 --vcp-root 指定 VCPToolBox 目录）`)
  process.exit(1)
}
console.log(`工作区: ${paths.root}`)
console.log(`库文件: ${paths.dbPath}`)
console.log(`桶    : ${BUCKET}`)
console.log(`嵌入  : ${resolved.apiUrl} model=${resolved.model} dim=${resolved.dimension} source=${resolved.source}`)

const store = new KnowledgeStore(paths.dbPath)
const embed = new EmbedClient({
  apiUrl: resolved.apiUrl,
  apiKey: resolved.apiKey,
  model: resolved.model,
  dimension: resolved.dimension,
  cachePath: paths.embCachePath,
})

const files = readdirSync(SRC)
  .filter((f) => f.endsWith('.txt') || f.endsWith('.md'))
  .sort()

if (!FORCE && store.files(BUCKET).length >= files.length) {
  console.log(`已导入 ${store.files(BUCKET).length} 篇（--force 可重导）`)
  store.close()
  process.exit(0)
}

const TAG_LINE = /^Tag\s*[:：]\s*(.+)$/im

async function main() {
  const tagNames = new Set()
  const parsed = files.map((f) => {
    const content = readFileSync(join(SRC, f), 'utf8')
    const m = content.match(TAG_LINE)
    const tags = m ? m[1].split(/[,，、]/).map((t) => t.trim()).filter(Boolean) : []
    for (const t of tags) tagNames.add(t)
    return { file: f, content, tags }
  })

  console.log(`\n① 嵌入 ${parsed.length} 篇正文 + ${tagNames.size} 个 Tag（命中缓存则不重复消耗额度）`)
  const contents = parsed.map((p) => p.content)
  const tagList = [...tagNames]
  const vectors = await embed.embed([...contents, ...tagList])
  const chunkVectors = vectors.slice(0, contents.length)
  const tagVectors = vectors.slice(contents.length)
  console.log(`   缓存条数=${embed.cacheSize}`)

  console.log('\n② 写入 VCP schema（files / chunks / tags / file_tags）')
  const tagIds = new Map()
  tagList.forEach((name, i) => tagIds.set(name, store.upsertTag(name, tagVectors[i])))

  parsed.forEach((p, i) => {
    const full = join(SRC, p.file)
    const written = store.writeDiary({
      path: full,
      diaryName: BUCKET,
      // VCP 约定（与参考库逐字对齐）：checksum = 文件名；size = 正文字符数（不是字节）。
      // 这两项参与原生图的 content/provenance 代际哈希，写错会让 artifactSig 与生产库分叉。
      checksum: p.file,
      mtime: Date.now(),
      size: p.content.length,
      content: p.content,
      chunkVector: chunkVectors[i],
      tagIds: p.tags.map((t) => tagIds.get(t)),
    })
    console.log(`   D${written.chunkId} ← ${p.file} tags=[${p.tags.join(',')}]`)
  })

  const counts = store.counts()
  console.log(`\n③ 结果：${JSON.stringify(counts)}`)
  logger.info(`import-dailynote src=${SRC} counts=${JSON.stringify(counts)}`)
  store.close()
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
