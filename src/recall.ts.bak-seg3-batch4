/**
 * src/recall.ts — 召回管线：查询场 → 门控 → 原生观测 → 读出 → 低基数门限 → 预算截断。
 *
 * 对应 DESIGN.md §4「请求前」的 ①–④ 与 §6.3 的门控/预算表。
 * 这里是**纯计算层**：不碰 DSH 上下文、不注入、不落库，全部输入显式传入，
 * 因此可以被验收脚本直接驱动（§10 #3 #4 #5 #8 #9）。
 */
import type { ReadoutMode } from './config.js'
import { cosine, type EmbedClient } from './embed.js'
import { readUsageLedger } from './health.js'
import { estimateTokens, firstSentence } from './runtime.js'
import type { MemoEngine } from './native.js'
import type { KnowledgeStore } from './store.js'
import { applyUsageTieBreaker, type TieBreakerParams } from './tiebreaker.js'

/**
 * 票⑧ 分锚阈值余量：助手锚的及格线 = gateThreshold + 本值。
 * 依据（2026-09-14 教室语料四负例实测）：离题 150+ 字助手陈述 gA 负例带 0.5384-0.5810，
 * 在题带 0.709-0.881（校准 17 例）；+0.07 → 0.62 落带间（负例上界距 0.04，在题下界距 0.09）。
 */
export const GATE_ASSISTANT_MARGIN = 0.07

/**
 * 票 03：自适应 K 的池地板——候选数 <5 的稀疏桶保持固定 k（旧行为逐位不变）。
 * 5 的由头：验收 #19/#25（k=2/池 3）与 #31（k=1/池 2）等显式小 k 用例都在此之下；
 * 池=5 时 ceil(5×0.6)=3 恰等于默认 k=3，扩容从零起步平滑衔接（无跳变）。
 */
export const ADAPTIVE_K_POOL_FLOOR = 5

/* ── 票 04：选择循环有界权重（批内多样性 + 近因）──────────────────────────────
 *
 * 证据（genshin-ts 桶 c9f838ba 深评，docs/EVAL-单会话深评-genshin-ts-c9f838ba.md）：
 * 09-11 的旧日记 D1 一夜被被动注入 36/37 次——同域旧条目泛化，固定排序下永远在席；
 * 桶一夜 2→27，新写的 25 篇全程陪跑。三个有界权重治这个「搭车」：
 *   ① 曝光抑制（跨注入）：被动台账里 recent passive 的条目按 tanh(次数/τ)×exp(年龄/半衰)
 *      受有界惩罚。台账由 injector 每次注入成功后 recordUsage('passive') 记账，是现成的
 *      跨注入状态（无需会话级新状态）。与票 05 tie-breaker 互为镜像：那边只认**主动**
 *      信号做正向强化（被动计入强化=曝光偏差），这边读**被动**信号做负向抑制（反垄断）——
 *      注入是曝光不是检索，反复曝光的条目该让位，随时间衰减则不会永久流放。
 *   ② 批内同 Tag 去重（同轴去重）：贪心逐席选择，候选与本批已入选条目 matchedTags 的
 *      重叠率越高扣越重——hub Tag（「千星官方课程」21/26）饱和的池子里，同 Tag 克隆的
 *      分数天然挤成近似并列，恰在 cap 射程内让位给异轴条目。
 *   ③ 近因加成：写入时间在窗口期内（缺省 24h）的条目线性加成——刚写的进展不该被旧
 *      条目搭车挤光（与 §⑥ recency floor 互补：floor 是保底席，这是排序内竞争力）。
 *
 * 有界性/回滚：三项上界独立可配、缺省保守（合计仍 ≪ 锚奖励 0.18），只能翻近似并列、
 * 不可能把无关条目顶到在题条目之上（不推翻 topology 主排序）；不传 selectionWeights /
 * 各 cap=0 → 逐位旧行为；池 < ADAPTIVE_K_POOL_FLOOR(5) 同样逐位旧行为（与票 03 池地板
 * 同界，护住稀疏桶语义）。零新增嵌入调用——权重全部复用读出已产出的分数与台账。 */

/** 曝光饱和常数：tanh(passive/τ)，~3 次注入近饱和（与票 05 tieBreakerTau 同值同由头）。 */
export const EXPOSURE_TAU = 2

/** 票 04：选择权重参数（config.inject → injector.recallOptions 注入；缺省不传 = 旧行为）。 */
export interface SelectionWeights {
  /** 批内同 Tag 去重上界（每席扣 cap×重叠率；0=关）。 */
  tagCap: number
  /** 跨注入曝光抑制上界（0=关）。 */
  exposureCap: number
  /** 曝光惩罚半衰期（小时；上次被动注入越久罚越轻）。 */
  exposureHalfLifeHours: number
  /** 近因加成上界（0=关）。 */
  recencyCap: number
  /** 近因窗口（小时；窗口内线性衰减到 0）。 */
  recencyWindowHours: number
}

