/**
 * src/session.ts — 会话级状态（DESIGN.md §5.2 / §6.5）。
 *
 * 纪律：**一切会话状态按 session id 键存在本 Map 里，禁止全局 lastXxx**。
 * （作者同款：「禁止依赖可能被并发请求覆盖的全局最近状态」。）
 * 工作区级资源（库 / 索引）在 src/workspace.ts，按 cwd 键——两者不可混。
 */
import type { RecallCandidate } from './recall.js'

export interface InjectionAudit {
  turn: number
  step: number
  /** 注入块内容 sha256。 */
  blockHash: string
  chars: number
  /** llm/stream 侧观测：该块在冻结请求 messages 里的下标。 */
  tailIndex: number | null
  totalMessages: number | null
  /** 该块之后是否还有 assistant 消息（必须为 false）。 */
  assistantAfter: boolean | null
  at: number
}

export interface PendingDraft {
  turn: number
  userText: string
  assistantText: string
  /** 票02：**不再**来自被动召回命中（内容判定在 drafts.ts curateTags）——恒为空数组，
   *  保留字段只因草稿 md/解析器/DraftRecord 三处共用一个形状。 */
  suggestedTags: string[]
  /** 票02：本轮被动召回的 matchedTags（草稿 md 单列一节「非建议 Tag」，只作参考）。 */
  recalledTags: string[]
  relatedIds: number[]
  at: number
}

/**
 * 回合进展摘要（写入节律提醒的弹药）：turn-stopping 时随草稿一起记录，
 * 与 pendingDraft 不同——它**不被消费**，保留到被下一回合覆盖。
 */
export interface DraftDigest {
  turn: number
  at: number
  suggestedTags: string[]
  digest: string
  /** 本回合是否以「实质性汇报」收尾（助手正文 ≥ SUBSTANTIVE_REPORT_CHARS 字）——
   *  「小轮」判别：用户一条消息 → 内部多步工具/思考 → 阶段性汇报 → 回合停。
   *  聊天式短回合（"好的/收到"）不算，防 writeNudgeEveryTurns 误触。 */
  substantive: boolean
}

/** 「小轮」= 以 ≥ 此字数的助手汇报收尾的回合（2026-09-13 用户经验：汇报轮一般带进展性）。 */
export const SUBSTANTIVE_REPORT_CHARS = 400

export interface SessionState {
  readonly sessionId: string
  cwd: string | null
  /** 已处理过的最大 (turn, step)。 */
  lastTurn: number
  lastStep: number
  /** 最近一次真正注入的块（供 memo_write 回注与回归测试取用）。 */
  lastInjectionText: string | null
  lastFallbackReason: string | null
  /** 最近一次召回的候选（memo_write 写前回注旧日记用）。 */
  lastCandidates: RecallCandidate[]
  /**
   * 最近一次**真正注入**的入选集合（chunk id 升序拼接）。
   *
   * 去重的键是**集合**而不是块文本 —— 实测 `ids=D1,D2,D4` 在 40 分钟里连注 6 次，
   * 文本各不相同（只差 Ω 的小数位），按文本去重一次都省不下来。
   */
  lastSelectionKey: string | null
  /** 最近一次真正注入所在的 turn（配合 dedupeRefreshTurns 防「旧块被压缩折走后仍在跳过」）。 */
  lastInjectTurn: number
  /** 自主态节律：最近一次注入尝试（回合首发或节律）的 (turn, step)。 */
  lastAutoTurn: number
  lastAutoStep: number
  /** 自主态节律尝试次数（自最近一次真正注入起累计；达 dedupeRefreshTurns 强制重注）。 */
  autoAttemptsSinceInject: number
  /** 最近一次见过的 ACP 压缩 id（新 id=压缩刚发生 → 立即重注）。 */
  lastCompactionId: string | null
  /** 每次 llm/stream 观测到的 system 段 hash（验收 #2）。 */
  systemHashes: string[]
  /** 每次注入的审计记录（验收 #1）。 */
  audits: InjectionAudit[]
  /** turn-stopping 收集的候选草稿（只产草稿，不落库）。 */
  pendingDraft: PendingDraft | null
  /** turn-stopping 记录的回合进展摘要（写入节律提醒的弹药；不被消费，直到被下回合覆盖）。 */
  lastDraftSummary: DraftDigest | null
  /** 最近一次观测到 memo_write 工具调用的时刻（写入节律的时钟锚点）。 */
  lastDiaryWriteAt: number
  /** 最近一次观测到 memo_write 的回合号（汇报轮锚点：与 lastWriteNudgeTurn 取 max 作轮锚）。 */
  lastDiaryWriteTurn: number
  /** 最近一次观测到 memo_write 的步号（自主态步锚：与 lastWriteNudgeStep 取 max 作步锚）。 */
  lastDiaryWriteStep: number
  /** 最近一次提醒/写入时的上下文字符基线（增量锚；0=未设，首个 pre-step 打底）。 */
  nudgeAnchorChars: number
  /** 最近一次发出写入节律提醒的时刻（防连拍）。 */
  lastWriteNudgeAt: number
  /** 最近一次发出写入节律提醒的回合（交互态轮锚之一；自主态不设回合上限——锚重置即节流）。 */
  lastWriteNudgeTurn: number
  /** 最近一次发出写入节律提醒的步号（自主态步锚之一）。 */
  lastWriteNudgeStep: number
  /** 最近一次 write-nudge 的触发理由（遥测：落桶日志用，evaluateWriteNudge 写入）。 */
  lastWriteNudgeReason: string
  /**
   * 委托在飞（票05 场景感知）：增量扫描到 subagent/workflow 等委托工具调用 → true；
   * 观测到 memo_write（进展已落盘）→ false。与 header.delegationDepth>0 取或后
   * 决定 write-nudge 用「先落盘：兄弟代理可立即召回」变体。
   */
  delegationActive: boolean
  /**
   * 最近一步的注入形态（票06 写侧信号）：injector 每 pre-step 落一次
   * isTurnStart ? 'interactive' : 'autonomous'——memo_write 等写工具在 execute
   * 里读它做 hub 闸门场景化（autonomous 会话写枢纽 Tag 从软警告升级）。
   * 没被 injector 见过的会话（新起/禁用注入）保持 'interactive' 缺省——保守不误伤。
   */
  lastInjectMode: 'interactive' | 'autonomous'
  /** 最近观测到的工具输出长度环形样本（≤20 条；增量锚截尾均值的量尺，票05）。 */
  toolLens: number[]
  /** 最近一条 ≥150 字助手正文的首行摘要（票05：digest 触发时现取，不走 turn-stopping 存货）。 */
  lastAssistantDigest: string
  /** 最近一次观测到 compress 工具调用的时刻（票12 压缩联动：写入提醒带「抢救被压细节」提示）。 */
  lastCompressAt: number
  /** 自上次 memo_write 以来观测到的 compress 次数（票12：>0 且 lastCompressAt>lastDiaryWriteAt 时 nudge 带压缩提示）。 */
  compressStreak: number
  /** 模型主动思考累计毫秒（llm/stream 实际流时长逐次累加；不含工具执行、不含空闲）。 */
  activeMs: number
  /** 最近一次提醒/写入时的 activeMs 基线（时间锚只量「思考时间」，2026-09-13 用户拍板）。 */
  activeMsAnchor: number
  /** 上次 pre-step 观测到的会话日志长度（memo_write 增量扫描的游标）。 */
  lastObservedLogLength: number
  /** 注入次数 / 跳过次数（体检与日志）。 */
  injectedCount: number
  skippedCount: number
  /** in-flight 注入（防同一会话并发重复召回）。 */
  inflight: Promise<string | null> | null
}

