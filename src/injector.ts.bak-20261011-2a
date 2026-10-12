/**
 * src/injector.ts — 注入主干：消息尾注入 + system 固定契约 + llm/stream 委托观测。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 关于 DESIGN.md §6.5「`ctx.on('llm/stream', …)` 只在 next() 之前追加消息」：
 *
 * 在本 DSH 上，`llm/stream` 收到的 `options` 是**深冻结**的：
 *   dsh-agent-loop/lib/index.js:1203-1212
 *     deepFreeze(header); … deepFreeze(message); Object.freeze(boundaryMessages);
 *     return markAgentLoopRequest(Object.freeze({ …header.config, messages: boundaryMessages, … }))
 *   dsh-llm/lib/types/types.d.ts:411-421
 *     「A LOOP-built request … carries the system prompt …」——该对象是会话日志的纯函数。
 *   dsh-llm/lib/index.js:2307
 *     `this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))`
 *     ——waterfall 的 `next()` 不接受参数，终点闭包捕获的仍是那份冻结的 options。
 * 因此「在 llm/stream 里追加消息」在物理上不可能：push 抛异常，替换 options 无效。
 *
 * 落在**同一语义位置**（模型请求消息数组的尾部、assistant 回答之前）的唯一合规 seam 是
 * `agent/pre-step` 的 `{kind:'enter', messages}`——它返回的批次会被记入会话日志，
 * 从而成为 `deriveMessages()` 的末尾，也就是本轮模型请求的末尾。
 *   官方同类实现：dsh-tmux-context/lib/index.js:1510（prepend）、
 *   dsh-agent-instructions/lib/index.js:1270（spliced 到已 claim 批次之后）。
 *
 * 所以本插件**两处都注册**，各司其职：
 *   · `agent/pre-step` —— 真正决定“追加什么”，把注入块放到请求尾部（§6.2 的载体）。
 *   · `llm/stream`     —— **按 §6.5 必须注册的拦截点**：永远 `return next()` 委托，
 *                        在冻结请求上做只读审计（验收 #1/#2 的实测取证），
 *                        并作为“失败降级为不注入 + 记日志”的边界。
 * 二者都满足设计意图，且都不改写既有消息。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.js'
import { recordOmega, recordUsage } from './health.js'
import { BLOCK_CLOSE, continuationTail, DelegationExtras, renderInjection, renderSkipNotice, renderWriteNudge } from './render.js'
import { coldTagSuggest, sameAxisHit, scanTagAxis } from './nudge-guide.js'
import { buildQueryField, type RecallOptions } from './recall.js'
import { federatedRecall } from './federate.js'
import { tuningValues } from './tuning.js'
import { getSession, peekSession, type SessionState } from './session.js'
import { workspacePaths, type Logger } from './runtime.js'
import { pendingQueueStats, type PendingQueueStats } from './drafts.js'
import { openInheritedBuckets, type WorkspaceRuntime } from './workspace.js'

/** 内容块 → 文本（只取带 text 的块；其它块类型忽略）。 */
export function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join('\n')
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 最小结构类型：只声明本插件真正读取的字段（不复制 DSH 内部对象）。 */
export interface AgentLike {
  session: {
    id: string
    /** delegationDepth：DSH SessionFormatHeader 固有字段（dsh-subagent 派子代理时 +1 盖章持久化）；顶层缺省。 */
    header?: { cwd?: string; delegationDepth?: number }
    deriveMessages(): unknown[]
  }
}

export interface PreStepPayload {
  agent: AgentLike
  messages: unknown[]
  turn: number
  step: number
  signal?: { aborted?: boolean }
}

export type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[]; startsRequestSeries?: true }

export interface LlmStreamOptionsLike {
  messages: unknown[]
  sessionId?: string
}

export interface InjectorDeps {
  config: Config
  /** 按 cwd 取工作区运行期（工作区级共享，非会话级）。 */
  getWorkspace(cwd: string): WorkspaceRuntime
  /** 插件级日志（拿不到工作区时的兜底）。 */
  log(level: 'info' | 'warn' | 'error', message: string): void
}

/** 组装工作区的召回选项。 */
function recallOptions(config: Config, queryId: string, gateText = '', gateAssistantText = ''): RecallOptions {
  return {
    mode: config.inject.mode,
    k: config.inject.k,
    tokenBudget: config.inject.tokenBudget,
    dynamicK: config.inject.dynamicK,
    // 票 03：自适应 K——膨胀桶条数上限随候选池扩展（ratio=0 可回滚到固定 k）；预算截断不受影响
    adaptiveKRatio: config.inject.adaptiveKRatio,
    adaptiveKMax: config.inject.adaptiveKMax,
    // 票 04：选择循环有界权重（曝光抑制 + 同 Tag 去重 + 近因）——只走被动注入路径，
    // 主动 memo_recall 不接（显式 k 语义不变）；台账在读出侧共读一次（见 recall.ts §④.5）
    selectionWeights: {
      tagCap: config.inject.selectionTagCap,
      exposureCap: config.inject.selectionExposureCap,
      exposureHalfLifeHours: config.inject.selectionExposureHalfLifeHours,
      recencyCap: config.inject.selectionRecencyCap,
      recencyWindowHours: config.inject.selectionRecencyWindowHours,
    },
    recencyFloorDays: config.inject.recencyFloorDays,
    gate: config.inject.gate,
    gateThreshold: config.inject.gateThreshold,
    minKnnForReward: config.inject.minKnnForReward,
    queryId,
    gateText,
    gateAssistantText,
    // 票 01：注入路径嵌入短超时（只罩被动注入的合批 embed；写侧/主动 recall 不传 → 宽松默认）
    embedTimeoutMs: config.inject.embedTimeoutMs,
  }
}
/** 解析会话的 cwd：header.cwd 优先，其次用已记住的，最后退回进程 cwd。 */
export function resolveCwd(agent: AgentLike, state: SessionState | null | undefined): string {
  const fromHeader = agent.session?.header?.cwd
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader
  if (state?.cwd) return state.cwd
  return process.cwd()
}

