/**
 * src/daemon.ts — 守护循环（DESIGN.md §8）。
 *
 * ① 资产重建：比对 `artifactSig`，不一致或不存在 → `rebuildMemoArtifact`（失败保留上一代）
 * ② 体检：跑 §7.3 四项，写日志到 `<workspace>/health.log`；超阈值告警
 * ③ 草稿：把 `agent/turn-stopping` 收集的回合摘要写成 `pending/<date>-<slug>.md`（**等确认，不自动入库**）
 * ③b 票06 预审：对 pending/ 只读三态标记（可一键批/需人工/建议丢弃，伴随 .status.json；
 *     垃圾判定先于 Tag 判定；**绝不代批**——D10 机械批准污染教训）
 * ④ 节流与退避：默认 15 分钟一轮；连续失败指数退避；每轮耗时与结果写日志
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.js'
import { candidateReportPath, writeCandidateReport } from './consolidation.js'
import { precheckDrafts, SECTION_RECALLED, SECTION_SUGGESTED, type PrecheckSummary } from './drafts.js'
import { formatHealth, healthReport } from './health.js'
import { excerpt } from './render.js'
import type { PendingDraft } from './session.js'
import { acquireWorkspace } from './workspace.js'
import type { KnowledgeStore } from './store.js'
import type { WorkspaceRuntime } from './workspace.js'

export interface GuardianRound {
  round: number
  at: number
  elapsedMs: number
  ok: boolean
  artifactSig: string | null
  artifactRebuilt: boolean
  health: { components: number; hubRatio: number | null; uncoveredRatio: number; warnings: string[] }
  draftsWritten: number
  /** 票 04：本轮合并候选数（null=检测关闭/空库无从判定；-1=空库）。 */
  mergeCandidates: number | null
  /** 票 06：草稿预审三态计数（null=本轮未跑：maintenance.drafts 关闭或预审前守护轮已失败）。 */
  draftPrecheck: PrecheckSummary | null
  error: string | null
  nextDelayMs: number
}

export interface DaemonOptions {
  config: Config
  workspace: WorkspaceRuntime
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** 注册周期任务；返回 disposer（调用方保证随 fiber 释放）。 */
  setInterval(fn: () => void, ms: number): () => void
  /** 取出并清空待落盘草稿（按工作区过滤由调用方负责）。 */
  takeDrafts(): Array<{ state: { sessionId: string; cwd: string | null }; draft: PendingDraft }>
}

export class WorkspaceDaemon {
  private round = 0
  private consecutiveFailures = 0
  private lastArtifactSig: string | null = null
  /** 票⑥B：artifact 行换代清理的上次执行时刻（0=下轮即执行）。 */
  private lastArtifactGcAt = 0
  /** BUG-0930 回卷 tripwire：上轮 files 行数。memo_delete/merge 也会降，但单轮
   *  无删除操作的净下降 = WAL 回卷信号（genshin-ts 桶 9 篇静默丢失事故）。
   *  保守起见只告警不阻断——真实删除（memo_discard 后 memo_merge 退役）由
   *  当轮 mergeCandidates 上下文佐证，人工判读。 */
  private lastFilesCount: number | null = null
  private timer: (() => void) | null = null
  private running = false

  constructor(private readonly options: DaemonOptions) {}

  get rounds(): number {
    return this.round
  }

  get failures(): number {
    return this.consecutiveFailures
  }

  /** 启动周期任务（幂等）。 */
  start(): void {
    if (this.timer || !this.options.config.maintenance.enabled) return
    const delay = this.nextDelay()
    this.timer = this.options.setInterval(() => {
      void this.runOnce()
    }, delay)
    this.options.log(
      'info',
      `guardian-started bucket=${this.options.workspace.paths.bucket} intervalMs=${delay} healthLog=${this.options.workspace.paths.healthLogPath}`,
    )
  }

  stop(): void {
    this.timer?.()
    this.timer = null
  }

  /** ④ 连续失败指数退避（上限 maxBackoff 倍）。 */
  private nextDelay(): number {
    const base = this.options.config.intervalMs
    const factor = Math.min(this.options.config.maintenance.maxBackoff, Math.pow(2, this.consecutiveFailures))
    return Math.round(base * factor)
  }