/** 票 04：选择权重的一次执行留痕（进 outcome.diagnostics，inject 日志外的自检素材）。 */
export interface SelectionDiagnostics {
  on: boolean
  /** 获得近因加成的候选行数。 */
  recencyBoosted: number
  /** 受曝光惩罚的候选行数。 */
  exposurePenalized: number
  /** 本批最大曝光惩罚值（有界性自检：≤ exposureCap）。 */
  maxPenalty: number
  /** 静态序首位被同 Tag 去重翻下席的次数（0=去重未改变任何选择）。 */
  tagDemotions: number
}

export interface RecallCandidate {
  /** chunk id（VCP 里就是日记的 D<id>）。 */
  id: number
  fileId: number
  /** 写入时间戳（files.updated_at，毫秒；老数据可能为 null → 退回标题日期）。 */
  writtenAt: number | null
  /** 标题（文件名去扩展名）。 */
  title: string
  diaryName: string
  /** 纯 KNN 余弦基线（决定低基数门限）。 */
  knnScore: number
  /** 读出后的有效分数（已应用低基数门限）。 */
  score: number
  /** 原生读出原始分数（未应用低基数门限，取证用）。 */
  rawScore: number
  role: string
  anchorBonus: number
  topologyBonus: number
  omega: number | null
  riverRegime: string | null
  matchedTags: string[]
  /** §2.2 规则 4：KNN 低于门限 → 不发放结构奖励。 */
  rewardSuppressed: boolean
  body: string
  /** 桶继承（federate）：该条目来自哪个父桶；本桶条目缺省（渲染不标注）。 */
  srcBucket?: string
}

export interface RecallOutcome {
  injected: boolean
  /** 未注入原因（§6.3：门控不过 → 清空 + fallbackReason）。 */
  fallbackReason: string | null
  gate: {
    passed: boolean
    /** 门控实际比对的 maxKnn（gateVector=current 时来自当前消息，否则来自检索向量）。 */
    maxKnn: number
    threshold: number
    enabled: boolean
    /** 门控向量来源：current=用户锚 / assistant=助手锚（票⑧）/ window=检索窗口 / none=未算（门控关闭或未传锚）。 */
    gateVector: 'current' | 'assistant' | 'window' | 'none'
    /** 检索向量的 maxKnn（取证用；不参与门控判定）。 */
    retrievalMaxKnn: number
  }
  mode: ReadoutMode
  omega: number | null
  regime: string | null
  dynamicK: number
  candidateCount: number
  /** 全部候选（读出后，未截断）。 */
  candidates: RecallCandidate[]
  /** 最终进入注入的候选。 */
  selected: RecallCandidate[]
  /** 被截断/丢弃的候选（§6.2「未注入说明」的素材）。 */
  dropped: Array<{ id: number; title: string; reason: string }>
  diagnostics: Record<string, unknown>
  elapsedMs: number
}

/** 从日记标题（文件名含 YYYY-MM-DD 前缀）解析当日 0 点时间戳；解析不出返回 0。 */
function diaryDateMs(title: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(title)
  if (!m) return 0
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
  return Number.isFinite(ms) ? ms : 0
}

/** 写入时间戳：files.updated_at（毫秒），缺失退回标题日期——§⑥ recency floor 与票 04
 *  近因加成的共用口径（同日平局由写入时刻决胜，2026-09-14 生产实锤 D19 落选的教训）。 */
function stampOfRow(r: { writtenAt: number | null; title: string }): number {
  return r.writtenAt ?? diaryDateMs(r.title)
}