/**
 * 只收“真正的对话回合”，排除插件上下文与工具输出。
 *
 * 必须排除的两类（都是 user 角色，但都不是“用户说了什么”）：
 *   · `kind==='plugin'` —— 本插件自己的注入块（`createInjectionMessage`）、engram-relay 的上下文、
 *     DSH 每轮重注的 “Current runtime context” 快照。注入块会被 `step()` 写进会话日志
 *     （dsh-agent-loop/lib/index.js:1028），所以下一轮 `deriveMessages()` 里必然带着它；
 *     不排除的话查询场会自我强化——用上一轮的召回结果去召回下一轮。
 *   · `kind==='tool'` —— 工具输出，体量大且非用户意图。
 * 其余（'user' / 'model' / 未知 kind）一律保留：宁可多收，不可再次静默清空查询场。
 */
function isDialogMessage(m: unknown): boolean {
  const msg = m as { role?: string; source?: { kind?: string } }
  if (msg.role !== 'user' && msg.role !== 'assistant') return false
  const kind = msg.source?.kind
  return kind !== 'plugin' && kind !== 'tool'
}

/**
 * `claimed` 批次的过滤器 —— **只按角色，不看 source**。
 *
 * 对比 `isDialogMessage`：那个用来筛**历史**（必须排除自己的注入块与插件快照），
 * 这个用来筛**本步输入**。`payload.messages` 按 DSH 契约就是 `UserMessage[]`
 * （`preStep()` 里 `const claimed = this.inbox.claim(...)`），它**就是**这一步的内容。
 * 在这里再套一层 source 判断是危险的：一旦某条真实用户消息的 source.kind 不是 'user'
 * （命令、其它插件、未来的新来源），查询场会再次静默变空——正是刚在真实会话里踩过的坑。
 */
function isClaimedMessage(m: unknown): boolean {
  const role = (m as { role?: string }).role
  return role === 'user' || role === 'assistant'
}

/**
 * 取消息流里最近一次 ACP 压缩的 compactionId（无则 null）。
 * 压缩消息 = user 角色、source.kind='plugin'、plugin='compact'、带 compactionId。
 * 新 id 出现 = 刚发生过压缩 → 旧注入块可能已被折进摘要，正是记忆最脆弱的时刻。
 */
function latestCompactionId(msgs: unknown[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const src = (msgs[i] as { source?: { plugin?: string; compactionId?: string } })?.source
    if (src?.plugin === 'compact' && typeof src.compactionId === 'string' && src.compactionId) return src.compactionId
  }
  return null
}

/**
 * 产出一段尾注入文本；返回 `null` 表示**不注入**（门控不过 / 无候选 / 失败降级）。
 * 本函数永不抛——调用方（pre-step）另有 try/catch 兜底。
 *
 * `claimed` 必须传 `agent/pre-step` 载荷里的 `payload.messages`——见下方时序铁律。
 */