  /** 跑一轮守护。永不抛。整段持工作区串行闸（SIGBUS 防护：体检读写与 ensureArtifact 不得交错）。 */
  async runOnce(): Promise<GuardianRound> {
    return this.options.workspace.withDb(() => this.runOnceLocked())
  }

  private async runOnceLocked(): Promise<GuardianRound> {
    const t0 = Date.now()
    const at = t0
    this.round += 1
    const { workspace, log } = this.options
    let artifactSig: string | null = null
    let artifactRebuilt = false
    let error: string | null = null
    let draftsWritten = 0
    let draftPrecheck: PrecheckSummary | null = null

    try {
      /* ① 资产重建 */
      const loaded = await workspace.ensureLoaded()
      if (loaded) {
        const before = workspace.engine.artifactState?.artifactSig ?? null
        const state = await workspace.engine.ensureArtifact()
        artifactSig = state.artifactSig
        artifactRebuilt = before !== state.artifactSig
        this.lastArtifactSig = state.artifactSig
        if (artifactRebuilt) log('info', `guardian artifact-rebuilt sig=${state.artifactSig.slice(0, 24)}… elapsedMs=${state.elapsedMs}`)
      }

      /* ①b artifact 行换代清理（票⑥B：漂移历史行止血——每 schema 只留最新 K 代）。
         注意：必须在 ensureArtifact 之后跑，保证「活跃代」是最新 updated_at 的一行，绝不误删活跃 artifact。 */
      if (
        ARTIFACT_GC_KEEP > 0 &&
        at - this.lastArtifactGcAt >= ARTIFACT_GC_INTERVAL_MS
      ) {
        try {
          const removed = pruneArtifactGenerations(workspace, ARTIFACT_GC_KEEP)
          this.lastArtifactGcAt = at
          if (removed > 0) log('info', `guardian artifact-gc removed=${removed} keep=${ARTIFACT_GC_KEEP}`)
        } catch {
          /* GC 失败静默：表缺失/锁竞争均可能，下轮再试 */
        }
      }

      /* ② 合并候选检测（票 04：冗余三判定 → 报告覆写 candidates/merge-candidates.md） */
      const cons = this.options.config.maintenance.consolidation
      const consOut = cons?.enabled === false
        ? null
        : writeCandidateReport(workspace.store, workspace.paths.bucket, cons!, workspace.paths.root, at)
      if (consOut && consOut.candidates.length > 0) {
        log('info', `guardian merge-candidates=${consOut.candidates.length}/${consOut.checked} 报告=${candidateReportPath(workspace.paths.root)}`)
      }

      /* ③ 四项体检 → health.log（含候选计数行） */
      const report = healthReport(workspace.store, workspace.paths.bucket)
      const line = `[${new Date(at).toISOString()}] round=${this.round} components=${report.components} ` +
        `hub=${report.hub ? `${report.hub.name}:${report.hub.count}/${report.counts.files}` : 'n/a'} ` +
        `omegaMean=${report.omega.mean === null ? 'n/a' : report.omega.mean.toFixed(3)} omegaN=${report.omega.samples} ` +
        `uncovered=${report.uncovered.neverRecalled}/${report.uncovered.files} ` +
        `used=${report.usage ? `${report.usage.everUsed}/${report.usage.files}` : 'n/a'} ` +
        `topUsed=${report.usage?.top[0] ? `D${report.usage.top[0].fileId}×${report.usage.top[0].total}` : 'n/a'} ` +
        `mergeCandidates=${consOut === null ? 'off' : consOut.status === 'empty' ? '无从判定（空库）' : consOut.candidates.length === 0 ? '无候选' : `${consOut.candidates.length}/${consOut.checked}`} ` +
        `warnings=${report.warnings.length}${report.warnings.length ? ` :: ${report.warnings.join(' | ')}` : ''}`
      try {
        mkdirSync(workspace.paths.root, { recursive: true })
        appendFileSync(workspace.paths.healthLogPath, line + '\n')
      } catch {
        /* 体检日志写失败静默 */
      }
      for (const w of report.warnings) log('warn', `guardian-health: ${w}`)

      /* ③b BUG-0930 回卷 tripwire：files 行数净下降 → 高声告警（WAL 回卷/静默删行信号）。 */
      if (this.lastFilesCount !== null && report.counts.files < this.lastFilesCount) {
        log('warn', `guardian-rollback-tripwire: files ${this.lastFilesCount}→${report.counts.files} 净下降（本轮无删除操作时=WAL 回卷信号，检查最近进程重启与 -wal 状态）`)
        try {
          appendFileSync(workspace.paths.healthLogPath, `[${new Date(at).toISOString()}] ROLLBACK-TRIPWIRE files=${this.lastFilesCount}→${report.counts.files}\n`)
        } catch { /* 静默 */ }
      }
      this.lastFilesCount = report.counts.files

      /* ③ 草稿落盘（等确认，不自动入库） */
      if (this.options.config.maintenance.drafts) {
        draftsWritten = this.flushDrafts()
        /* ③b 票06：pending/ 只读预审三态标记（伴随 .status.json，随守护轮刷新）。
         * 红线：预审只分级提示、绝不代批（D10：机械批准曾把空用户+空助手草稿灌进库污染召回）。
         * 失败不拖垮守护轮——下轮自动重试。 */
        try {
          draftPrecheck = await precheckDrafts(workspace, this.options.config.write.dedupCosine)
          if (draftPrecheck.ok + draftPrecheck.manual + draftPrecheck.discard + draftPrecheck.failures > 0) {
            log(
              'info',
              `guardian draft-precheck ok=${draftPrecheck.ok} manual=${draftPrecheck.manual} ` +
                `discard=${draftPrecheck.discard} failures=${draftPrecheck.failures}（只读预审，不代批）`,
            )
          }
        } catch (e) {
          log('warn', `draft-precheck-failed: ${String((e as Error)?.message ?? e)}（下轮自动重试）`)
        }
      }

      this.consecutiveFailures = 0
      const round: GuardianRound = {
        round: this.round,
        at,
        elapsedMs: Date.now() - t0,
        ok: true,
        artifactSig,
        artifactRebuilt,
        health: {
          components: report.components,
          hubRatio: report.hub?.ratio ?? null,
          uncoveredRatio: report.uncovered.ratio,
          warnings: report.warnings,
        },
        draftsWritten,
        mergeCandidates: consOut === null ? null : consOut.status === 'empty' ? -1 : consOut.candidates.length,
        draftPrecheck,
        error: null,
        nextDelayMs: this.nextDelay(),
      }
      log(
        'info',
        `guardian-round=${round.round} ok=1 components=${report.components} artifactRebuilt=${artifactRebuilt} ` +
          `drafts=${draftsWritten} elapsedMs=${round.elapsedMs} nextDelayMs=${round.nextDelayMs}` +
          (draftPrecheck
            ? ` precheck=${draftPrecheck.ok}/${draftPrecheck.manual}/${draftPrecheck.discard}${draftPrecheck.failures ? ` fail=${draftPrecheck.failures}` : ''}`
            : ''),
      )
      return round
    } catch (e) {
      error = String((e as Error)?.message ?? e)
      this.consecutiveFailures += 1
      const round: GuardianRound = {
        round: this.round,
        at,
        elapsedMs: Date.now() - t0,
        ok: false,
        artifactSig,
        artifactRebuilt,
        health: { components: -1, hubRatio: null, uncoveredRatio: 0, warnings: [] },
        draftsWritten,
        mergeCandidates: null,
        draftPrecheck,
        error,
        nextDelayMs: this.nextDelay(),
      }
      log('error', `guardian-round=${round.round} ok=0 error=${error} failures=${this.consecutiveFailures} nextDelayMs=${round.nextDelayMs}`)
      return round
    }
  }