const sessions = new Map<string, SessionState>()

/** 活跃会话清单（调参面板的会话选择器用）。 */
export function listSessions(): Array<{ sessionId: string; cwd: string | null }> {
  return [...sessions.values()].map((s) => ({ sessionId: s.sessionId, cwd: s.cwd }))
}

export function getSession(sessionId: string, cwd: string | null): SessionState {
  const existing = sessions.get(sessionId)
  if (existing) {
    if (!existing.cwd && cwd) existing.cwd = cwd
    return existing
  }
  const state: SessionState = {
    sessionId,
    cwd,
    lastTurn: -1,
    lastStep: -1,
    lastInjectionText: null,
    lastFallbackReason: null,
    lastCandidates: [],
    lastSelectionKey: null,
    lastInjectTurn: -1,
    lastAutoTurn: -1,
    lastAutoStep: -1,
    autoAttemptsSinceInject: 0,
    lastCompactionId: null,
    systemHashes: [],
    audits: [],
    pendingDraft: null,
    lastDraftSummary: null,
    lastDiaryWriteAt: Date.now(),
    lastWriteNudgeAt: 0,
    lastWriteNudgeTurn: -1,
    lastDiaryWriteTurn: 0,
    lastDiaryWriteStep: 0,
    lastWriteNudgeStep: 0,
    lastWriteNudgeReason: '',
    delegationActive: false,
    lastCompressAt: 0,
    compressStreak: 0,
    lastInjectMode: 'interactive',
    toolLens: [],
    lastAssistantDigest: '',
    activeMs: 0,
    activeMsAnchor: 0,
    nudgeAnchorChars: 0,
    lastObservedLogLength: 0,
    injectedCount: 0,
    skippedCount: 0,
    inflight: null,
  }
  sessions.set(sessionId, state)
  return state
}

export function peekSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId)
}

export function dropSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function sessionCount(): number {
  return sessions.size
}

/** 取出（并清空）满足条件的待落盘草稿——守护循环写 pending/*.md 用。 */
export function takeDrafts(
  predicate: (state: SessionState) => boolean,
): Array<{ state: SessionState; draft: PendingDraft }> {
  const out: Array<{ state: SessionState; draft: PendingDraft }> = []
  for (const state of sessions.values()) {
    const draft = state.pendingDraft
    if (!draft) continue
    if (!predicate(state)) continue
    state.pendingDraft = null
    out.push({ state, draft })
  }
  return out
}

/** 测试/回归：把某会话的审计与 hash 序列清空（不动工作区资源）。 */
export function resetSessionAudit(sessionId: string): void {
  const state = sessions.get(sessionId)
  if (!state) return
  state.audits = []
  state.systemHashes = []
}