export async function buildTailInjection(
  deps: InjectorDeps,
  agent: AgentLike,
  turn: number,
  step: number,
  claimed: unknown[] = [],
): Promise<string | null> {
  const sessionId = agent.session?.id
  if (!sessionId) return null
  const state = getSession(sessionId, agent.session?.header?.cwd ?? null)
  const cwd = resolveCwd(agent, state)
  const workspace = deps.getWorkspace(cwd)
  const logger: Logger = workspace.logger

  // 同一 (turn, step) 只做一次（并发会话各自独立，互不串扰）
  if (turn < state.lastTurn || (turn === state.lastTurn && step <= state.lastStep)) return null

  // ★ pre-step 时序铁律（试运行实测踩坑）：本轮 claimed 消息是在 `preStep()` **返回之后**
  //   才由 `step()` 写进会话日志的（dsh-agent-loop/lib/index.js:1028
  //   `if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", message, ...)`）。
  //   所以 pre-step 瀑布期间 `deriveMessages()` 只有**历史**，不含当前这条：
  //     · 首轮 → 历史为空 → 查询场为空 → 永远 empty-query-field，一次都不注入；
  //     · 后续轮 → 门控跑在上一轮的话上，当前这句被整个忽略。
  //   正确取法 = 历史（deriveMessages）+ 本轮 claimed（payload.messages），两者不重叠。
  let history: unknown[] = []
  let rawHistory: unknown[] = []
  try {
    rawHistory = agent.session.deriveMessages() ?? []
    history = rawHistory.filter(isDialogMessage)
  } catch (e) {
    logger.warn(`derive-messages-failed: ${String((e as Error)?.message ?? e)}`)
    return null
  }
  const claimedMsgs = (claimed ?? []).filter(isClaimedMessage)

  /* ── 注入时机策略（docs/PLAN-2026-09-13-自主态记忆优化.md 第一刀）：
   *    回合首发（step=1 或 claimed 带新用户输入）/ 自主态节律（每 N 步）/ 压缩事件（立即+绕过去重）。 */
  const every = deps.config.inject.autonomousInjectEverySteps
  const hasFreshUserInput = (claimed ?? []).some(
    (m) => (m as { role?: string }).role === 'user' && (m as { source?: { kind?: string } }).source?.kind !== 'tool',
  )
  const isTurnStart = step === 1 || hasFreshUserInput
  /* 票06（recall-quality-0916）：写侧会话形态信号——把本步 injectMode 持久化到
   * SessionState，写工具（memo_write/update/approve）execute 时可读，做 hub 闸门
   * 场景化（autonomous 会话写已枢纽化 Tag 升级处理）。放在时序闸（:191 同步去重）
   * 之后、节流闸（:223 无事早退）之前：无论本步是否真注入，形态都要最新。 */
  state.lastInjectMode = isTurnStart ? 'interactive' : 'autonomous'
  const compactionId = latestCompactionId([...rawHistory, ...(claimed ?? [])])
  const compactionFired = compactionId !== null && compactionId !== state.lastCompactionId
  if (compactionId !== null) state.lastCompactionId = compactionId
  const cadenceDue =
    every > 0 && !isTurnStart && (state.lastAutoTurn !== turn || step - state.lastAutoStep >= every)
  if (!isTurnStart && !cadenceDue && !compactionFired) return null
  if (!isTurnStart) state.autoAttemptsSinceInject += 1
  state.lastAutoTurn = turn
  state.lastAutoStep = step
  state.lastTurn = turn
  state.lastStep = step

  const msgs = [...history, ...claimedMsgs]
  // 票07：压缩事件触发时，查询锚取压缩消息之后的首段真实内容——压缩摘要概括整轮旧主题，
  // 相似度会被摊平、把选材钉在旧热点上（2026-09-14 生产实锤：压缩联动注入了昨日 GUI 族
  // 日记，漏掉 3 分钟前刚写的最相关篇）。压缩后无内容则退回全窗口。
  let queryMsgs = msgs
  if (compactionFired) {
    let ci = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      const src = (msgs[i] as { source?: { plugin?: string } })?.source
      if (src?.plugin === 'compact') {
        ci = i
        break
      }
    }
    if (ci >= 0 && ci + 1 < msgs.length) queryMsgs = msgs.slice(ci + 1)
  }
  const recent = queryMsgs.map(messageText)

  /** 门控专用（与检索窗口解耦）：优先本轮 claimed 里最后一条 user，其次回落到历史。 */
  let currentUserText = ''
  for (const pool of [claimedMsgs, history]) {
    for (let i = pool.length - 1; i >= 0; i--) {
      if ((pool[i] as { role?: string }).role === 'user') {
        currentUserText = messageText(pool[i]).trim()
        break
      }
    }
    if (currentUserText) break
  }

  /** 票⑧ 助手锚：最近一条 >150 字助手消息的前 1200 字（校准口径 = probe-gate-calibration.mjs 的 gA）。 */
  let gateAssistantText = ''
  if (deps.config.inject.gateAssistantAnchor) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if ((msgs[i] as { role?: string }).role !== 'assistant') continue
      const t = messageText(msgs[i]).trim()
      if (t.length > 150) {
        gateAssistantText = t.slice(0, 1200)
        break
      }
    }
  }

  const queryField = buildQueryField(recent, deps.config.inject.queryLookback)
  if (!queryField) {
    state.skippedCount += 1
    state.lastFallbackReason = 'empty-query-field'
    // 带够诊断：这类“静默不注入”必须一次就能定位（§1 不变量 6）。
    logger.info(
      `${renderSkipNotice({ fallbackReason: 'empty-query-field' } as never, workspace.paths.bucket)} ` +
        `turn=${turn} step=${step} history=${history.length} claimed=${claimedMsgs.length} session=${sessionId}`,
    )
    return null
  }

  /* 桶继承（inherit-0928）：主桶照常全管线，父桶同一份 options 各自过自己门控后轮转补位。
   * 解析失败/无配置 → parents 为空，行为与单桶逐字一致。 */
  const inheritParents = openInheritedBuckets(workspace, deps.config)
  const fed = await federatedRecall(
    workspace,
    inheritParents,
    queryField,
    recallOptions(
      deps.config,
      `${sessionId}#${turn}.${step}`,
      deps.config.inject.gateOnCurrentMessage ? currentUserText : '',
      gateAssistantText,
    ),
  )
  const outcome = fed.outcome

  // §7.3 ③④：把 Ω 与召回足迹记进 kv_store（体检素材），无论是否注入——继承链上每桶各自记账。
  // SIGBUS 防护：recall 的闸已随其返回释放，这里裸写 store 可能撞上守护轮的原生重建，
  // 故每桶各持自己的工作区串行闸（fed.parts 可能跨桶）。
  try {
    for (const part of fed.parts) {
      await part.workspace.withDb(async () => {
        recordOmega(part.workspace.store, part.outcome.omega, part.outcome.regime ?? '')
        if (part.injectedFileIds.length > 0) {
          recordUsage(part.workspace.store, part.injectedFileIds, 'passive')
        }
      })
    }
  } catch (e) {
    logger.warn(`record-health-failed: ${String((e as Error)?.message ?? e)}`)
  }

  const text = renderInjection(outcome, workspace.paths.bucket)
  if (!text) {
    // 门控不过 / 无候选 → 清空不注入，带 fallbackReason（§6.3），只记日志不进模型请求。
    state.lastFallbackReason = outcome.fallbackReason
    state.skippedCount += 1
    logger.info(`${renderSkipNotice(outcome, workspace.paths.bucket)} session=${sessionId}`)
    return null
  }

  // 入选集合去重：同一组日记连续注入没有新信息，只是把同样的 700+ 字再堆一份。
  // 实测：`ids=D1,D2,D4` 在 40 分钟里连注 6 次（12:45→13:24），文本各不相同 ——
  // 只差 Ω 的小数位。**所以去重的键必须是入选集合，不是块文本**（按文本去重一次都
  // 省不下来）。
  // 但跳过有个前提：旧块还在上下文里。注入块会随会话日志一直留着，可**压缩会把它
  // 折进摘要** —— 那时再跳过就等于静默丢记忆（§1 不变量 6）。故加 dedupeRefreshTurns：
  // 即使集合没变，隔了这么多回合也强制重注一次。
  // 桶继承：键必须带桶名命名空间——各桶 id 独立自增，D1@本桶与 D1@父桶是两篇日记。
  const selectionKey = outcome.selected
    .map((c) => (c.srcBucket ? `${c.srcBucket}:${c.id}` : String(c.id)))
    .sort()
    .join(',')
  const refreshDue =
    compactionFired ||
    (deps.config.inject.dedupeRefreshTurns > 0 &&
      (turn - state.lastInjectTurn >= deps.config.inject.dedupeRefreshTurns ||
        (!isTurnStart && state.autoAttemptsSinceInject >= deps.config.inject.dedupeRefreshTurns)))
  if (
    deps.config.inject.dedupeSelection &&
    selectionKey &&
    selectionKey === state.lastSelectionKey &&
    !refreshDue
  ) {
    state.skippedCount += 1
    state.lastFallbackReason = 'identical-selection'
    logger.info(
      `inject-skip bucket=${workspace.paths.bucket} reason=identical-selection ` +
        `ids=${outcome.selected.map((c) => (c.srcBucket ? `D${c.id}@${c.srcBucket}` : `D${c.id}`)).join(',')} chars=${text.length} ` +
        `sinceLastInject=${turn - state.lastInjectTurn} turns injectMode=${isTurnStart ? 'interactive' : 'autonomous'} session=${sessionId}`,
    )
    return null
  }

  state.lastInjectionText = text
  state.lastSelectionKey = selectionKey
  state.lastInjectTurn = turn
  state.autoAttemptsSinceInject = 0
  state.lastFallbackReason = null
  state.lastCandidates = outcome.candidates
  state.injectedCount += 1
  state.audits.push({
    turn,
    step,
    blockHash: sha256(text),
    chars: text.length,
    tailIndex: null,
    totalMessages: null,
    assistantAfter: null,
    at: Date.now(),
  })
  logger.info(
    `inject bucket=${workspace.paths.bucket} ids=${outcome.selected.map((c) => (c.srcBucket ? `D${c.id}@${c.srcBucket}` : `D${c.id}`)).join(',')} ` +
      `omega=${outcome.omega === null ? 'n/a' : outcome.omega.toFixed(3)} regime=${outcome.regime ?? '-'} ` +
      `mode=${outcome.mode} chars=${text.length} candidates=${outcome.candidateCount} dropped=${outcome.dropped.length} ` +
      `inherited=${outcome.selected.filter((c) => c.srcBucket).length} ` +
      `injectMode=${isTurnStart ? 'interactive' : 'autonomous'}${compactionFired ? ' trigger=compaction' : ''} ` +
      `session=${sessionId} gate={passed:${outcome.gate.passed},maxKnn:${outcome.gate.maxKnn.toFixed(4)},` +
      `threshold:${outcome.gate.threshold},gateVector:${outcome.gate.gateVector},retrievalMaxKnn:${outcome.gate.retrievalMaxKnn.toFixed(4)}} ` +
      `elapsedMs=${outcome.elapsedMs}`,
  )
  return text
}

