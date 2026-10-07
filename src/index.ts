/**
 * @dsh-external/dsh-memo-river — 把 VCPToolBox 的 TagMemo / RiverMemo 记忆算法接进 DSH。
 *
 * 三通道（DESIGN.md §4）：
 *   · 请求前：`agent/pre-step` 做消息尾注入（含门控 / role / Ω / 未注入说明），
 *             `llm/stream` 按 §6.5 注册并永远 `next()` 委托（只读审计 + 降级边界）
 *   · 回合中：`memo_recall` / `memo_write` / `memo_stats` / `memo_tags`
 *             + `systemPrompt` 的**固定契约文本**（零动态 → 保前缀缓存）
 *   · 回合边界：`agent/turn-stopping` 只产候选草稿；timer 守护循环重建资产 + 四项体检
 */
import type { Context } from 'cordis'
import { Config, type Config as MemoRiverConfig } from './config.js'
import { WorkspaceDaemon } from './daemon.js'
import { healthReport } from './health.js'
import { installInjection, messageText, type AgentLike } from './injector.js'
import { FIXED_CONTRACT_SHA256, FIXED_CONTRACT_TEXT } from './prompt.js'
import { Logger, dshHome } from './runtime.js'
import { getSession, takeDrafts, dropSession, listSessions, SUBSTANTIVE_REPORT_CHARS, type PendingDraft } from './session.js'
import { applyPresetTuning, handleActiveProbe, handleTuningApi, serveTuningPanel, dropSessionTuning, tuningDefaults as tuningDefaultsOf } from './tuning.js'
import { installTools } from './tools.js'
import { acquireWorkspace, releaseWorkspace, retainWorkspace, type WorkspaceRuntime } from './workspace.js'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export const name = '@dsh-external/dsh-memo-river'
export const inject = ['llm', 'systemPrompt', 'tools', 'webServer']
export { Config }

/** systemPrompt 段的注册名（固定契约；零动态 → 逐轮 hash 相等）。 */
const CONTRACT_NAME = 'memo-river:contract'
/** 与 engram-relay 同区间，避免与既有段/上下文抢占序位。 */
const CONTRACT_ORDER = 9997

type AppContext = Context & {
  llm: unknown
  systemPrompt: {
    section(section: { name: string; order: number; text: string }): () => void
    context(context: { name: string; order: number; text: string }): () => void
  }
  tools: { register(tool: unknown): () => void }
  effect(callback: () => unknown, label?: string): () => void
  interval?(callback: () => void, delay: number): () => void
  get?(name: string): unknown
  logger?: { info?(msg: string): void; warn?(msg: string): void; error?(msg: string): void }
}

/**
 * 守护循环的定时器来源：优先 timer mixin（`ctx.interval`，fiber 作用域，随插件释放），
 * 否则退回**裸 setInterval + unref**（同样包在插件生命周期里）。
 *
 * ⚠ 实测教训（宿主进程注入时暴露的真故障）：
 * 早先这里还探测过 `ctx.get('timer')`，在真实 Cordis 上直接抛
 *   `Error: cannot get property "timer" without inject`
 * ——未 `inject` 的服务，其属性访问是**抛错**而非返回 undefined。后果是
 * `daemonFor()` 整个炸掉、守护循环永远起不来，而启动自检的 try/catch 只留下一行
 * `plugin-startup-failed`，表现为「工具能用、体检日志再也不长」的半死状态。
 * Cordis 的 `inject` 只有硬依赖（没有 optional 列表），把 timer 变成硬依赖会让本插件
 * 在没装 cordis-plugin-timer 的部署上永远不激活——用一个可选加速项换可用性，不划算。
 * 故：**只做只读探测，且探测本身也必须容错**。
 */
function pickInterval(ctx: AppContext): (fn: () => void, ms: number) => () => void {
  try {
    const fromMixin = (ctx as { interval?: unknown }).interval
    if (typeof fromMixin === 'function') {
      return (fromMixin as (fn: () => void, ms: number) => () => void).bind(ctx)
    }
  } catch {
    /* 未注入 timer：落到下面的裸 setInterval，不影响守护循环启动 */
  }
  return (fn, ms) => {
    const handle = setInterval(fn, ms)
    // 守护定时器**不得阻止进程退出**（插件是常驻背景维护，不是前台任务）。
    ;(handle as { unref?: () => void }).unref?.()
    return () => clearInterval(handle)
  }
}

