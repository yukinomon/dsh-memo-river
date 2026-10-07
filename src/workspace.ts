/**
 * src/workspace.ts — 工作区级运行期：库 + 嵌入 + 原生引擎 + 召回。
 *
 * **工作区级（不是会话级）**：同一工作区的多个会话共享一份库与一份原生索引；
 * 会话级状态一律放 src/session.ts 的 Map（DESIGN.md §5.2 / §6.5）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, join } from 'node:path'
import type { Config } from './config.js'
import { closeEmbedTransport, EmbedClient, embedTransportIntent } from './embed.js'
import { MemoEngine, loadKnowledgeBaseManager } from './native.js'
import {
  Logger,
  ensureWorkspaceDirs,
  loadEnvFile,
  memoRiverRoot,
  readJsonSafe,
  workspaceHash,
  workspacePaths,
  workspacePathsAtRoot,
  type WorkspacePaths,
} from './runtime.js'
import { KnowledgeStore } from './store.js'
import { recall, type RecallOptions, type RecallOutcome } from './recall.js'

export interface ResolvedEmbed {
  apiUrl: string
  apiKey: string
  model: string
  dimension: number
  /** 来源标注（取证用）：config / config.env / none。 */
  source: 'config' | 'config.env' | 'none'
}

/** 持闸工作区集合（AsyncLocalStorage）：withDb 同上下文重入直通判定用。 */
const dbGateContext = new AsyncLocalStorage<ReadonlySet<WorkspaceRuntime>>()

export class WorkspaceRuntime {
  readonly logger: Logger
  readonly embed: EmbedClient
  readonly engine: MemoEngine
  private loaded = false
  private loadError: string | null = null
  /** 单飞：并发首次载入共享同一次 `engine.load()`（否则第二个调用者会把索引重建一遍，
   *  把第一个正在用的 `tagIndex`/`runtime` 换掉——与 memo 代际竞态同族）。 */
  private loading: Promise<boolean> | null = null

  /* ────────────── SIGBUS 防护串行闸（2026-09-28，机理见 store.ts 注释） ──────────────
   *
   * 进程内两份 sqlite（node 内嵌 + rust-vexus-lite 内嵌 rusqlite）互看不见对方的
   * fcntl 锁：node:sqlite 访问与 rust AsyncTask 并发碰同一库文件时，WAL wal-index
   * 可能被写坏 → BUS_ADRERR（SIGBUS）。三层防护：
   *   ① 本闸（withDb）：同一工作区的**整段操作**（工具/注入/守护 tick）串行执行；
   *   ② engine 自闸：碰原生的公有入口自行过闸（AsyncLocalStorage 可重入，嵌套直通）；
   *   ③ store 护栏：native AsyncTask 在飞（engine.nativeBusy>0）时 store 任何方法
   *      直接抛错——把未收敛到闸内的漏网访问变成可归因异常，而不是崩溃。
   * 代价：闸横跨 embed HTTP await（写入持闸数秒）——同工作区并发操作排队而非并行。 */
  private dbGate: Promise<unknown> = Promise.resolve()

  private constructor(
    readonly paths: WorkspacePaths,
    readonly store: KnowledgeStore,
    readonly resolved: ResolvedEmbed,
    readonly config: Config,
  ) {
    this.logger = new Logger(paths.logPath)
    this.embed = new EmbedClient({
      apiUrl: resolved.apiUrl,
      apiKey: resolved.apiKey,
      model: resolved.model,
      dimension: resolved.dimension,
      cachePath: paths.embCachePath,
    })
    this.engine = new MemoEngine({
      vcpRoot: config.native.vcpRoot,
      kernel: config.native.kernel,
      dimension: resolved.dimension,
      modelSig: `${resolved.model}${config.native.modelSigSuffix}`,
      diaryName: paths.bucket,
      store: this.store,
      gate: (fn) => this.withDb(fn),
    })
    KnowledgeStore.installGuard(this.store, () => this.assertStoreIdle())
  }