/**
 * 注入消息的 `source`。`kind` 必须是**产出方自有的非空字符串**：0.1.7 明确拒绝通用包装
 * `kind: 'plugin'`（dsh-session-format-v3-to-v4/src/message-sources.ts:10 的
 * `assertV4SourceRowAdmission`——老会话走 `rewritePluginSource` 会被改写成 `plugin:<name>`，
 * 新会话则直接抛 `format v4 message requires a producer-owned source kind`）。
 * 官方同款写法见 dsh-agent-instructions：`{ kind: 'agent-instructions', form: 'instructions', changes }`。
 *
 * 0.1.5 的类型 `MessageSource` 仍把 `kind` 定成 `'model' | 'user' | 'plugin' | 'tool'` 封闭联合，
 * 但其运行时校验只覆盖 system/assistant/tool 三类消息
 * （dsh-session/lib/index.js:939-951，`user/message` 直接放行），故 `'memo-river'`
 * 在**两个版本的运行时都合法**。此处的断言只为让 0.1.5 的过时类型通过编译，不代表取值受限。
 */
function injectionSource(form: 'recall' | 'notice', extra: Record<string, unknown> = {}): MessageSource {
  return { kind: 'memo-river', form, ...extra } as unknown as MessageSource
}

/** 组装注入消息（`form: 'recall'`：素材是从别处会话/日志里取出的记忆）。 */
export function createInjectionMessage(text: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: injectionSource('recall'),
  })
}

/** 组装写入节律提醒消息（`form: 'notice'`：插件通知，非召回素材）。 */
export function createWriteNudgeMessage(text: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: injectionSource('notice', { summary: 'memo-river 写入节律提醒' }),
  })
}

/** 识别消息里的 memo_write 工具调用（写入时钟的工程锚点——不靠模型承诺）。 */
function hasMemoWriteCall(message: unknown): boolean {
  const content = (message as { content?: unknown })?.content
  if (!Array.isArray(content)) return false
  return content.some(
    (block) =>
      !!block &&
      typeof block === 'object' &&
      (block as { type?: string }).type === 'tool-call' &&
      (block as { name?: string }).name === 'memo_write',
  )
}

/* ── 票05（recall-quality-0916）：委托场景探针 ──────────────────────────────
 * c9f838ba 取证：父 22:25 派 26 子代理前落的 D3/D4 成为它们的检索基底——扇出在飞时
 * 写入价值最大，nudge 要换「先落盘：兄弟代理可立即召回」变体。两个信号：
 *   ① session.header.delegationDepth > 0（本会话自身是被派的孩子——DSH 派发时盖章）；
 *   ② 会话日志增量里出现委托工具调用（subagent/workflow/send_message 等，DSH 默认
 *      toolName；与 memo_write 同形态的 tool-call 块）。
 * 闩锁语义：见委托调用 → delegationActive=true；见 memo_write（进展已落盘）→ false。
 * 与既有 memo_write 增量扫描（lastObservedLogLength 游标）共用范围，独立成趟——
 * 既有那趟撞到 memo_write 会 break，本趟必须看全序（先写后派的批次要正确再闩上）。 */
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'subagent',
  'subagent_fork',
  'workflow',
  'send_message',
  'agent_send',
  'ralph',
])