  /** 把收集到的回合草稿写成 pending/<date>-<slug>.md。返回写入篇数。 */
  flushDrafts(): number {
    const { workspace } = this.options
    const drafts = this.options.takeDrafts()
    let written = 0
    for (const { state, draft } of drafts) {
      if (state.cwd) {
        // 只落盘属于本工作区的草稿。归属判据 = **桶 hash**（与 daemonFor 的 takeDrafts 谓词同源）：
        // config.bucket 覆盖或 workspace.json 都会把不同 cwd 映射到同一桶，此时按 cwd 字符串相等
        // 判归属（初版遗留的第二道门）会静默丢草稿——P3-c 实证：draft-collected 在、round drafts=0。
        let own = false
        try {
          own = acquireWorkspace(state.cwd, this.options.config).paths.hash === workspace.paths.hash
        } catch {
          own = false
        }
        if (!own) continue
      }
      try {
        mkdirSync(workspace.paths.pendingDir, { recursive: true })
        const date = new Date(draft.at).toISOString().slice(0, 10)
        const slug = (draft.userText || 'turn').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'turn'
        const file = join(workspace.paths.pendingDir, `${date}-${slug}-t${draft.turn}.md`)
        const body = [
          `# 候选草稿（等确认，未入库）`,
          '',
          `- 会话：${state.sessionId}`,
          `- 回合：${draft.turn} @ ${new Date(draft.at).toISOString()}`,
          `- 桶：${workspace.paths.bucket}`,
          '',
          `## 本轮用户`,
          draft.userText ? excerpt(draft.userText, 600) : '(空)',
          '',
          `## 本轮助手`,
          draft.assistantText ? excerpt(draft.assistantText, 900) : '(空)',
          '',
          `## ${SECTION_RECALLED}`,
          draft.recalledTags.length > 0 ? draft.recalledTags.join(', ') : '(无)',
          '',
          `## ${SECTION_SUGGESTED}`,
          // 票02：落盘时还没有内容判定（kNN 在守护预审里跑）→ 占位符，结果见伴随 .status.json
          '(待守护预审按内容 kNN 判定；结果见本篇旁的 .status.json 的 reusableTags)',
          '',
          `## 相关旧日记`,
          draft.relatedIds.length > 0 ? draft.relatedIds.map((id) => `D${id}`).join(' ') : '(无)',
          '',
          `> 本文件是**草稿**：确认后用 memo_write 显式入库（会走 Tag 校验与枢纽闸门）。`,
        ].join('\n')
        writeFileSync(file, body)
        written += 1
      } catch (e) {
        this.options.log('warn', `draft-write-failed: ${String((e as Error)?.message ?? e)}`)
      }
    }
    return written
  }

