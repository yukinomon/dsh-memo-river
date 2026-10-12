/**
 * src/candidates.ts — retrieval-only 公共候选接口（2B-2b 对外窗口）。
 *
 * 定位：给未来的 vcp 统一融合层（vcp-memo/engine/fusion.mjs，§6 统一候选结构）供源。
 * 本模块**只检索、返回结构化候选，绝不注入**：
 *   · 不调用 renderInjection / createInjectionMessage / renderSkipNotice；
 *   · 不注册任何 agent/pre-step / llm/stream 监听（那是 injector.ts 的活）；
 *   · 不写使用台账（recordUsage 'passive' 的语义是「被注入了才算被动使用」——
 *     river 交候选不等于被采纳，台账必须由 vcp 在最终入选后回写，§5.4/U-9）；
 *   · 不记 Ω 足迹（recordOmega 同属注入侧体检口径）。
 *
 * 失败语义：fetch 永不抛——异常 / 空库 / embed 未配置 / workspace 不可用 /
 * 超硬超时，一律返回空候选 + diagnostics.degraded 里带明确降级标记
 * （degraded: true + reason）。workspace.recall 本身永不抛（workspace.ts:207
 * 「跑一次召回；永不抛」），本模块在其之上补齐调用方侧的降级语义。
 */
import type { Config } from './config.js'
import { openInheritedBuckets } from './workspace.js'
import type { WorkspaceRuntime } from './workspace.js'
import { recall, type RecallCandidate, type RecallOptions, type RecallOutcome } from './recall.js'
import type { ReadoutMode } from './config.js'

/** 候选提供者依赖（与 InjectorDeps 同构：config / getWorkspace / log）。 */
export interface CandidateProviderDeps {
  config: Config
  /** 按 cwd 取工作区运行期（工作区级共享，非会话级）。 */
  getWorkspace(cwd: string): WorkspaceRuntime
  /** 插件级日志（拿不到工作区时的兜底）。 */
  log(level: 'info' | 'warn' | 'error', message: string): void
}

/** 对外交付的单条候选：river 真实能提供的字段，逐条来自 RecallCandidate，不伪造。 */
export interface Candidate {
  /** chunk id（SQLite chunks.id，渲染口径 D<id>）；rank 由此前的排序天然给出。 */
  id: number
  /** chunk 正文（vcp text 的对齐物，§6.1）。 */
  body: string
  /** 本批内名次（0 起；同 outcome.candidates 的有效分数序，去掉自身即 rank）。 */
  rank: number
  /** 来源标记：'river'（融合层 sources 元素的本侧值；srcBucket 存在时带桶名）。 */
  source: 'river'
  /** 桶继承来源（本桶条目缺省无此字段；§6.1 来源标记对齐）。 */
  srcBucket?: string
  title: string
  diaryName: string
  fileId: number
  /** 写入时间戳（files.updated_at 毫秒；老数据 null → 退回标题日期）。 */
  writtenAt: number | null
  /** 纯 KNN 余弦基线（与 vcp score 同量纲，§6.3 riverKnnScore 交叉校验量）。 */
  knnScore: number
  /** 读出后有效分数（已过 minKnnForReward 门限；NOT-COMPARABLE，融合只可用 rank）。 */
  score: number
  rawScore: number
  role: string
  anchorBonus: number
  topologyBonus: number
  omega: number | null
  riverRegime: string | null
  matchedTags: string[]
  rewardSuppressed: boolean
}

/** fetch 返回：候选 + 诊断。 */
export interface CandidateFetchResult {
  candidates: Candidate[]
  diagnostics: {
    /** 降级标记：true = 本批候选为空且因失败/空库/超时降级（永不抛的兑现）。 */
    degraded: boolean
    /** 降级原因（degraded=true 时非空；正常路径为 null）。 */
    reason: string | null
    /** 主桶 outcome 的 fallbackReason 透传（empty-query/empty-corpus/gate-below-threshold/…）。 */
    fallbackReason: string | null
    /** 主桶门控快照（vcp 可据此判定 river 是否认为相关）。 */
    gate: RecallOutcome['gate']
    /** 读出模式与 Ω（trace/事后归因素材，§6.2）。 */
    mode: ReadoutMode
    omega: number | null
    regime: string | null
    /** 本桶路径下的候选池大小（截断前）。 */
    poolSize: number
    /** fetch 实际耗时（ms，含超时截断路径）。 */
    elapsedMs: number
    /** 查询 id（诊断/日志口径）。 */
    queryId: string
  }
}