function hasDelegationCall(message: unknown): boolean {
  const content = (message as { content?: unknown })?.content
  if (!Array.isArray(content)) return false
  return content.some(
    (block) =>
      !!block &&
      typeof block === 'object' &&
      (block as { type?: string }).type === 'tool-call' &&
      DELEGATION_TOOL_NAMES.has(String((block as { name?: string }).name ?? '')),
  )
}

/** 票12：压缩探针——上下文压缩调用（ACP compress）。与 memo_write 同构识别；
 * 观测到 → 累计 streak（自上次写入以来），nudge 据此带「抢救被压细节」提示。
 * 证据：c9f838ba 父会话 6 连压后写入细节损失、D5 诊断「压缩后写得更糟」——
 * 模型压缩后只能凭摘要写，被压掉的关键细节若不趁热落盘就永久丢失。 */
function hasCompressCall(message: unknown): boolean {
  const content = (message as { content?: unknown })?.content
  if (!Array.isArray(content)) return false
  return content.some(
    (block) =>
      !!block &&
      typeof block === 'object' &&
      (block as { type?: string }).type === 'tool-call' &&
      'compress' === String((block as { name?: string }).name ?? ''),
  )
}

/* ── 票05：增量锚的工具输出封顶（用户拍板 2026-09-14）──────────────────────────
 * 工具大输出（浏览器 DOM dump 等）不是概念进展，全额计入增量锚会在几分钟内攒满
 * 50K 反复触发（生产实锤：11:04:48/11:06:36/11:08:48 三连拍）。封顶口径：
 * 单次工具输出计入股 = min(实际长度, 本会话截尾均值)；均值 = 最近 ≤20 次工具输出
 * 长度去掉最高 10% 与最低 10% 后取平均（适应会话形态）；样本 <8 次用保守默认上限。
 * 助手产出与真实用户消息不封顶。 */
export const DEFAULT_TOOL_CAP_CHARS = 4000
export const WRITE_NUDGE_MIN_SPACING_MS = 5 * 60_000
const TOOL_LEN_SAMPLE_MAX = 20
const TOOL_LEN_WARMUP = 8

function trimmedMean(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const drop = Math.max(1, Math.floor(s.length * 0.1))
  const mid = s.slice(drop, s.length - drop)
  if (mid.length === 0) return s[Math.floor(s.length / 2)] ?? DEFAULT_TOOL_CAP_CHARS
  return mid.reduce((a, b) => a + b, 0) / mid.length
}

/** 单条工具输出计入增量锚的字符数（截尾均值封顶；导出供验收直接测）。 */
export function cappedToolChars(toolLens: number[], len: number): number {
  if (len <= DEFAULT_TOOL_CAP_CHARS) return len
  if (toolLens.length < TOOL_LEN_WARMUP) return Math.min(len, DEFAULT_TOOL_CAP_CHARS)
  return Math.min(len, Math.round(trimmedMean(toolLens)))
}

/** 工具结果消息（user 角色、source.kind='tool'）——增量锚只对这类文本封顶。 */
function isToolResultMsg(m: unknown): boolean {
  return (
    (m as { role?: string }).role === 'user' &&
    (m as { source?: { kind?: string } }).source?.kind === 'tool'
  )
}

/**
 * 写入节律提醒（ACP nudge 移植）：工程触发 + 弹药 + 限流，让模型在正确的时机被提醒写日记。
 * 四锚触发（任一满足即提醒）：
 *   · 时间锚 writeNudgeEveryMinutes——距上次写入/提醒超 N 分钟（兜长任务）；
 *   · 汇报轮锚 writeNudgeEveryTurns——N 个「小轮」（实质汇报收尾的回合）未写（兜快节奏）；
 *   · 自主态步锚 writeNudgeEverySteps——距上次锚点 ≥N 步（oneshot 适配；不依赖 draft）；
 *   · 自主态增量锚 writeNudgeGrowthChars——上下文自锚点累计增长 ≥N 字符（同上）。
 * 交互锚（时间/轮）要求有未入河的回合进展（draft 比上次写入新）；自主锚（步/增量）不要求——
 * oneshot 单回合 turn-stopping 永不触发、lastDraftSummary 恒空，步数/增量本身就是进展信号。
 * 触发后四个锚点同时重置（防同一信号连拍）；自主态同回合可再触发（原「每回合≤1」只适用交互态）。
 */