/* ══════════ 进程级路由池（可重入） ══════════
 *
 * webserver 的路由表是**进程全局**的（没有 realm 概念，isolate 治不了），而本插件的
 * apply() 会在**同一个进程里被调用多次**：
 *   · 多条带记忆河流的预设行各挂一次（D55/D56：宿主层共享 vs 预设行独占）；
 *   · 常驻（standing）挂载**不随会话结束释放**（D58 源码级结论）。
 * 第二次 `ws.register` 必被 dsh-host-webserver/lib/index.js:178 拒绝：
 *   throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
 * 后果不是"少一个面板"，而是**整条组合挂载失败** → 会话 resume 每次失败 → 浏览器标签
 * 无退避重试（2026-09-14 实测事故：~80 req/s，每请求重挂整套组合，实例空闲却烧满一核，
 * 825.1 s CPU / 805 s 墙钟 = 102.5%，同 unit 基线 0.9–4.3%）。
 *
 * 故：同一进程内**同路径只登记一次**，后到者复用先到者的路由（引用计数），计数归零才
 * 真正注销。注册语义从「挂载独占」降级为「进程共享」——与面板的实际语义一致
 * （面板读的是进程内 tuning 状态 + tuning.json，不区分挂载者）。
 */
interface RouteLike {
  kind: string
  path: string
  handler: (req: never, res: never) => unknown
}
interface WebServerLike {
  register?: (route: RouteLike) => () => void
}
/**
 * ⚠ 池必须挂在**进程全局**，不能用模块作用域变量（第一版就栽在这里，2026-09-14 实测）：
 * 同一进程里本文件会被**两条 URL** 各加载一次 ——
 *   · 预设写 `./memo-river.mjs`（wrapper）→ `import('…/lib/index.js?v=<mtime>')`（带 query）
 *   · 预设写包名 `@dsh-external/dsh-memo-river` → `file:///…/lib/index.js`（无 query）
 * Node 的 ESM 缓存按 **URL** 键 ⇒ 两个模块实例、两份模块级 Map ⇒ 谁也看不见对方，
 * 第二次挂载照样撞上 webserver 的进程级路由表（实测：修复版已构建，同一请求仍报
 * `duplicate exact route "/memo-river/tuning"`）。`Symbol.for` 是跨模块实例的同一张表。
 */
type RoutePool = Map<string, { refs: number; dispose: () => void }>
type PoolMap = WeakMap<object, RoutePool>
const POOL_KEY = Symbol.for('@dsh-external/dsh-memo-river/routePools')
const globalRegistry = globalThis as unknown as Record<symbol, PoolMap | undefined>
const routePools: PoolMap = globalRegistry[POOL_KEY] ?? (globalRegistry[POOL_KEY] = new WeakMap())

/** 路由池按 **webserver 实例**分池：路由表属于某个 webserver，跨实例复用是错的
 *  （webserver 服务被重建时，新实例的路由表是空的，旧池不得拦着它登记）。 */
function poolFor(ws: WebServerLike): Map<string, { refs: number; dispose: () => void }> {
  let pool = routePools.get(ws as object)
  if (pool === undefined) {
    pool = new Map()
    routePools.set(ws as object, pool)
  }
  return pool
}

function releaseSharedRoute(ws: WebServerLike, path: string): void {
  const pool = routePools.get(ws as object)
  const held = pool?.get(path)
  if (pool === undefined || held === undefined) return
  held.refs -= 1
  if (held.refs > 0) return
  pool.delete(path)
  try {
    held.dispose()
  } catch {
    /* 注销失败不阻塞卸载 */
  }
}

/** 登记一条进程级路由：同一 webserver 上已有同路径则复用，不再触达重复检查。
 *
 *  `onTolerated`（可选）：当注册被 webserver 以「重复路由」拒绝、且**重复的正是本路由**
 *  时不再抛出，而是容忍（回调仅用于留痕）。为什么容忍是对的 —— 见下方 trap 说明：
 *  `/memo-river/*` 是本插件独占的命名空间，"已登记"与本插件想要的结果完全一致，
 *  唯一不能做的是**替别人注销**（那条路由不是我们登记的，返回 no-op 清理函数）。
 */