  /** 工作区串行闸：整段 fn 持锁执行；同一异步上下文重入直通（ALS 判定）。 */
  withDb<T>(fn: () => Promise<T>): Promise<T> {
    const held = dbGateContext.getStore()
    if (held?.has(this)) return fn()
    const run = this.dbGate.then(async () => {
      const next = new Set(held ?? [])
      next.add(this)
      return dbGateContext.run(next, fn)
    })
    this.dbGate = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** store 护栏检查：native AsyncTask 在飞时拒绝一切 store 访问（见类头注释③）。 */
  private assertStoreIdle(): void {
    if (this.engine.nativeBusy > 0) {
      throw new Error(
        'memo-river store-busy：native AsyncTask 在飞，node:sqlite 访问被拒（SIGBUS 防护）。' +
          '该访问路径未收敛到 workspace.withDb 串行闸——请把整段操作包进 withDb 或改用 *Locked 变体。',
      )
    }
  }

  /** 同步 store 读的**不排队**通道：护栏拦下（原生在飞）时自旋重试而非入闸排队。
   *
   * 为什么不能 withDb：withDb 是排队语义。preamble（composeReinjection 等）在闸外
   * 并行在飞，而闸内持有者（writeDiaryCoreLocked）可能正在 await 这个 preamble——
   * preamble 若入闸排队就是循环等待（实测死锁：acceptance #6 unsettled top-level await）。
   *
   * 为什么自旋安全：fn 是同步读。JS 单线程下同步执行期间不可能有新的 native
   * AsyncTask 被启动（那需要 JS 调它）；护栏在入口检查 nativeBusy==0 即足够。 */
  async readSync<T>(fn: () => T, timeoutMs = 30_000): Promise<T> {
    const t0 = Date.now()
    for (;;) {
      try {
        return fn()
      } catch (e) {
        const msg = String((e as Error)?.message ?? e)
        if (!msg.startsWith('memo-river store-busy')) throw e
        if (Date.now() - t0 > timeoutMs) throw e
        await new Promise((r) => setTimeout(r, 25))
      }
    }
  }

  /** fire-and-forget 后台任务：**脱离当前 ALS 闸上下文**再启动。
   *
   * 若在持闸上下文里直接 void 一个 async 任务，其内部的 gate 调用（engine 的自闸）
   * 会经 ALS 判定「已持闸」而直通——闸释放后它就变成闸外裸跑，与下一个持闸操作
   * 交错，护栏炸 store-busy。exit 后任务会正常排队入闸。 */
  background(fn: () => Promise<unknown>): void {
    dbGateContext.exit(() => {
      void fn()
    })
  }

  static open(cwd: string, config: Config): WorkspaceRuntime {
    const paths = workspacePaths(cwd, config.bucket, config.logFile || undefined)
    ensureWorkspaceDirs(paths)

    const resolved = resolveEmbed(config, paths)
    const store = new KnowledgeStore(paths.dbPath)
    const runtime = new WorkspaceRuntime(paths, store, resolved, config)
    runtime.logger.info(
      `workspace-open cwd=${cwd} hash=${paths.hash} bucket=${paths.bucket} db=${paths.dbPath} embed=${resolved.source} transport=${embedTransportIntent()}`,
    )
    return runtime
  }

  /** 票 01（recall-quality-0916）：按已解析路径打开——跨桶真路由用。
   *
   * 目录已存在（resolveBucket 保证 hasDb），**不建目录、不写 manifest**；嵌入配置
   * 沿用本插件部署（全机共享同一端点，目标桶向量即由它产出）；日志落目标桶自己的
   * memo-river.log（跨桶召回在目标桶口径下留痕）。 */
  static openExisting(paths: WorkspacePaths, config: Config): WorkspaceRuntime {
    const resolved = resolveEmbed(config, paths)
    const store = new KnowledgeStore(paths.dbPath)
    const runtime = new WorkspaceRuntime(paths, store, resolved, config)
    runtime.logger.info(
      `bucket-route-open bucket=${paths.bucket} hash=${paths.hash} db=${paths.dbPath} embed=${resolved.source} transport=${embedTransportIntent()}`,
    )
    return runtime
  }

  get corpusCounts(): { tags: number; files: number; chunks: number; fileTags: number } {
    return this.store.counts()
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  /** 载入原生索引（幂等 + 单飞；失败只记一次错误并降级为不可召回）。 */
  async ensureLoaded(): Promise<boolean> {
    if (this.loaded) return true
    if (this.loadError !== null) return false
    if (this.loading) return this.loading
    const run = (async (): Promise<boolean> => {
      try {
        await this.engine.load()
        this.loaded = true
        this.logger.info(`native-loaded chunkIds=${this.engine.chunkIds.length} runtime=${this.engine.runtimeAvailable}`)
        return true
      } catch (e) {
        this.loadError = String((e as Error)?.message ?? e)
        this.logger.error(`native-load-failed: ${this.loadError}`)
        return false
      }
    })()
    this.loading = run
    try {
      return await run
    } finally {
      if (this.loading === run) this.loading = null
    }
  }

  /** 跑一次召回；永不抛（失败即 injected=false + fallbackReason）。整段持串行闸。 */
  async recall(queryText: string, options: RecallOptions): Promise<RecallOutcome> {
    return this.withDb(() => this.recallLocked(queryText, options))
  }

  private async recallLocked(queryText: string, options: RecallOptions): Promise<RecallOutcome> {
    const ok = await this.ensureLoaded()
    if (!ok) {
      return {
        injected: false,
        fallbackReason: `native-unavailable: ${this.loadError ?? 'unknown'}`,
        gate: {
          passed: false,
          maxKnn: 0,
          threshold: options.gateThreshold,
          enabled: options.gate,
          gateVector: 'none',
          retrievalMaxKnn: 0,
        },
        mode: options.mode,
        omega: null,
        regime: null,
        dynamicK: options.dynamicK,
        candidateCount: 0,
        candidates: [],
        selected: [],
        dropped: [],
        diagnostics: {},
        elapsedMs: 0,
      }
    }
    return recall(
      { store: this.store, embed: this.embed, engine: this.engine, dimension: this.resolved.dimension },
      queryText,
      options,
    )
  }

  close(): void {
    try {
      this.engine.dispose()
    } catch {
      /* 静默 */
    }
    this.store.close()
  }
}

/** 嵌入配置解析：插件 config 优先 → VCP config.env → 空（不可调用）。 */
export function resolveEmbed(config: Config, paths: WorkspacePaths): ResolvedEmbed {
  const envPath = config.native.configEnv || `${config.native.vcpRoot}/config.env`
  const env: Record<string, string> = existsSync(envPath) ? loadEnvFile(envPath) : {}
  const pick = (fromConfig: string, envKey: string): { value: string; from: 'config' | 'config.env' | 'none' } => {
    if (fromConfig && fromConfig.trim()) return { value: fromConfig.trim(), from: 'config' }
    const e = env[envKey]
    if (e && e.trim()) return { value: e.trim(), from: 'config.env' }
    return { value: '', from: 'none' }
  }
  const apiUrl = pick(config.embed.apiUrl, 'API_URL')
  const apiKey = pick(config.embed.apiKey, 'API_Key')
  const model = pick(config.embed.model, 'WhitelistEmbeddingModel')
  const envDim = Number(env.VECTORDB_DIMENSION)
  const dimension = config.embed.dimension || (Number.isFinite(envDim) && envDim > 0 ? envDim : 3072)
  const source: ResolvedEmbed['source'] =
    apiUrl.from === 'none' || apiKey.from === 'none' ? 'none' : apiKey.from === 'config' ? 'config' : 'config.env'
  return { apiUrl: apiUrl.value, apiKey: apiKey.value, model: model.value || 'gemini-embedding-2-preview', dimension, source }
}

/* ────────────── 工作区注册表（按 cwd 哈希键；会话状态不在此） ────────────── */

const registry = new Map<string, WorkspaceRuntime>()

/**
 * 挂载级引用计数（BUG-1003 票14）：registry 本身按桶数有界，这里收口是为了
 * 挂载代际（?v= churn / fiber dispose）后尽快归还 sqlite fd 与引擎资源。
 * retain/release 只在挂载边界配对（daemonFor ↔ 守护收口 effect）；逐工具调用
 * 不计数——调用是瞬态复用，计入会破坏配对不变量（调完无人 release）。
 */
const mountRefs = new Map<string, { count: number; closeTimer?: ReturnType<typeof setTimeout> }>()

export function retainWorkspace(key: string): void {
  const entry = mountRefs.get(key) ?? { count: 0 }
  entry.count += 1
  if (entry.closeTimer) {
    clearTimeout(entry.closeTimer)
    entry.closeTimer = undefined
  }
  mountRefs.set(key, entry)
}

export function releaseWorkspace(key: string, graceMs = 30_000): void {
  const entry = mountRefs.get(key)
  if (!entry || entry.count <= 0) return
  entry.count -= 1
  if (entry.count > 0) return
  /* 宽限关闭：等瞬态调用（注入尾巴/守护 tick）自然收尾；期间新挂载可撤销。 */
  entry.closeTimer = setTimeout(() => {
    mountRefs.delete(key)
    const runtime = registry.get(key)
    if (!runtime) return
    registry.delete(key)
    try {
      runtime.close()
    } catch {
      /* 单桶收口失败不阻塞其余 */
    }
  }, graceMs)
  entry.closeTimer.unref?.()
}

export function acquireWorkspace(cwd: string, config: Config): WorkspaceRuntime {
  const key = workspaceHash(cwd)
  const existing = registry.get(key)
  if (existing) return existing
  const runtime = WorkspaceRuntime.open(cwd, config)
  registry.set(key, runtime)
  return runtime
}

export function releaseAllWorkspaces(): void {
  for (const runtime of registry.values()) runtime.close()
  registry.clear()
  // 票 02：共享 undici Agent 是进程级的，所有工作区都释放后才收掉传输层连接池。
  closeEmbedTransport()
}

/* ────────────── 票 01（recall-quality-0916）：桶名→状态目录解析（memo_recall folder 真路由） ──────────────
 *
 * 旧实现是「本桶检索 + 结果集按 diaryName 事后过滤」，跨桶查询必然 0 命中——目标条目
 * 根本不在本桶语料里（D58 归因纠偏①：genshin-ts 千星知识图谱在其他项目永远查不到）。
 * 真路由 = 把桶名解析到状态目录（~/.dsh/memo-river/<hash>/），在目标桶上打开运行时执行检索。
 *
 * 解析规则（按可靠性排序）：
 *   ① folder 是 16 位 hex → 视为工作区哈希（manifest.hash / 目录名精确匹配，同名消歧通道）；
 *   ② workspace.json manifest 的 bucket 字段精确匹配；
 *   ③ 无 manifest 桶名时退回 dailynote/ 唯一子目录名。
 * 桶名在本机**不保证唯一**（历史 /var/tmp 自净测试桶留有大量同名根）：同名多桶 →
 * 报错列出候选让调用方用哈希消歧——静默挑一个会把查询打到错误的库上。 */

/** 状态根下的一个桶（可路由单元）。 */
export interface BucketEntry {
  /** 工作区哈希（manifest.hash 优先，缺省目录名）。 */
  hash: string
  /** 状态目录绝对路径。 */
  root: string
  /** 桶名（diary_name）。 */
  bucket: string
  /** manifest 里的 cwd（可能缺失）。 */
  cwd: string | null
  /** knowledge_base.sqlite 是否存在（可检索的前提；纯日志残目录不算桶）。 */
  hasDb: boolean
  /** workspace.json 的 mtime（ms；排序用，新的在前——歧义提示里最近的更可能是想要的）。 */
  updatedAt: number
}

/** 列出状态根下全部桶（只读、永不抛；扫不动返回空）。 */
export function listBuckets(): BucketEntry[] {
  const out: BucketEntry[] = []
  let roots: string[]
  try {
    roots = readdirSync(memoRiverRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(memoRiverRoot(), d.name))
  } catch {
    return out
  }
  for (const root of roots) {
    const manifestPath = join(root, 'workspace.json')
    const hasDb = existsSync(join(root, 'knowledge_base.sqlite'))
    if (!hasDb && !existsSync(manifestPath)) continue
    const manifest = readJsonSafe<{ cwd?: string; bucket?: string; hash?: string }>(manifestPath, {})
    let bucket = typeof manifest.bucket === 'string' && manifest.bucket ? manifest.bucket : ''
    if (!bucket) {
      // 无 manifest 桶名：dailynote/ 唯一子目录名兜底（多个子目录无法定位桶名，跳过）
      try {
        const subs = readdirSync(join(root, 'dailynote'), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
        if (subs.length === 1) bucket = subs[0]!
      } catch {
        /* 无 dailynote/：兜底不了 */
      }
    }
    if (!bucket) continue
    let updatedAt = 0
    try {
      updatedAt = statSync(manifestPath).mtimeMs
    } catch {
      /* 缺 manifest 记 0（排序垫底） */
    }
    out.push({
      hash: (typeof manifest.hash === 'string' && manifest.hash) || basename(root),
      root,
      bucket,
      cwd: typeof manifest.cwd === 'string' ? manifest.cwd : null,
      hasDb,
      updatedAt,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt || a.bucket.localeCompare(b.bucket))
}

/** 可用桶清单（去重桶名、有库者优先、截 30——桶多的机器上别刷屏）。 */
function availableBucketLines(entries: BucketEntry[]): string[] {
  const names: string[] = []
  for (const e of entries) {
    if (!e.hasDb || names.includes(e.bucket)) continue
    names.push(e.bucket)
  }
  names.sort((a, b) => a.localeCompare(b))
  const cap = 30
  return [`可用桶（${names.length} 个）：${names.slice(0, cap).join('、')}${names.length > cap ? ` …还有 ${names.length - cap} 个` : ''}`]
}

export type BucketResolution = { ok: true; entry: BucketEntry } | { ok: false; error: string }

/** 桶名/16 位哈希 → 状态目录。失败返回**完整报错文本**（含可用桶清单；memo_recall 原样返回）。 */
export function resolveBucket(folder: string): BucketResolution {
  const entries = listBuckets()
  const byHash = /^[0-9a-f]{16}$/.test(folder) ? entries.filter((e) => e.hash === folder) : []
  const byName = entries.filter((e) => e.bucket === folder)
  const hits = (byHash.length > 0 ? byHash : byName).filter((e) => e.hasDb)
  const hashNote = '提示：桶名不唯一时，folder 可传 16 位工作区哈希（memo-river 状态目录名）消歧。'
  if (hits.length === 1) return { ok: true, entry: hits[0]! }
  if (hits.length > 1) {
    return {
      ok: false,
      error: [
        `【memo_recall·folder 路由失败】桶名「${folder}」不唯一：${hits.length} 个状态目录同名，拒绝静默挑一个。`,
        ...hits.map((e) => `· ${e.bucket}@${e.hash} → ${e.cwd ?? e.root}`),
        ...availableBucketLines(entries),
        hashNote,
      ].join('\n'),
    }
  }
  return {
    ok: false,
    error: [
      `【memo_recall·folder 路由失败】不存在桶「${folder}」（状态根 ${memoRiverRoot()}；解析顺序：folder 为 16 位 hex → 按工作区哈希精确匹配，否则按 workspace.json 的 bucket 字段 → dailynote/ 唯一子目录名）。`,
      ...availableBucketLines(entries),
      hashNote,
    ].join('\n'),
  }
}

/** 跨桶打开（或复用）目标桶运行时。调用方须先 resolveBucket 成功；永不建目录、永不写 manifest。
 * 注册表键与 acquireWorkspace 同一张（键=工作区哈希）：目标桶若恰好是本进程已打开的工作区，天然复用。 */
export function acquireBucketRuntime(entry: BucketEntry, config: Config): WorkspaceRuntime {
  const existing = registry.get(entry.hash)
  if (existing) return existing
  const paths = workspacePathsAtRoot(entry.root, entry.bucket, entry.cwd ?? undefined)
  const runtime = WorkspaceRuntime.openExisting(paths, config)
  registry.set(entry.hash, runtime)
  return runtime
}

/* ────────────── 桶继承（inherit-0928）：伞工作区被动注入联邦父桶记忆 ──────────────
 *
 * 配置形态：workspace.json 可选字段 `inherit: string[]`（桶名或 16 位哈希，与 folder 真路由
 * 同一套 resolveBucket 解析）。**只作用于被动注入**（初始上下文）——主动补证已有 folder
 * 真路由，不需要继承；写入永不落父桶（伞工作区的日记写自己桶，父桶只读）。
 * CLI：scripts/memo-inherit.mjs（add/remove/list）。联邦合并规则见 src/federate.ts。
 *
 * 设计约束：
 *   · 只取一层：父桶自己的 inherit 不递归跟进（防环、行为可预测）；
 *   · 父桶数上限 INHERIT_MAX_PARENTS（配置得再多也只取前 N 个，防注入块失控）；
 *   · 解析失败（桶不存在 / 无库 / 同名歧义）只记日志跳过——继承是增强，不是依赖。 */

/** 桶继承：父桶数量上限（超出部分记警告后截断）。 */
export const INHERIT_MAX_PARENTS = 4

/** 读 manifest 的 inherit 字段（缺省 / 畸形 → 空数组；只认非空字符串）。 */
export function readInheritConfig(root: string): string[] {
  const manifest = readJsonSafe<{ inherit?: unknown }>(join(root, 'workspace.json'), {})
  return Array.isArray(manifest.inherit)
    ? manifest.inherit.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : []
}

/** 打开继承链上的父桶运行时（注册表复用；解析失败记日志跳过，永不抛）。只取一层。 */
export function openInheritedBuckets(primary: WorkspaceRuntime, config: Config): WorkspaceRuntime[] {
  const names = readInheritConfig(primary.paths.root)
  const out: WorkspaceRuntime[] = []
  if (names.length === 0) return out
  if (names.length > INHERIT_MAX_PARENTS) {
    primary.logger.warn(
      `inherit-truncated bucket=${primary.paths.bucket} configured=${names.length} took=${INHERIT_MAX_PARENTS}（超出部分忽略）`,
    )
  }
  const seen = new Set<string>([primary.paths.hash])
  for (const raw of names.slice(0, INHERIT_MAX_PARENTS)) {
    const name = raw.trim()
    const res = resolveBucket(name)
    if (!res.ok) {
      primary.logger.warn(`inherit-skip bucket=${primary.paths.bucket} parent=${name}：${res.error.split('\n')[0]}`)
      continue
    }
    if (seen.has(res.entry.hash)) continue // 自继承 / 重复项
    seen.add(res.entry.hash)
    out.push(acquireBucketRuntime(res.entry, config))
  }
  return out
}

/** 读 VCP 的 KnowledgeBaseManager（体检报告里带上算法版本，便于溯源）。 */
export function algorithmVersion(vcpRoot: string): string {
  const kbm = loadKnowledgeBaseManager(vcpRoot)
  const v9 = kbm.v9
  if (v9 && typeof v9 === 'object' && typeof (v9 as Record<string, unknown>).algorithmVersion === 'string') {
    return String((v9 as Record<string, unknown>).algorithmVersion)
  }
  return 'unknown'
}