export function evaluateWriteNudge(
  config: Config,
  state: SessionState,
  turn: number,
  now = Date.now(),
  step = 1,
  contextChars: number | null = null,
  /** 票05：草稿队列读数——懒取（只在确认要发提醒时求值一次，省每步目录 IO）。 */
  queueProvider?: () => PendingQueueStats | null,
  /** 票05（recall-quality-0916）：委托场景（delegationDepth>0 或探针闩上）→ 共享提示变体。 */
  delegation = false,
  /** 票12：接续锚——最近一篇日记末段一句的懒取（只在确认要发提醒时读一次盘）。 */
  tailProvider?: () => string | null,
  /** 票11：委托变体引导（冷门 Tag + 同轴合并）的懒取（仅 delegation 时调用一次）。 */
  extrasProvider?: (suggestedTags: string[]) => DelegationExtras | null,
): string | null {
  const t = tuningValues(config, state.sessionId)
  const everyMin = t.writeNudgeEveryMinutes
  const everyTurns = t.writeNudgeEveryTurns
  const everySteps = t.writeNudgeEverySteps
  const growthChars = t.writeNudgeGrowthChars
  if (everyMin <= 0 && everyTurns <= 0 && everySteps <= 0 && growthChars <= 0) return null
  // 票05：最小重发间隔——任何锚都不豁免（issue #108 教训：正反馈连拍）。
  // 上一发在 5 分钟内 → 无论步/增量/时间/轮锚是否到位都不再发。
  if (state.lastWriteNudgeAt > 0 && now - state.lastWriteNudgeAt < WRITE_NUDGE_MIN_SPACING_MS) return null
  // 自主锚：不依赖 draft
  const anchorStep = Math.max(state.lastDiaryWriteStep, state.lastWriteNudgeStep)
  const stepsSince = step >= anchorStep ? step - anchorStep : step // 新回合步号回卷 → 从回合起计
  const stepDue = everySteps > 0 && stepsSince >= everySteps
  if (state.nudgeAnchorChars <= 0 && contextChars !== null) state.nudgeAnchorChars = contextChars // 首个 pre-step 打底
  const growth = contextChars !== null ? contextChars - state.nudgeAnchorChars : 0
  const growthDue = growthChars > 0 && growth >= growthChars
  // 交互锚：要求未入河进展。时间锚只量「模型实际思考时间」（activeMs 增量，
  // llm/stream 流时长累计；工具执行与空闲不计入——2026-09-13 用户拍板：
  // 空闲一下午回来第一条消息不应把几小时的墙钟欠账一次性触发）。
  const draft = state.lastDraftSummary
  const progress = !!draft && draft.at > state.lastDiaryWriteAt
  const activeSinceMs = state.activeMs - state.activeMsAnchor
  const timeDue = everyMin > 0 && progress && activeSinceMs >= everyMin * 60_000
  const anchorTurn = Math.max(state.lastDiaryWriteTurn, state.lastWriteNudgeTurn)
  const turnsSince = draft ? draft.turn - anchorTurn : 0
  const turnsDue = everyTurns > 0 && progress && !!draft && draft.substantive && turnsSince >= everyTurns
  if (!stepDue && !growthDue && !timeDue && !turnsDue) return null
  state.lastWriteNudgeAt = now
  state.activeMsAnchor = state.activeMs
  state.lastWriteNudgeTurn = turn
  state.lastWriteNudgeStep = step
  if (contextChars !== null) state.nudgeAnchorChars = contextChars
  const reason = stepDue
    ? `已 ${stepsSince} 步未写（自主态）`
    : growthDue
      ? `上下文自上次提醒已增 ${Math.round(growth / 1000)}K 字（自主态）`
      : turnsDue
        ? `已 ${turnsSince} 轮汇报未写入`
        : `已主动思考 ${Math.max(1, Math.round(activeSinceMs / 60_000))} 分钟未写`
  state.lastWriteNudgeReason = reason
  // 票05：digest 现取——自主态锚用观测循环里更新的最近助手实质文本首行（turn-stopping
  // 的 draft 存货在长自主回合里是旧战况，2026-09-14 实测收到引用上回合摘要的提醒）；
  // 交互态锚仍优先 draft（回合摘要含用户语境）。取不到各自的鲜货就互相兜底。
  const autonomous = stepDue || growthDue
  const digest = autonomous
    ? state.lastAssistantDigest || draft?.digest || `自主任务进行中（step ${step}，上下文 +${Math.max(0, Math.round(growth / 1000))}K 字）`
    : draft?.digest || state.lastAssistantDigest || `自主任务进行中（step ${step}）`
  // 票05：队列读数只在真发提醒时取一次；读数失败（目录不可读等）不拖垮提醒本体。
  let queue: PendingQueueStats | null = null
  try {
    queue = queueProvider ? queueProvider() : null
  } catch {
    queue = null
  }
  // 票12①：接续锚（懒取——拿不到就省略，文案回落现状）；
  // 票12②：压缩联动——自上次写入以来有 compress 且晚于最后写入 → 带「抢救细节」提示。
  let tail: string | null = null
  try {
    tail = tailProvider ? tailProvider() : null
  } catch {
    tail = null
  }
  const compressed = state.compressStreak > 0 && state.lastCompressAt > state.lastDiaryWriteAt ? state.compressStreak : 0
  // 票11：委托变体引导（懒取——只在确认发提醒且 delegation 时扫一次盘；失败回落 null）。
  let delegationExtras: DelegationExtras | null = null
  if (delegation) {
    try {
      delegationExtras = extrasProvider ? extrasProvider(draft?.suggestedTags ?? []) : null
    } catch {
      delegationExtras = null
    }
  }
  return renderWriteNudge(
    reason,
    draft?.turn ?? turn,
    digest,
    draft?.suggestedTags ?? [],
    queue,
    delegation,
    tail,
    compressed,
    delegationExtras,
  )
}

/**
 * 注册注入 seam。返回 disposer 列表（调用方用 ctx.effect 包住）。
 */

/** 票12①/票11：会话对应桶的日记目录（纯路径解析，无副作用）。失败 → null。 */
function diaryDirFor(agent: unknown, wstate: SessionState): string | null {
  try {
    const cwd = resolveCwd(agent as never, wstate)
    const paths = workspacePaths(cwd)
    return join(paths.root, 'dailynote', paths.bucket)
  } catch {
    return null
  }
}

/** 票12①：接续锚——本桶最近一篇日记的末段一句（D10 复读机根因：无锚则复述；
 * 给「上一篇止于哪」比要求「别复述」有效）。纯路径直读磁盘（readdir+mtime 择新），
 * **不走 deps.getWorkspace**——实测其副作用会扰动注入用的工作区/嵌入实例
 * （#11/#25/#26/#31 五连红，双盲回退 injector 后复绿，定位于此）。失败/无日记 → null。 */