function registerSharedRoute(ws: WebServerLike, route: RouteLike, onTolerated?: (path: string, message: string) => void): () => void {
  const pool = poolFor(ws)
  const held = pool.get(route.path)
  if (held !== undefined) {
    held.refs += 1
    return () => releaseSharedRoute(ws, route.path)
  }
  let dispose: () => void
  try {
    dispose = (ws.register as (r: RouteLike) => () => void)(route)
  } catch (e) {
    const message = String((e as { message?: unknown })?.message ?? e)
    /* ⚠ TRAP（2026-09-14 实测两次才收敛）：
     * 池看不见对方的三种情形都真实存在 —— 模块被两条 URL 加载成两个实例（wrapper 带
     * `?v=` vs 包名裸 URL）；插件活在不同的 realm/context（各自的 globalThis）；宿主
     * 层已经把同一条路由登记过。判据只有一条：**路由表是进程全局的，池不是**。 */
    if (!message.includes('duplicate') || !message.includes(`"${route.path}"`)) throw e
    onTolerated?.(route.path, message)
    return () => {
      /* 不是我登记的，注销权不归我 */
    }
  }
  pool.set(route.path, { refs: 1, dispose })
  return () => releaseSharedRoute(ws, route.path)
}

export function apply(ctx: AppContext, config: MemoRiverConfig): void {
  /* 插件级兜底日志（拿不到工作区时用；工作区日志在 WorkspaceRuntime 内，按 cwd 分桶） */
  const pluginLogPath = config.logFile || join(dshHome(), 'memo-river', 'plugin.log')
  const pluginLogger = new Logger(pluginLogPath, (level, message) => {
    if (level === 'error') ctx.logger?.error?.(`[memo-river] ${message}`)
    else if (level === 'warn') ctx.logger?.warn?.(`[memo-river] ${message}`)
    else ctx.logger?.info?.(`[memo-river] ${message}`)
  })
  const log = (level: 'info' | 'warn' | 'error', message: string): void => pluginLogger[level](message)

  const getWorkspace = (cwd: string): WorkspaceRuntime => acquireWorkspace(cwd, config)

  /* ── 调参面板（§6.6）：tuning.json 预设级覆盖重放进活 config（进程级即时生效） ── */
  applyPresetTuning(config)
  let tuningDefaults: Record<string, number> = {}
  try {
    tuningDefaults = tuningDefaultsOf()
  } catch {
    /* 默认值解析失败 → 面板显示 0；不阻塞主流程 */
  }
  const ws = (ctx as unknown as { webServer?: WebServerLike }).webServer
  /** 路由被别处（另一模块实例 / 另一 realm / 宿主层）登记过 → 容忍并留痕，不静默。 */
  const tolerate = (path: string, message: string): void =>
    log('warn', `route-already-registered path=${path} tolerated=1（本插件的命名空间，复用既有登记）detail=${message}`)
  if (ws && typeof ws.register === 'function') {
    const d1 = registerSharedRoute(ws, {
      kind: 'exact',
      path: '/memo-river/tuning',
      handler: (req: never, res: never) => handleTuningApi(req, res, config, tuningDefaults, listSessions),
    }, tolerate)
    const d2 = registerSharedRoute(ws, { kind: 'exact', path: '/memo-river/tuning/panel', handler: (_req: never, res: never) => serveTuningPanel(res) }, tolerate)
    // GUI 卫星包（dsh-memo-tuner）显隐探针：当前会话是否挂载 memo-river
    const d3 = registerSharedRoute(ws, { kind: 'exact', path: '/memo-river/tuning/active', handler: (req: never, res: never) => handleActiveProbe(req, res, listSessions) }, tolerate)
    // 注意：ctx.effect 把「返回值」当清理函数——必须返回一个函数，
    // 而不是当场调用 d1/d2（首版就在这里把路由注册完立刻拆了，症状 404）。
    ctx.effect(() => () => {
      d1()
      d2()
      d3()
    })
    log('info', 'tuning-panel routes=/memo-river/tuning[,/panel,/active]')
  }

  try {
    mkdirSync(join(dshHome(), 'memo-river'), { recursive: true })
  } catch {
    /* 建目录失败静默，后续写盘各自兜底 */
  }

  /* ────────── ① 主干的另一半：systemPrompt 固定契约（零动态 / byte 级一致） ────────── */

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    if (config.promptChannel === 'section' || config.promptChannel === 'both') {
      disposers.push(ctx.systemPrompt.section({ name: CONTRACT_NAME, order: CONTRACT_ORDER, text: FIXED_CONTRACT_TEXT }))
    }
    if (config.promptChannel === 'context' || config.promptChannel === 'both') {
      disposers.push(ctx.systemPrompt.context({ name: CONTRACT_NAME, order: CONTRACT_ORDER, text: FIXED_CONTRACT_TEXT }))
    }
    log(
      'info',
      `contract-registered channel=${config.promptChannel} sha256=${FIXED_CONTRACT_SHA256} bytes=${Buffer.byteLength(FIXED_CONTRACT_TEXT, 'utf8')}`,
    )
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* 静默 */
        }
      }
    }
  }, 'memo-river: fixed contract')

  /* ────────── ② 注入 seam：agent/pre-step（尾注入）+ llm/stream（委托 + 审计） ────────── */

  installInjection(ctx as unknown as Parameters<typeof installInjection>[0], { config, getWorkspace, log })

  /* ────────── ③ 工具面 ────────── */

  ctx.effect(() => {
    installTools(ctx as unknown as Parameters<typeof installTools>[0], { config, getWorkspace, log })
    return () => {
      /* ctx.tools.register 的 disposer 由 cordis 随 fiber 释放 */
    }
  }, 'memo-river: tools')

  /* ────────── ④ 守护循环 + 草稿收集 ────────── */

  const daemons = new Map<string, WorkspaceDaemon>()

  /**
   * 守护定时器必须随 fiber 收口。
   *
   * 实测事故：本插件的预设每次换 `?v=N` 都会新挂一代 standing 实例，而旧代的
   * `setInterval` 从未被清 —— 同一工作区于是有多个守护循环并发跑。可见症状是
   * `health.log` 每轮被写两遍（genshin 工作区 03:48/04:03/04:18 三轮各两行，
   * 两行毫秒差 1ms，对应用户启动会话时并存的两个实例），更严重的是每个实例都
   * 监听 `agent/pre-step` —— 注入块会被追加两次，每个实例还各持一份 native 索引
   * 在同一张库上做重建。
   *
   * §1 不变量 6「静默即不可接受」：泄漏的循环是**重复且难察觉**的写，必须收口。
   */
  ctx.effect(
    () => () => {
      for (const daemon of daemons.values()) {
        try {
          daemon.stop()
        } catch {
          /* 单个收口失败不阻塞其余资源释放 */
        }
      }
      daemons.clear()
      /* BUG-1003 票14：守护收口时归还本挂载代持有的工作区引用；
       * refs 归零后 30s 宽限关闭（瞬态尾巴收完、新挂载可撤销）。 */
      for (const key of heldWorkspaceKeys) {
        try {
          releaseWorkspace(key)
        } catch {
          /* 同上：静默 */
        }
      }
      heldWorkspaceKeys.clear()
    },
    'memo-river: guardian timers',
  )

  /* 票14：本挂载代 retain 过的桶键（收口时逐个 release，与 daemons Map 同生命周期）。 */
  const heldWorkspaceKeys = new Set<string>()

  const daemonFor = (workspace: WorkspaceRuntime): WorkspaceDaemon => {
    const key = workspace.paths.hash
    const existing = daemons.get(key)
    if (existing) return existing
    retainWorkspace(key)
    heldWorkspaceKeys.add(key)
    const daemon = new WorkspaceDaemon({
      config,
      workspace,
      log,
      setInterval: pickInterval(ctx),
      takeDrafts: () =>
        takeDrafts((state) => {
          if (!state.cwd) return false
          try {
            return acquireWorkspace(state.cwd, config).paths.hash === key
          } catch {
            return false
          }
        }),
    })
    daemons.set(key, daemon)
    try {
      daemon.start()
    } catch (e) {
      // 定时器起不来不等于插件不可用（注入/工具仍然生效）——但要**单独**报出来，
      // 否则会伪装成 plugin-startup-failed，让「体检日志不再增长」失去线索（§1 不变量 6）。
      log('error', `guardian-start-failed bucket=${workspace.paths.bucket}: ${String((e as Error)?.message ?? e)}`)
    }
    return daemon
  }

  /**
   * 生命周期握手：0.1.5 及以前发 `agent/session-start`；0.1.6 起该事件被删除，由异步串行的
   * `agent/created` 取代（payload 逐字段相同，只多一个可选 signal）。
   *
   * **两个名字都挂，而不是二选一**：事件名对不上时 `ctx.on` 照样注册成功、回调永不触发、
   * 日志零行——这是最难发现的一类故障（插件看起来活着，记忆注入却静默停止）。
   * 日志里的 `event=` 是实际命中的那个名字，升级后可直接当握手判据。
   *
   * 同一 agent 实例只处理一次（WeakSet，不阻止会话恢复后新实例再次进来）；
   * 处理器全程 try/catch：`agent/created` 是 @mode serial 且被 await，抛错会让 Agent 创建失败。
   */
  const seenAgents = new WeakSet<object>()
  const onAgentReady = (event: string, payload: { agent: AgentLike }): void => {
    try {
      const agent = payload.agent
      if (typeof agent === 'object' && agent !== null) {
        if (seenAgents.has(agent)) return
        seenAgents.add(agent)
      }
      const cwd = agent?.session?.header?.cwd ?? process.cwd()
      const state = getSession(agent.session.id, cwd)
      const workspace = getWorkspace(cwd)
      daemonFor(workspace)
      log(
        'info',
        `session-start event=${event} id=${state.sessionId} cwd=${cwd} bucket=${workspace.paths.bucket} counts=${JSON.stringify(workspace.corpusCounts)}`,
      )
    } catch (e) {
      log('warn', `session-start-failed event=${event}: ${String((e as Error)?.message ?? e)}`)
    }
  }

  /* 0.1.7-rc.2：'agent/session-start' 已并入 'agent/created'（payload.source 区分
   * fresh/resume/clear/compaction），旧事件名从类型里移除——两处监听合一，
   * seenAgents 去重语义不变。 */
  ctx.on('agent/created', (payload) => {
    onAgentReady('agent/created', payload)
    return undefined
  })

  /**
   * 回合边界：**只产出候选草稿，不落库**（DESIGN §4 回合边界 / §8.3）。
   * 落盘由守护循环负责（`pending/<date>-<slug>.md`，等确认，不自动入库）。
   */
  ctx.on('agent/turn-stopping', (payload: { agent: AgentLike; turn: number }) => {
    try {
      if (!config.maintenance.drafts) return
      const agent = payload.agent
      const state = getSession(agent.session.id, agent.session?.header?.cwd ?? null)
      /* 票02：本回合已经 memo_write 过就不再收草稿——收出来的那份必然与刚落盘的日记同题，
       * 批准出去就是复读（D10 样本二：13 分钟内三连同题）。时钟由写工具侧回填
       * （injector pre-step 观测 memo_write 工具调用 → lastDiaryWriteTurn），不靠模型自觉。 */
      if (state.lastDiaryWriteTurn === payload.turn) {
        log('info', `draft-skip reason=wrote-this-turn turn=${payload.turn} session=${state.sessionId}`)
        return
      }
      const messages = agent.session.deriveMessages() ?? []
      // 从后往前找**最后一条有正文的**该角色消息：
      //  · 工具结果也走 user 角色（正文为空）——停在它上面会产出「本轮用户：(空)」的草稿
      //    （实测 genshin 桶 17 个草稿里多个名为 turn-tN.md 的就是这种）；
      //  · 本插件的被动召回块（⟨memo-river·…⟩）同样是 user 角色且带正文——必须跳过，
      //    否则「本轮用户」会录成召回块自己。
      const textOf = (role: string): string => {
        let sawEmpty = false
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i] as { role?: string }
          if (m.role !== role) {
            // 已见过本角色空正文、又越过对面角色（如 user 扫描遇到 assistant）
            // → 本轮该角色确实没写文本（如纯图片消息），返回空，防止越界取上一轮旧文本
            if (sawEmpty) return ''
            continue
          }
          const t = messageText(m).trim()
          if (!t) {
            sawEmpty = true
            continue
          }
          if (t.startsWith('⟨memo-river')) continue
          return t
        }
        return ''
      }
      const firstNonEmptyLine = (text: string): string => {
        for (const line of text.split('\n')) {
          const t = line.trim()
          if (t) return t
        }
        return ''
      }
      /* 票02：召回命中只作**展示**（recalledTags），不再当建议 Tag —— 那条路是自我强化环：
       * 召回枢纽词 → 草稿建议枢纽词 → 一键批写回枢纽词 → 枢纽更强。内容判定在
       * drafts.ts 的 curateTags（预审与批准共用），此处恒置空。 */
      const recalled = new Set<string>()
      for (const candidate of state.lastCandidates) {
        for (const tag of candidate.matchedTags) recalled.add(tag)
      }
      const draft: PendingDraft = {
        turn: payload.turn,
        userText: textOf('user'),
        assistantText: textOf('assistant'),
        suggestedTags: [],
        recalledTags: [...recalled].slice(0, 8),
        relatedIds: state.lastCandidates.slice(0, 3).map((c) => c.id),
        at: Date.now(),
      }
      state.pendingDraft = draft
      // 写入节律提醒的弹药：回合进展摘要（不被消费，保留到被下回合覆盖）
      state.lastDraftSummary = {
        turn: payload.turn,
        at: draft.at,
        /* 票02：nudge 的冷门 Tag 建议仍吃召回命中做种子（`coldTagSuggest` 内部剔枢纽、
         * 只补词汇表内的非枢纽词）——换掉它等于顺手动掉票03/票11 的 nudge 文案输入，
         * 那是别的票的地盘；草稿的「建议 Tag」与它无关（已置空 + 内容化）。 */
        suggestedTags: draft.recalledTags.slice(0, 5),
        digest: firstNonEmptyLine(draft.assistantText || draft.userText).slice(0, 80),
        // 小轮判别：回合以实质汇报收尾（≥ SUBSTANTIVE_REPORT_CHARS 字）才计入汇报轮锚。
        substantive: (draft.assistantText ?? '').length >= SUBSTANTIVE_REPORT_CHARS,
      }
      log('info', `draft-collected session=${state.sessionId} turn=${payload.turn} recalled=${draft.recalledTags.join(',') || '-'}`)
    } catch (e) {
      log('warn', `draft-collect-failed: ${String((e as Error)?.message ?? e)}`)
    }
  })

  ctx.on('agent/disposed', (payload: { agent: AgentLike }) => {
    try {
      const id = payload.agent?.session?.id
      if (!id) return
      const state = getSession(id, null)
      state.pendingDraft = null
      dropSession(id)
      dropSessionTuning(id)
      log('info', `session-disposed id=${id}`)
    } catch {
      /* 静默 */
    }
  })

  /* ────────── ⑤ 启动自检（静默即不可接受：§1 不变量 6） ────────── */

  try {
    const workspace = getWorkspace(process.cwd())
    const report = healthReport(workspace.store, workspace.paths.bucket)
    log(
      'info',
      `plugin-ready workspace=${workspace.paths.cwd} bucket=${workspace.paths.bucket} db=${workspace.paths.dbPath} ` +
        `embedUrl=${workspace.resolved.apiUrl ? 'set' : 'MISSING'} embedKey=${workspace.resolved.apiKey ? 'set' : 'MISSING'} ` +
        `embedSource=${workspace.resolved.source} dim=${workspace.resolved.dimension} ` +
        `corpus=${JSON.stringify(report.counts)} components=${report.components} warnings=${report.warnings.length}`,
    )
    daemonFor(workspace)
  } catch (e) {
    log('error', `plugin-startup-failed: ${String((e as Error)?.stack ?? e)}`)
  }
}

/** 供验收脚本读取：固定契约文本与其 hash（不经过任何运行时拼接）。 */
export { FIXED_CONTRACT_TEXT, FIXED_CONTRACT_SHA256, messageText }