export interface RecallOptions {
  mode: ReadoutMode
  k: number
  tokenBudget: number
  dynamicK: number
  /** 票 03：自适应 K 比例——候选池 ≥ ADAPTIVE_K_POOL_FLOOR 时条数上限提到 clamp(ceil(池×比例), k, adaptiveKMax)；0/缺省 = 固定 k（旧行为）。 */
  adaptiveKRatio?: number
  /** 票 03：自适应 K 条数硬顶（与 adaptiveKRatio 配套；ratio≤0 或 max≤0 视为关闭）。 */
  adaptiveKMax?: number
  gate: boolean
  gateThreshold: number
  minKnnForReward: number
  /** 近因保底天数：最近 N 天内的最新日记被 k-limit/预算挤出入选集时保留一席（0/缺省 = 关闭）。 */
  recencyFloorDays?: number
  /** 票 05：有界 tie-breaker（缺省/关闭 = 逐位不变）。调用方从 memo_tuning 取值注入；
   *  被动注入路径不传（预设默认关），主动 memo_recall 按会话 tuning 生效。 */
  tieBreaker?: TieBreakerParams
  /** 票 04：选择循环有界权重（缺省不传 = 逐位旧行为）。被动注入由 injector 从 config
   *  注入（缺省保守常开——本票目的就是治 D1×36）；主动 memo_recall 不传（显式 k 语义）。 */
  selectionWeights?: SelectionWeights
  /** 查询 id（诊断/日志用；必须按会话/轮次唯一）。 */
  queryId: string
  /**
   * 门控专用文本（**当前这条用户消息**）。
   *
   * 与 queryText 解耦：queryText 是窗口拼接（回答"这段对话在讲什么"），
   * gateText 是当前消息本身（回答"这句话本身相不相关"）。
   * 不传则退回旧行为：门控拿检索向量比对（在 w≥2 时无判别力，见 config.ts 的实测注释）。
   */
  gateText?: string
  /**
   * 门控助手锚（票⑧ A 方案）：最近一条 ≥150 字助手消息的前 1200 字。
   *
   * 与 gateText 一样和检索窗口解耦；判定取 max(gU, gA)。
   * 校准（scripts/probe-gate-calibration.mjs，2026-09-14，composer 桶 73 事件）：
   * 纯用户锚 @0.55 对短指令类消息 17/17 误杀（gU 0.44-0.55 与无关负例重叠）；
   * max(gU, gA)@0.55 → 误杀 0/17、误放 0/8。两个锚都拿不到才退回窗口向量。
   */
  gateAssistantText?: string
  /**
   * 票 01：注入路径嵌入短超时（ms；0/缺省 = 用 EmbedClient 构造时的宽松默认 60s）。
   * 只罩本函数发出的合批 embed 调用（查询向量 + 门控锚一次请求）；写侧（tools.ts 的
   * memo_write 族）不经 recall，主动 memo_recall 也不传 → 均不受影响。
   */
  embedTimeoutMs?: number
  coreTags?: string[]
  ghostTags?: string[]
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

/** 单篇日记的标题：文件名去扩展名（native.cjs 用 path.basename）。 */
function titleOf(p: string): string {
  const base = p.replace(/\\/g, '/').split('/').pop() ?? p
  return base.replace(/\.[^.]+$/, '')
}

/**
 * 构造查询场文本（DESIGN §4 ①「取本会话最近 N 条消息 → 构造查询场」）。
 * 从最近往回收，累计到 lookback 条；空消息跳过。
 */
export function buildQueryField(recentTexts: readonly string[], lookback: number): string {
  const picked: string[] = []
  for (let i = recentTexts.length - 1; i >= 0 && picked.length < lookback; i--) {
    const text = (recentTexts[i] ?? '').trim()
    if (text) picked.unshift(text)
  }
  return picked.join('\n').slice(-4000)
}

const HOUR_MS = 3_600_000

/**
 * 票 03+04：读出后的选择循环（纯函数，验收脚本可直驱合成行做确定性断言）。
 *
 * - 票 03 自适应 K：池 ≥ ADAPTIVE_K_POOL_FLOOR 时 kBase = max(k, min(ceil(池×ratio), max))，
 *   池 <5 逐位旧行为（固定 k）；kEff = max(1, round(kBase×dynamicK))——倍率语义不变。
 * - 票 04 权重：见文件头「选择循环有界权重」注释块。**权重关闭（不传/全 0）或池 <5 时
 *   逐位退化为旧行为**——贪心逐席 argmax 在零权重下就是按分数序单趟走（eff===score
 *   位级相等、静态序=ranked 序、best 恒为队首），预算截断与 dropped 语义原样保留。
 * - **预算绝不让步**：权重只动选择顺序，逐条 cost 校验（超预算先截首句、再丢
 *   token-budget）原样兜底——k 再大、权重再活也装不超 tokenBudget。
 */
export function selectCandidates(
  ranked: RecallCandidate[],
  opts: {
    k: number
    dynamicK: number
    adaptiveKRatio: number
    adaptiveKMax: number
    tokenBudget: number
    selectionWeights?: SelectionWeights
    ledger: Map<number, { passive: number; lastPassiveAt: number | null }> | null
    /** 时钟（测试可注入；缺省 Date.now()）。 */
    now?: number
  },
): {
  selected: RecallCandidate[]
  dropped: Array<{ id: number; title: string; reason: string }>
  kBase: number
  kEff: number
  used: number
  pool: number
  weights: SelectionDiagnostics
} {
  const pool = ranked.length
  let kBase = opts.k
  if (opts.adaptiveKRatio > 0 && opts.adaptiveKMax > 0 && pool >= ADAPTIVE_K_POOL_FLOOR) {
    kBase = Math.max(opts.k, Math.min(Math.ceil(pool * opts.adaptiveKRatio), opts.adaptiveKMax))
  }
  const kEff = Math.max(1, Math.round(kBase * Math.max(0, opts.dynamicK)))
  const w = opts.selectionWeights
  const weightsOn =
    !!w && pool >= ADAPTIVE_K_POOL_FLOOR && (w.tagCap > 0 || w.exposureCap > 0 || w.recencyCap > 0)
  const now = opts.now ?? Date.now()

  /* 静态权重（每行一次算好；row.score 不被污染——只动选择顺序，渲染/诊断仍见原生分数）。
   * 曝光：penalty = cap×tanh(passive/τ)×exp(−age×ln2/半衰)；时钟回拨（lastP>now）不罚。 */
  const diag: SelectionDiagnostics = { on: weightsOn, recencyBoosted: 0, exposurePenalized: 0, maxPenalty: 0, tagDemotions: 0 }
  const halfLifeMs = w ? Math.max(1, w.exposureHalfLifeHours) * HOUR_MS : HOUR_MS
  const recWindowMs = w ? Math.max(1, w.recencyWindowHours) * HOUR_MS : HOUR_MS
  const seats = ranked.map((row, idx) => {
    let eff = row.score
    if (weightsOn && w!.exposureCap > 0) {
      const e = opts.ledger?.get(row.fileId)
      if (e && e.passive > 0 && e.lastPassiveAt !== null) {
        const ageMs = now - e.lastPassiveAt
        if (ageMs >= 0) {
          const p = w!.exposureCap * Math.tanh(e.passive / EXPOSURE_TAU) * Math.exp((-ageMs * Math.LN2) / halfLifeMs)
          if (p > 0) {
            eff -= p
            diag.exposurePenalized += 1
            if (p > diag.maxPenalty) diag.maxPenalty = p
          }
        }
      }
    }
    if (weightsOn && w!.recencyCap > 0) {
      const stamp = stampOfRow(row)
      if (stamp > 0) {
        const ageMs = now - stamp
        if (ageMs >= 0 && ageMs < recWindowMs) {
          eff += w!.recencyCap * (1 - ageMs / recWindowMs)
          diag.recencyBoosted += 1
        }
      }
    }
    return { row, idx, eff }
  })
  /* 静态序（eff 降序，平手按原 idx——零权重时 eff===score、与 ranked 序逐位一致） */
  const staticOrder = seats.slice().sort((a, b) => b.eff - a.eff || a.idx - b.idx)

  /* 贪心逐席：eff − tagCap×(与本批已入选 matchedTags 的重叠率)；预算语义与旧单趟逐位一致 */
  const selected: RecallCandidate[] = []
  const dropped: Array<{ id: number; title: string; reason: string }> = []
  const claimed = new Set<string>()
  let used = 0
  const remaining = staticOrder.slice()
  while (selected.length < kEff && remaining.length > 0) {
    let best = 0
    let bestVal = -Infinity
    for (let j = 0; j < remaining.length; j++) {
      const s = remaining[j]!
      let val = s.eff
      if (weightsOn && w!.tagCap > 0 && claimed.size > 0 && s.row.matchedTags.length > 0) {
        let hit = 0
        for (const t of s.row.matchedTags) if (claimed.has(t)) hit++
        if (hit > 0) val -= w!.tagCap * (hit / s.row.matchedTags.length)
      }
      if (val > bestVal) {
        bestVal = val
        best = j
      }
    }
    if (best !== 0) diag.tagDemotions += 1 // 静态序队首被同 Tag 去重翻下席
    const row = remaining.splice(best, 1)[0]!.row
    const cost = estimateTokens(row.body) + estimateTokens(row.title) + 24
    if (used + cost > opts.tokenBudget) {
      // `::Truncate` 语义：保 role 与首句
      const trimmed = firstSentence(row.body)
      const trimCost = estimateTokens(trimmed) + estimateTokens(row.title) + 24
      if (used + trimCost <= opts.tokenBudget) {
        selected.push({ ...row, body: trimmed })
        used += trimCost
        dropped.push({ id: row.id, title: row.title, reason: 'truncated-to-first-sentence' })
        for (const t of row.matchedTags) claimed.add(t)
        continue
      }
      dropped.push({ id: row.id, title: row.title, reason: 'token-budget' })
      continue
    }
    selected.push(row)
    used += cost
    for (const t of row.matchedTags) claimed.add(t)
  }
  for (const s of remaining) dropped.push({ id: s.row.id, title: s.row.title, reason: 'k-limit' })
  return { selected, dropped, kBase, kEff, used, pool, weights: diag }
}

/**
 * 跑一次召回。**只在拿得到向量与原生观测时才返回 candidates**；
 * 任何一步失败都返回 `injected=false` + `fallbackReason`，绝不抛（§6.5 降级纪律）。
 */
export async function recall(
  deps: { store: KnowledgeStore; embed: EmbedClient; engine: MemoEngine; dimension: number },
  queryText: string,
  options: RecallOptions,
): Promise<RecallOutcome> {
  const started = Date.now()
  const { store, embed, engine, dimension } = deps
  const empty = (fallbackReason: string, extra?: Partial<RecallOutcome>): RecallOutcome => ({
    injected: false,
    fallbackReason,
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
    elapsedMs: Date.now() - started,
    ...extra,
  })

  if (!queryText.trim()) return empty('empty-query')

  /* ① 查询场向量 + ①b 门控锚向量 —— 一次批量调用（票 01）
   *
   * 原来是 2-3 次**串行单条** embed()（queryField 一次 + 每个可用 gate 锚各一次），
   * 端点单条 RTT 实测 1.19-1.45s（connect 0.4 + TLS 0.8），注入前缀被拉到 2.5-4s+。
   * 合批后 input=[query, gU 锚, gA 锚] 一个请求一次返回；批内每条向量与单条调用
   * 逐位等价（同模型同端点，VCP EmbeddingUtils 本来就按批调用），gate 语义与
   * 日志字段（gateVector/maxKnn/retrievalMaxKnn）不变。
   *
   * 锚准入守卫沿用原 scoreAnchor：空文本、或与查询场同文（同文时 gU≡检索向量，
   * 无判别力，见 config.ts gateOnCurrentMessage 注释）的锚不入场；下标显式回填
   * （guIdx/gaIdx），不用 Map——防 user/assistant 锚同文时键碰撞。
   *
   * 注入专用短超时（embedTimeoutMs）也只罩这一次调用。超时/失败 = 查询向量拿不到，
   * 整体降级 inject-skip（§6.5：嵌入不可达就没有召回可言；验收 #9 的死端点口径不变）。
   * 注：原「查询向量成功 + 锚 embed 失败 → 弃锚退回窗口判定」的部分失败路径随合批
   * 物理消失（单请求全有或全无）——失败已在入口整体归因，不再有中间态。 */
  const trimmedQuery = queryText.trim()
  const batchTexts = [queryText]
  const gateUserAnchor = options.gate ? (options.gateText ?? '').trim() : ''
  const gateAssistantAnchor = options.gate ? (options.gateAssistantText ?? '').trim() : ''
  const guIdx = gateUserAnchor && gateUserAnchor !== trimmedQuery ? batchTexts.push(gateUserAnchor) - 1 : -1
  const gaIdx =
    gateAssistantAnchor && gateAssistantAnchor !== trimmedQuery ? batchTexts.push(gateAssistantAnchor) - 1 : -1
  /* 空库短路提前到 embed 之前（2026-09-28）：① 省一次注定无效的 embed 往返；
   * ② embed 间歇超时窗口下 fallbackReason 语义正确——验收 #11 曾在空库上报
   * embed-timeout 而非 empty-corpus。快照窗口变宽（embed 往返期间的新写入本拍
   * 不可见，下一拍可见）——recall 本就跑在快照语义上，可接受。 */
  const chunks = store.chunks().filter((c) => c.vector !== null)
  if (chunks.length === 0) return empty('empty-corpus')
  let vectors: Float32Array[]
  const embedCallOpts = (options.embedTimeoutMs ?? 0) > 0 ? { timeoutMs: options.embedTimeoutMs } : undefined
  try {
    vectors = await embed.embed(batchTexts, embedCallOpts)
  } catch (e) {
    // 验收 #9：拔掉嵌入 API / 慢端点超预算 → 跳过注入 + 记日志，主流程不受影响。
    // 票 01：超时（embed.ts 已就地打标 embed-timeout 前缀）与其他失败分开归因，
    // 日志 reason 可区分 embed-timeout。
    const msg = str((e as Error)?.message, 'unknown')
    return empty(msg.startsWith('embed-timeout') ? msg : `embed-failed: ${msg}`)
  }
  const queryVector = vectors[0]
  if (!queryVector) return empty('embed-empty')

  /* KNN 基线（决定门控与低基数门限） */
  const owners = store.chunkOwners()
  const knn = chunks
    .map((c) => ({ id: c.id, score: cosine(queryVector, c.vector!.subarray(0, dimension)) }))
    .sort((a, b) => b.score - a.score)
  const knnById = new Map(knn.map((c) => [c.id, c.score]))
  const retrievalMaxKnn = knn[0]?.score ?? 0

  /* ①b 门控判定（与检索窗口解耦）
   *
   * 为什么必须解耦：检索向量是窗口拼接，拼接越长越靠近语料质心，任何查询的 maxKnn 都被抬高。
   * 实测（config.ts inject.gateOnCurrentMessage 注释里有完整数据）：
   *   无关末轮 w1=0.45~0.51 全不过，w2 起 0.57~0.78 全部误通过；
   *   相关末轮 w1=0.6525 已过。
   * 所以门控只拿当前这条用户消息的向量；拿不到就退回检索向量并记录（不阻塞主流程）。
   *
   * 票⑧（2026-09-14 校准）：单用户锚对「继续吧/按你说的来」类短指令是死刑——
   * gU 0.44-0.55 与无关负例重叠，17/17 误杀。判定改为 max(gU, gA)：
   * gA = 最近 ≥150 字助手消息前 1200 字（工作陈述通常在题上，skip 集 gA 0.709-0.881）。
   * 胜选锚进 gateVector，败选锚分值进 diagnostics 取证。 */
  const diagnostics: Record<string, unknown> = {}
  /* 锚向量直接取自 ① 的合批结果（下标回填；-1 = 锚未入场：门控关 / 空文本 / 与查询场同文
   * → null，与原 scoreAnchor 的返回条件一致）。锚的 maxKnn 对全库 chunk 逐条余弦取最大。 */
  const anchorScore = (idx: number): number | null => {
    const vec = idx >= 0 ? vectors[idx] : undefined
    if (!vec) return null
    let m = 0
    for (const c of chunks) {
      const s = cosine(vec, c.vector!.subarray(0, dimension))
      if (s > m) m = s
    }
    return m
  }
  const gU = anchorScore(guIdx)
  const gA = anchorScore(gaIdx)
  // 分锚阈值（票⑧修订）：长文本向语料质心漂移，离题 150+ 字助手陈述的 gA 负例带
  // 0.5384-0.5810（做饭/天气/英文/数学四样本实测）与在题带 0.709-0.881 间隔 ~0.13，
  // 单一 0.55 阈值会把负例整带放进（gA=0.5810 实锤）。助手锚抬到 gateThreshold+0.07。
  const gAThreshold = options.gateThreshold + GATE_ASSISTANT_MARGIN
  diagnostics.gateAssistantThreshold = gAThreshold
  let gateMaxKnn = retrievalMaxKnn
  let gateVector: 'current' | 'assistant' | 'window' = 'window'
  const passUser = gU !== null && gU >= options.gateThreshold
  const passAssistant = gA !== null && gA >= gAThreshold
  if (passAssistant && (gU === null || gA >= gU)) {
    gateMaxKnn = gA
    gateVector = 'assistant'
    diagnostics.gateUserKnn = gU // 败选锚留痕（校准复盘素材）
  } else if (passUser) {
    gateMaxKnn = gU
    gateVector = 'current'
    diagnostics.gateAssistantKnn = gA ?? undefined
  } else if (gA !== null || gU !== null) {
    // 双锚俱在但都不达标：报告较大者（取证），门控仍压制
    if (gA !== null && (gU === null || gA > gU)) {
      gateMaxKnn = gA
      gateVector = 'assistant'
    } else {
      gateMaxKnn = gU!
      gateVector = 'current'
    }
    diagnostics.gateAssistantKnn = gA ?? undefined
    diagnostics.gateUserKnn = gU ?? undefined
  }

  /* ② 门控（§6.3：不达标 → 清空不注入；窗口向量只在双锚俱缺时兜底——旧语义不变） */
  const windowPass = gU === null && gA === null && retrievalMaxKnn >= options.gateThreshold
  if (options.gate && !(passUser || passAssistant || windowPass)) {
    return empty('gate-below-threshold', {
      gate: { passed: false, maxKnn: gateMaxKnn, threshold: options.gateThreshold, enabled: true, gateVector, retrievalMaxKnn },
      candidateCount: knn.length,
      diagnostics: { ...diagnostics, maxKnn: gateMaxKnn, retrievalMaxKnn, gateVector, gateThreshold: options.gateThreshold },
    })
  }

  /* ③ 原生观测（runMemoPipeline）+ ④ 读出（topology_v3 / rivermemo / dtsc）
   *
   * 整段**必须**待在 `engine.runExclusive` 临界区里：Rust 侧 memo runtime 只认一个活动代际，
   * 两个会话并发召回时若把 `ensureArtifact` 与 `runPipeline` 交错，先建好的 sig 会被
   * 后一次重建顶掉，流水线报 `memo runtime artifact <sig> is not the active generation`。
   * 实测症状：串行两会话都注入、并发只注入一个。
   * 临界区只覆盖碰原生的部分；其后的打分/门控/截断/渲染是纯 JS，留在队列外以缩短持锁时间。 */
  let meta: Record<string, unknown> = {}
  let readout: Record<string, unknown> = {}
  let pipelineElapsedMs = 0
  try {
    const observed = await engine.runExclusive(async () => {
      // 临界区内只走 *Locked 变体（锁序纪律：Q2 内不得再拿 Q1，见 native.ts 死锁注释）。
      if (!engine.isLoaded) await engine.loadLocked()
      await engine.ensureArtifactLocked()
      const pipe = await engine.runPipeline(
        options.queryId,
        queryText,
        queryVector,
        options.coreTags ?? [],
        options.ghostTags ?? [],
      )
      const handle = pipe.metadata.observationHandle
      if (typeof handle !== 'string' || !handle) {
        return { meta: pipe.metadata, readout: {}, elapsedMs: pipe.elapsedMs, missingHandle: true }
      }

      const cands = knn.map((c) => ({ id: c.id, score: c.score }))
      let out: Record<string, unknown> = {}
      if (options.mode === 'dtsc' || options.mode === 'topology_v3' || options.mode === 'rivermemo') {
        out =
          options.mode === 'dtsc'
            ? await engine.rerankDtsc(handle, { epa: pipe.metadata.epa ?? {}, pyramid: pipe.metadata.pyramid ?? {} }, cands)
            : await engine.rerankTopologyV3(options.queryId, queryText, handle, pipe.metadata, cands)
      }
      return { meta: pipe.metadata, readout: out, elapsedMs: pipe.elapsedMs }
    })
    if (observed.missingHandle) {
      return empty('no-observation-handle', { diagnostics: { keys: Object.keys(observed.meta) } })
    }
    meta = observed.meta
    readout = observed.readout
    pipelineElapsedMs = observed.elapsedMs

    const candidates = knn.map((c) => ({ id: c.id, score: c.score }))
    const results: Array<Record<string, unknown>> = Array.isArray(readout.results)
      ? (readout.results as Array<Record<string, unknown>>)
      : []
    // 读出无结果时退回 KNN 基线（tagmemo 模式就是这条）
    const rows: RecallCandidate[] = (results.length > 0
      ? results
      : candidates.map((c): Record<string, unknown> => ({ chunkId: c.id, score: c.score }))
    )
      .map((r) => {
        const id = num(r.chunkId ?? r.id, -1)
        const owner = owners.get(id)
        const chunk = chunks.find((c) => c.id === id)
        const knnScore = knnById.get(id) ?? 0
        const rawScore = num(r.score, knnScore)
        const rewardSuppressed = knnScore < options.minKnnForReward
        const matched = Array.isArray(r.matchedTags) ? (r.matchedTags as unknown[]).map((t) => String(t)) : []
        return {
          id,
          fileId: owner?.fileId ?? -1,
          writtenAt: owner?.writtenAt ?? null,
          title: owner ? titleOf(owner.path) : `D${id}`,
          diaryName: owner?.diaryName ?? '',
          knnScore,
          // §2.2 规则 4：低基数候选不发放结构奖励（把分数还原为 KNN，消除封顶偏置）
          score: rewardSuppressed ? knnScore : rawScore,
          rawScore,
          role: str(r.role, 'unranked'),
          anchorBonus: num(r.anchorBonus),
          topologyBonus: num(r.topologyBonus),
          omega: typeof r.omega === 'number' ? r.omega : null,
          riverRegime: typeof r.riverRegime === 'string' ? r.riverRegime : null,
          matchedTags: matched,
          rewardSuppressed,
          body: chunk?.content ?? '',
        }
      })
      .filter((r) => r.id >= 0)
      .sort((a, b) => b.score - a.score)

    if (rows.length === 0) return empty('no-candidates', { candidateCount: knn.length })

    /* ④.5 票 05：Rust 读出后的**有界 tie-breaker**（options.tieBreaker 缺省/关闭 → applyUsageTieBreaker
       原样返回同一引用，分数与顺序逐位不变）。只认台账**主动**信号，上界 cap=0.05（≪ 锚 0.18），
       只在近似并列处翻序——细节与风险声明见 DESIGN「边界与不承诺」。 */
    const usageLedger = readUsageLedger(store)
    const ranked = applyUsageTieBreaker(rows, usageLedger, options.tieBreaker, started)

    /* ⑤ 条数上限（票 03 自适应 K）+ 动态 K 倍率 + 预算截断（::Truncate：保 role 与首句）
     *
     * 自适应 K：候选池 ≥ ADAPTIVE_K_POOL_FLOOR 时，条数上限从固定 k 抬到
     * clamp(ceil(池×adaptiveKRatio), k, adaptiveKMax)——只升不降；池 <5（稀疏桶）保持
     * 固定 k，旧行为逐位不变。定标依据与回滚开关见 config.ts adaptiveKRatio 注释。
     * **预算绝不让步**：这里只抬「条数上限」，总预算仍由下方逐条 cost 校验兜底
     * （超预算先截首句、再丢 token-budget）——k 再大也装不超 tokenBudget。
     * dynamicK 倍率语义不变：先定基数 kBase，再乘倍率取整（≥1）。 */
    const selection = selectCandidates(ranked, {
      k: options.k,
      dynamicK: options.dynamicK,
      adaptiveKRatio: options.adaptiveKRatio ?? 0,
      adaptiveKMax: options.adaptiveKMax ?? 0,
      tokenBudget: options.tokenBudget,
      selectionWeights: options.selectionWeights,
      ledger: usageLedger,
      now: started,
    })
    const { selected, dropped, kEff, kBase } = selection
    const poolSize = selection.pool
    let used = selection.used

    /* ⑥ 近因保底（recency floor）：k-limit/预算把最近 N 天内的最新日记挤出入选集时，
       给它保留一席——挤掉分数最低席，绝不挤 top1；入选集不足 2 席（唯一位）时不启动。
       新鲜度判据 = 写入时间戳（files.updated_at，毫秒）——标题日期只有天粒度，
       同日平局会按分数序取「最新那天里分数最高的」，把真正最新写的挤掉（2026-09-14 生产实锤：
       3 分钟前刚写的 D19 落选）。时间戳缺失（老数据）退回标题日期。 */
    if ((options.recencyFloorDays ?? 0) > 0 && selected.length >= 2) {
      const stampOf = (r: RecallCandidate): number => r.writtenAt ?? diaryDateMs(r.title)
      const dated = rows.filter((r) => stampOf(r) > 0)
      if (dated.length > 0) {
        const freshest = dated.reduce((a, b) => (stampOf(a) >= stampOf(b) ? a : b))
        const ageMs = Date.now() - stampOf(freshest)
        const floorMs = (options.recencyFloorDays ?? 0) * 86_400_000
        if (ageMs >= 0 && ageMs <= floorMs && !selected.some((s) => s.fileId === freshest.fileId)) {
          /* 挤「分数最低席」：票 04 权重重排后 selected 未必按分数序，末位≠最低分——
             从尾部向前找严格更低分（旧行为=分数序时退化为末位，逐位等价）。 */
          let evictIdx = selected.length - 1
          for (let i = selected.length - 2; i >= 0; i--) {
            if (selected[i]!.score < selected[evictIdx]!.score) evictIdx = i
          }
          const evicted = selected.splice(evictIdx, 1)[0]!
          used -= estimateTokens(evicted.body) + estimateTokens(evicted.title) + 24
          dropped.push({ id: evicted.id, title: evicted.title, reason: 'recency-floor-evicted' })
          const fullCost = estimateTokens(freshest.body) + estimateTokens(freshest.title) + 24
          if (used + fullCost <= options.tokenBudget) {
            selected.push(freshest)
            used += fullCost
          } else {
            const trimmed = firstSentence(freshest.body)
            selected.push({ ...freshest, body: trimmed })
            used += estimateTokens(trimmed) + estimateTokens(freshest.title) + 24
            dropped.push({ id: freshest.id, title: freshest.title, reason: 'truncated-to-first-sentence' })
          }
        }
      }
    }

    // 读出的 Ω 有两种形状：数字，或 {omega, omegaEdge, omegaEmerge, omegaFlow, regime, ...} 观测包
    // （§2.3 的 Ω 公式在 riverObservability 上）。两种都要吃得下。
    let omegaValue: number | null = null
    let regimeValue = ''
    const rawOmega = readout.omega
    if (typeof rawOmega === 'number' && Number.isFinite(rawOmega)) {
      omegaValue = rawOmega
    } else if (rawOmega && typeof rawOmega === 'object') {
      const o = rawOmega as Record<string, unknown>
      if (typeof o.omega === 'number' && Number.isFinite(o.omega)) omegaValue = o.omega
      regimeValue = str(o.regime, '')
    }
    if (!regimeValue) {
      const omegaStats = readout.omegaStats
      if (omegaStats && typeof omegaStats === 'object') regimeValue = str((omegaStats as Record<string, unknown>).regime, '')
    }
    regimeValue = regimeValue || str(readout.regime, '') || rows[0]?.riverRegime || ''

    return {
      injected: selected.length > 0,
      fallbackReason: selected.length === 0 ? 'budget-exhausted' : null,
      gate: {
        passed: true,
        maxKnn: gateMaxKnn,
        threshold: options.gateThreshold,
        enabled: options.gate,
        gateVector: options.gate ? gateVector : 'none',
        retrievalMaxKnn,
      },
      mode: options.mode,
      omega: omegaValue,
      regime: regimeValue || null,
      dynamicK: options.dynamicK,
      candidateCount: rows.length,
      candidates: rows,
      selected,
      dropped,
      diagnostics: {
        ...diagnostics,
        gateVector: options.gate ? gateVector : 'none',
        gateMaxKnn,
        retrievalMaxKnn,
        pipelineElapsedMs,
        // 票 03：选择阶段留痕（inject 日志的 candidates/dropped 之外的口径自检素材）
        kEff,
        kBase,
        adaptivePool: poolSize,
        // 票 04：权重执行留痕（on/recencyBoosted/exposurePenalized/maxPenalty/tagDemotions）
        selectionWeights: selection.weights,
        readoutDiagnostics: readout.diagnostics ?? null,
        /* 票 01（corpus-governance-0926）：查询形态取证。
         * Rust 侧 `query_morphology` 一直随结果序列化（rivermemo_topology_v3.rs:2835，字段见 :2122-2138），
         * 但 TS 只消费了 `queryMode` 字符串 —— 形态**是图拓扑派生的**（logits 由 shallow_energy_ratio /
         * energy_concentration / effective_depth / chainness… 算出，:2088-2100，与查询文本措辞无关），
         * 而 `queryMode == "atomic"` 时 `structural_explanation` 结构性不可达（:2231/:2238）。
         * 透出权重与各分量，才能在**不重建 vexus-lite** 的前提下判读「三级证据为何只到两级」。 */
        queryMode: (readout.queryMode as string | undefined) ?? null,
        queryMorphology: readout.queryMorphology ?? null,
        fieldTrusted: (meta.diagnostics as Record<string, unknown> | undefined)?.fieldTrusted ?? null,
        fieldEntropy: (meta.diagnostics as Record<string, unknown> | undefined)?.fieldEntropy ?? null,
        enhancedVectorCos: 0,
        artifactSig: engine.artifactState?.artifactSig ?? null,
      },
      elapsedMs: Date.now() - started,
    }
  } catch (e) {
    return empty(`native-failed: ${str((e as Error)?.message, 'unknown')}`)
  }
}