function lastDiaryTail(deps: InjectorDeps, agent: unknown, wstate: SessionState): string | null {
  void deps
  try {
    const dir = diaryDirFor(agent, wstate)
    if (!dir) return null
    const names = readdirSync(dir).filter((n) => n.endsWith('.md'))
    if (names.length === 0) return null
    let newest: { name: string; mtime: number } = { name: names[0]!, mtime: statSync(join(dir, names[0]!)).mtimeMs }
    for (const n of names.slice(1)) {
      const m = statSync(join(dir, n)).mtimeMs
      if (m > newest.mtime) newest = { name: n, mtime: m }
    }
    return continuationTail(readFileSync(join(dir, newest.name), 'utf8'))
  } catch {
    return null
  }
}

/** 票11：委托变体引导（堵改疏）——冷门 Tag 建议（剔枢纽 ≥1/3，不足从词汇表补齐）+
 * 同轴合并提示（近期高 Tag 重叠 → 优先 update/merge 而非新开篇）。纯路径扫描
 * （nudge-guide，无 getWorkspace 副作用）；失败/空桶 → null（文案回落票 05/12 形态）。 */
function delegationExtrasFor(agent: unknown, wstate: SessionState, suggested: string[]): DelegationExtras | null {
  try {
    const dir = diaryDirFor(agent, wstate)
    if (!dir) return null
    const scan = scanTagAxis(dir)
    if (!scan || scan.files === 0) return null
    return {
      coldTags: coldTagSuggest(suggested, scan).tags,
      sameAxis: sameAxisHit(scan, suggested),
    }
  } catch {
    return null
  }
}