/** fetch 入参。queryVector 保留位：当前 recall 以文本自嵌，预留给融合层已算好的向量复用。 */
export interface CandidateFetchOptions {
  /** 检索意图文本（自然语言；与 memo_recall 的 query 同口径）。 */
  queryText: string
  /** 预算内条数上限（缺省用 config.inject.k）。 */
  limit?: number
  /** 查询向量保留位（可选；当前管线以文本自嵌，传入不改变行为）。 */
  queryVector?: Float32Array
  /** 工作目录（缺省 process.cwd()，按它定桶）。 */
  cwd?: string
  /** 门控专用文本（当前用户消息本身；缺省=不开门控专用锚）。 */
  gateText?: string
  /** 门控助手锚（票⑧ 口径）。 */
  gateAssistantText?: string
  /** 单次 fetch 硬超时 ms（缺省 5000，与注入路径 embedTimeoutMs 同量级）。 */
  timeoutMs?: number
  /** 查询 id（诊断/日志用；缺省自动生成）。 */
  queryId?: string
}

/** fetch 单次硬超时缺省：融合层按 p95 ≤2500ms 的端到端预算（§7.1 U-11）留出余量。 */
const DEFAULT_FETCH_TIMEOUT_MS = 5_000

/** 组装候选供源路径的召回选项（与 injector.recallOptions 同构，但 gate 默认关——
 *  融合层拿原始候选自己判定，不预设「相关才可见」的被动门控口径；
 *  调用方可经 gateText 显式打开）。 */
function providerRecallOptions(config: Config, opts: CandidateFetchOptions, queryId: string): RecallOptions {
  return {
    mode: config.inject.mode,
    k: Math.max(1, opts.limit ?? config.inject.k),
    tokenBudget: config.inject.tokenBudget,
    dynamicK: 1,
    gate: false,
    gateThreshold: config.inject.gateThreshold,
    minKnnForReward: config.inject.minKnnForReward,
    queryId,
    // gate 关 → recall 内 gateText/gateAssistantText 不入合批（recall.ts 的 guIdx/gaIdx 判定）；
    // 仍透传，供调用方在 timeoutMs 内自行开 gate 的后续演进（当前 gate:false 恒不消费）。
    gateText: opts.gateText ?? '',
    gateAssistantText: opts.gateAssistantText ?? '',
    embedTimeoutMs: opts.timeoutMs ?? config.inject.embedTimeoutMs,
  }
}

/** 从 RecallCandidate 映射为对外候选（字段逐条搬运 + rank 回填；不伪造 ID/分数）。 */
function toCandidate(c: RecallCandidate, rank: number): Candidate {
  return {
    id: c.id,
    body: c.body,
    rank,
    source: 'river',
    ...(c.srcBucket !== undefined ? { srcBucket: c.srcBucket } : {}),
    title: c.title,
    diaryName: c.diaryName,
    fileId: c.fileId,
    writtenAt: c.writtenAt,
    knnScore: c.knnScore,
    score: c.score,
    rawScore: c.rawScore,
    role: c.role,
    anchorBonus: c.anchorBonus,
    topologyBonus: c.topologyBonus,
    omega: c.omega,
    riverRegime: c.riverRegime,
    matchedTags: c.matchedTags,
    rewardSuppressed: c.rewardSuppressed,
  }
}

/** 空结果构造器（degraded 标记的统一口径）。 */
function emptyFetch(
  reason: string,
  extra: Partial<CandidateFetchResult['diagnostics']>,
  started: number,
  queryId: string,
): CandidateFetchResult {
  return {
    candidates: [],
    diagnostics: {
      degraded: true,
      reason,
      fallbackReason: null,
      gate: { passed: false, maxKnn: 0, threshold: 0, enabled: false, gateVector: 'none', retrievalMaxKnn: 0 },
      mode: 'topology_v3',
      omega: null,
      regime: null,
      poolSize: 0,
      elapsedMs: Date.now() - started,
      queryId,
      ...extra,
    },
  }
}

/**
 * 造一个候选提供者。retrieval-only：fetch 只检索并返回结构化候选，绝不注入、
 * 不写台账、不注册事件。永不抛。
 *
 * 并发纪律：不在 withDb 闸内挂起等待——recall 自带工作区串行闸（workspace.ts withDb），
 * 本层只做超时截断（Promise.race），超时后放任底层召回自然收尾（闸语义不受影响）。
 */