  /** 供 memo_stats / 测试查看最近一轮。 */
  get lastArtifactSignature(): string | null {
    return this.lastArtifactSig
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 手动触发一轮（测试用），带互斥。 */
  async triggerManually(): Promise<GuardianRound | null> {
    if (this.running) return null
    this.running = true
    try {
      return await this.runOnce()
    } finally {
      this.running = false
    }
  }

  /** 体检文本（日志/工具共用）。 */
  healthText(): string {
    return formatHealth(healthReport(this.options.workspace.store, this.options.workspace.paths.bucket))
  }
}

/* ────────────── 票⑥B：rivermemo_artifacts 换代清理 ────────────── */

/** 每 schema_version 保留的最新代数（防回滚窗口）。 */
export const ARTIFACT_GC_KEEP = 3
/** 清理最小间隔（低频：一天至多一次）。 */
export const ARTIFACT_GC_INTERVAL_MS = 86_400_000

/**
 * 票⑥B：每 schema_version 只保留 updated_at 最新的 K 代（并列按 artifact_sig 定序保证幂等），
 * 其余删除。漂移窗口期（票⑥A 修复前）每次 sig 变化 INSERT 一行且无清理，生产 23/31 篇语料
 * 积 148/218 行；修复后新库不再堆积，此函数止血历史存量。表不存在（全新库）返回 0。
 * 红线：不碰活跃 artifact（调用时序保证活跃代=最新 updated_at 行）。
 */
export function pruneArtifactGenerations(
  workspace: WorkspaceRuntime,
  keep: number = ARTIFACT_GC_KEEP,
): number {
  const store = workspace.store
  if (keep <= 0 || !storeHasTable(store, 'rivermemo_artifacts')) return 0
  const schemas = store.allRows(
    'SELECT DISTINCT schema_version FROM rivermemo_artifacts',
  ) as Array<{ schema_version: string }>
  let removed = 0
  for (const { schema_version } of schemas) {
    const res = store.run(
      `DELETE FROM rivermemo_artifacts WHERE schema_version = ? AND artifact_sig NOT IN (
           SELECT artifact_sig FROM rivermemo_artifacts
           WHERE schema_version = ? ORDER BY updated_at DESC, artifact_sig ASC LIMIT ?
         )`,
      schema_version,
      schema_version,
      keep,
    )
    removed += Number(res.changes ?? 0)
  }
  return removed
}

function storeHasTable(store: KnowledgeStore, table: string): boolean {
  for (const row of store.allRows("SELECT name FROM sqlite_master WHERE type = 'table'")) {
    if (String((row as { name?: unknown }).name) === table) return true
  }
  return false
}