export function installInjection(
  ctx: {
    on(event: 'agent/pre-step', listener: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>, options?: { prepend?: boolean }): () => void
    on(event: 'llm/stream', listener: (options: LlmStreamOptionsLike, next: () => unknown) => unknown): () => void
  },
  deps: InjectorDeps,
): void {
  const { config } = deps

  /* ── 主干：agent/pre-step（把注入块放到请求尾部） ── */
  ctx.on(
    'agent/pre-step',
    async (payload, next): Promise<PreStepDecision> => {
      // ① 永远先委托——不夺权、不改写别人的决策（§6.5）。
      const decision = await next()
      try {
        if (!config.enabled) return decision
        if (decision.kind !== 'enter') return decision
        if (payload.signal?.aborted) return decision
        // 写侧观测：扫到 memo_write 工具调用 → 重置写入时钟（工程识别「模型写了」，不靠承诺）。
        // 同一遍扫描顺带量上下文字符总量（增量锚的量尺：deriveMessages 全量文本长度和）。
        const wstate = peekSession(payload.agent.session.id)
        let contextChars: number | null = null
        if (wstate) {
          const log = (payload.agent.session?.deriveMessages?.() ?? []) as unknown[]
          // 票05：增量锚的量尺——工具输出按截尾均值封顶计入（大 dump ≠ 概念进展），
          // 其余消息（助手正文/真实用户输入）全额计入。
          let chars = 0
          for (let i = 0; i < log.length; i++) {
            const t = messageText(log[i]).length
            chars += isToolResultMsg(log[i]) ? cappedToolChars(wstate.toolLens, t) : t
          }
          contextChars = chars
          const from = Math.min(wstate.lastObservedLogLength, log.length)
          for (let i = from; i < log.length; i++) {
            const txt = messageText(log[i])
            if (isToolResultMsg(log[i]) && txt.length > 0) {
              wstate.toolLens.push(txt.length)
              if (wstate.toolLens.length > TOOL_LEN_SAMPLE_MAX) wstate.toolLens.shift()
            }
            // 票05：digest 现取——记最近一条 ≥150 字助手正文的首行（自主态 nudge 的鲜弹药）。
            if ((log[i] as { role?: string }).role === 'assistant' && txt.length >= 150) {
              const firstLine = txt.split('\n').map((x) => x.trim()).find((x) => x.length > 0) ?? ''
              if (firstLine) wstate.lastAssistantDigest = firstLine.slice(0, 80)
            }
            if (hasMemoWriteCall(log[i])) {
              wstate.lastDiaryWriteAt = Date.now()
              wstate.lastDiaryWriteTurn = payload.turn
              wstate.lastDiaryWriteStep = payload.step
              wstate.nudgeAnchorChars = chars
              wstate.activeMsAnchor = wstate.activeMs
              break
            }
          }
          // 票05（recall-quality-0916）：委托闩锁——独立成趟（上一趟撞 memo_write 会 break，
          // 本趟必须看全序：先写后派的批次要正确再闩上，先派后写要正确回落）。
          // 票12：压缩计数同趟（同样需要全序；memo_write 观测即清零——进展已落盘，
          // 「抢救被压细节」的提示窗口关闭）。
          let delegationDelta: boolean | null = null
          for (let i = from; i < log.length; i++) {
            if (hasDelegationCall(log[i])) delegationDelta = true
            else if (hasCompressCall(log[i])) {
              wstate.lastCompressAt = Date.now()
              wstate.compressStreak++
            } else if (hasMemoWriteCall(log[i])) {
              delegationDelta = false
              wstate.compressStreak = 0
            }
          }
          if (delegationDelta !== null) wstate.delegationActive = delegationDelta
          wstate.lastObservedLogLength = log.length
          if ([...decision.messages, ...(payload.messages ?? [])].some(hasMemoWriteCall)) {
            wstate.lastDiaryWriteAt = Date.now()
            wstate.lastDiaryWriteTurn = payload.turn
            wstate.lastDiaryWriteStep = payload.step
            wstate.nudgeAnchorChars = chars
            wstate.activeMsAnchor = wstate.activeMs
          }
        }
        // 读侧：注入时机（回合首发 / 自主态节律 / 压缩重注）由 buildTailInjection 全权裁定。
        const text = await buildTailInjection(deps, payload.agent, payload.turn, payload.step, payload.messages)
        // 写侧：写入节律提醒（独立于召回，可同拍并存；四锚：时间/汇报轮/步/增量）
        // 票05：提醒文案带本工作区草稿队列读数（懒取——evaluateWriteNudge 确认要发才扫目录）。
        // 票05（recall-quality-0916）：委托场景（header.delegationDepth>0 或探针闩上）→ 共享提示变体。
        const delegationDepth = payload.agent.session?.header?.delegationDepth ?? 0
        const delegation = delegationDepth > 0 || (wstate?.delegationActive ?? false)
        const nudge = wstate
          ? evaluateWriteNudge(config, wstate, payload.turn, Date.now(), payload.step, contextChars, () => {
              try {
                return pendingQueueStats(workspacePaths(resolveCwd(payload.agent, wstate)).pendingDir)
              } catch {
                return null // 路径解析失败 → 提醒不带队列行，不出数字
              }
            }, delegation, () => lastDiaryTail(deps, payload.agent, wstate), (suggested) => delegationExtrasFor(payload.agent, wstate, suggested))
          : null
        const extra: unknown[] = []
        if (text) extra.push(createInjectionMessage(text))
        if (nudge) {
          extra.push(createWriteNudgeMessage(nudge))
          // 票01：遥测落桶日志（memo-river.log）——deps.log 是宿主 logger，生产实测两处都看不到
          // （09-14 评估：composer 11 次投递、桶日志 0 行）。带触发理由与步号。
          // 票05（recall-quality-0916）：补 delegation 标记（depth/闩锁双来源），变体触发可归因。
          const delegationTag = ` delegation=${delegation ? 1 : 0}${delegation ? `(depth=${delegationDepth}${wstate?.delegationActive ? '+latch' : ''})` : ''}`
          try {
            const wsLog = deps.getWorkspace(resolveCwd(payload.agent, wstate)).logger
            wsLog.info(
              `write-nudge session=${wstate!.sessionId} turn=${payload.turn} step=${payload.step} reason=${wstate!.lastWriteNudgeReason}${delegationTag}`,
            )
          } catch {
            deps.log('info', `write-nudge session=${wstate!.sessionId} turn=${payload.turn} reason=${wstate!.lastWriteNudgeReason}${delegationTag}`)
          }
        }
        if (extra.length === 0) return decision
        // ② 追加到批次末尾 = 请求消息数组的尾部（在 assistant 回答之前）。
        return { ...decision, messages: [...decision.messages, ...extra] }
      } catch (e) {
        // ③ 失败降级为「不注入 + 记日志」，绝不阻塞主流程（§6.5）。
        const failMsg = `pre-step-inject-failed: ${String((e as Error)?.stack ?? e)}`
        deps.log('error', failMsg)
        // 票01/03：失败也要落桶日志——否则这类「静默不注入」在 memo-river.log 里无迹可寻
        // （09-14 排查 f23d80 空桶时正是缺这条线）。best-effort，cwd 解析失败不二次抛。
        try {
          const st = peekSession(payload.agent.session?.id ?? '')
          deps.getWorkspace(resolveCwd(payload.agent, st)).logger.error(failMsg)
        } catch {
          /* 双落失败则只剩 deps.log 一条腿 */
        }
        return decision
      }
    },
    { prepend: true },
  )

  /* ── DESIGN §6.5 点名的拦截点：只读观测 + 审计 + 永远 next() 委托 ──
     计时口径（2026-09-13 用户拍板）：时间锚只量「模型实际思考时间」——
     即 llm/stream 的真实流时长（next() 的执行跨度），工具执行与空闲不计入。 */
  ctx.on('llm/stream', (options, next) => {
    const t0 = Date.now()
    const accumulate = (): void => {
      try {
        const sid = (options as { sessionId?: string })?.sessionId
        const st = sid ? peekSession(sid) : undefined
        if (st) st.activeMs += Date.now() - t0
      } catch {
        /* 计时失败不影响主流程 */
      }
    }
    try {
      const sessionId = options?.sessionId
      const state = sessionId ? peekSession(sessionId) : undefined
      if (state) {
        // 验收 #2：system 段逐轮 hash（零动态）
        const system = options.messages.find((m) => (m as { role?: string }).role === 'system')
        state.systemHashes.push(sha256(messageText(system)))
        if (state.systemHashes.length > 32) state.systemHashes.shift()

        // 验收 #1：注入块是本请求消息数组的尾部，且其后没有 assistant 消息
        const audit = state.audits[state.audits.length - 1]
        if (audit && state.lastInjectionText) {
          const idx = options.messages.findIndex((m) => messageText(m).includes(BLOCK_CLOSE))
          audit.tailIndex = idx
          audit.totalMessages = options.messages.length
          audit.assistantAfter =
            idx < 0 ? null : options.messages.slice(idx + 1).some((m) => (m as { role?: string }).role === 'assistant')
        }
      }
    } catch (e) {
      deps.log('warn', `llm-stream-audit-failed: ${String((e as Error)?.message ?? e)}`)
    }
    try {
      const r = next() as unknown as { then?: unknown; finally?: unknown }
      if (r && typeof r === 'object' && typeof (r as { finally?: unknown }).finally === 'function') {
        return (r as unknown as Promise<unknown> & { finally(cb: () => void): unknown }).finally(accumulate)
      }
      accumulate()
      return r
    } catch (e) {
      accumulate()
      throw e
    }
  })
}