export function createCandidateProvider(deps: CandidateProviderDeps): {
  fetch(opts: CandidateFetchOptions): Promise<CandidateFetchResult>
} {
  const { config, getWorkspace, log } = deps
  return {
    async fetch(opts: CandidateFetchOptions): Promise<CandidateFetchResult> {
      const started = Date.now()
      const queryId = opts.queryId ?? `candidates-${Date.now()}`
      const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS)
      try {
        const queryText = (opts.queryText ?? '').trim()
        if (!queryText) return emptyFetch('empty-query', {}, started, queryId)
        const cwd = opts.cwd ?? process.cwd()

        // 工作区不可用（acquireWorkspace 抛错）→ 空候选 + 降级标记。
        let workspace: WorkspaceRuntime
        try {
          workspace = getWorkspace(cwd)
        } catch (e) {
          return emptyFetch(
            `workspace-unavailable: ${String((e as Error)?.message ?? e)}`,
            {},
            started,
            queryId,
          )
        }
        // embed 未配置（resolveEmbed source='none'）→ 召回必走 embed-failed 降级；
        // 提前标注省一次注定失败的 HTTP 往返。
        if (workspace.resolved.source === 'none') {
          return emptyFetch('embed-not-configured', {}, started, queryId)
        }

        // 空库快短路（与 recall.ts 空库口径一致，省 embed 往返）。
        try {
          if (workspace.store.counts().chunks === 0) return emptyFetch('empty-corpus', {}, started, queryId)
        } catch (e) {
          return emptyFetch(
            `store-unavailable: ${String((e as Error)?.message ?? e)}`,
            {},
            started,
            queryId,
          )
        }

        const options = providerRecallOptions(config, opts, queryId)
        // 桶继承（inherit-0928）：主桶 + 父桶同跑（联邦口径与注入路径一致——融合层见到的
        // 候选池必须与「若注入会注入什么」同源，否则融合与既有 recall 行为不可对照）。
        const parents = openInheritedBuckets(workspace, config)
        const run = (async (): Promise<{ outcome: RecallOutcome; parts: Array<{ outcome: RecallOutcome; srcBucket?: string }> }> => {
          const primary = await workspace.recall(queryText, options)
          const parentRuns = await Promise.all(parents.map((p) => p.recall(queryText, options)))
          // 父桶补位：门控放行的 selected 按桶间轮转合并（INHERIT_PER_PARENT_CAP=2 由
          // federate.ts 口径决定；这里 inline 同语义，避免依赖 federate.ts 的台账契约注释）。
          const merged: RecallCandidate[] = [...primary.selected]
          const perParent: RecallCandidate[][] = parentRuns.map((o) =>
            o.injected ? [...o.selected].sort((a, b) => b.score - a.score) : [],
          )
          const perParentCap = 2
          for (let round = 0; round < perParentCap; round++) {
            let progressed = false
            for (const q of perParent) {
              const next = q.shift()
              if (next === undefined) continue
              merged.push({ ...next, srcBucket: next.srcBucket ?? '' })
              progressed = true
            }
            if (!progressed) break
          }
          return { outcome: primary, parts: [{ outcome: primary }, ...parentRuns.map((o) => ({ outcome: o }))] }
        })()

        const timedOut = Symbol('candidates-fetch-timeout')
        const settled = (await Promise.race([
          run,
          new Promise<typeof timedOut>((resolve) => {
            const t = setTimeout(() => resolve(timedOut), timeoutMs)
            t.unref?.()
          }),
        ])) as typeof timedOut | Awaited<typeof run>
        if (settled === timedOut) {
          // 硬超时：放任底层收尾（不 abort——recall 的工作区闸保证收尾安全），交空候选。
          log('warn', `candidates-fetch-timeout queryId=${queryId} timeoutMs=${timeoutMs}`)
          return emptyFetch(`timeout: ${timeoutMs}ms`, {}, started, queryId)
        }

        const { outcome } = settled
        const limit = Math.max(1, opts.limit ?? config.inject.k)
        // 主桶 selected（已过选择循环：k/预算/权重）+ 父桶补位 = 对外交付集。
        // rank 按 outcome.selected 的有效分数序（recall 已 sort），父桶补位接排其后。
        const candidates: Candidate[] = outcome.selected
          .slice(0, limit)
          .map((c, i) => toCandidate(c, i))
        // 父桶补位：仅放行该桶 outcome.injected 的 selected，按桶间轮转合并进交付集。
        const parentPools = parents.length
        if (parentPools > 0) {
          const parts = await Promise.all(parents.map((p) => p.recall(queryText, options)))
          const queues = parts.map((o, i) => ({
            bucket: parents[i]!.paths.bucket,
            pool: o.injected ? [...o.selected].sort((a, b) => b.score - a.score) : [],
          }))
          const perParentCap = 2
          let rank = candidates.length
          outer: for (let round = 0; round < perParentCap; round++) {
            for (const q of queues) {
              const next = q.pool.shift()
              if (next === undefined) continue
              if (candidates.length >= limit) break outer
              candidates.push(toCandidate({ ...next, srcBucket: q.bucket }, rank++))
            }
          }
        }

        const degraded = outcome.selected.length === 0 && parentPools === 0
        const reason = outcome.selected.length === 0 ? outcome.fallbackReason : null
        return {
          candidates,
          diagnostics: {
            degraded,
            reason,
            fallbackReason: outcome.fallbackReason,
            gate: outcome.gate,
            mode: outcome.mode,
            omega: outcome.omega,
            regime: outcome.regime,
            poolSize: outcome.candidateCount,
            elapsedMs: Date.now() - started,
            queryId,
          },
        }
      } catch (e) {
        // 兜底：永不抛（即使上面任何一步漏了防御）。
        const msg = `candidates-fetch-failed: ${String((e as Error)?.message ?? e)}`
        try {
          log('error', msg)
        } catch {
          /* 日志失败不影响降级语义 */
        }
        return emptyFetch(msg, {}, started, queryId)
      }
    },
  }
}
