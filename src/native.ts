/**
 * src/native.ts — 复用 `/home/h/app/VCPToolBox/rust-vexus-lite` 原生内核。
 *
 * 生产链（与 `VCPToolBox/sandbox/classroom-flow/native.cjs` 逐调用对齐）：
 *   ① `rebuildMemoArtifact(dbPath, {modelSig, effectiveConfig})` → Rust 侧 CSR / 图资产
 *   ② `runMemoPipeline(dbPath, artifactSig, inputJson, qVec, ghostVec)`
 *        → EPA + 残差金字塔 + 门控 + Spike + 向量融合，一次 N-API 提交
 *   ③ `rerankMemoDtsc(...)` 或 `rerankRivermemoTopologyV3(...)` → 读出
 *
 * 一切向量/图/读出计算都在 Rust；本模块只做索引装载与载荷组装。
 *
 * D154 联合路径（上游生产默认范式）：`MemoEngine.executeRiverQuery` 把
 * 「ANN → 合并 → hydrate → 语义去重 → Topology V3」整体交给 Rust 一次 N-API 任务，
 * payload 的 candidates 由 Rust 覆盖；legacy 的 rerankTopologyV3 保留为回退。
 *
 * 回放契约（D193）：artifact 代际由 `artifactSig` 标识，但**配置漂移不总反映在 sig 上能观测的
 * 层面**——故本模块在 TS 侧自算 `configHash`（hashStable(kbm,32)，对齐上游
 * `modules/tagmemoV10/immutable.js:43`），构建时冻结进 `ArtifactState`，三个读出口
 * （runPipeline / rerankDtsc / rerankTopologyV3）每次比对，失配即抛
 * `MEMO_RIVER_REPLAY_MISMATCH`。读出结果带版本戳信封（D160，见 withResultEnvelope）。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { KnowledgeStore } from './store.js'

/* ────────────── 原生绑定形状（照 rust-vexus-lite/index.d.ts） ────────────── */

export interface NativeMemoArtifactBuildResult {
  success: boolean
  artifactSig: string
  sourceArtifactSig: string
  graphGeneration: string
  databaseGeneration: string
  provenanceGeneration: string
  generation: number
  nodeCount: number
  edgeCount: number
  persisted: boolean
  resident: boolean
  elapsedMs: number
}

export interface MemoPipelineResult {
  metadataJson: string
  enhancedVector: Float32Array
}

export interface NativeVexusIndex {
  recoverFromSqlite(dbPath: string, tableType: string, filterDiaryName: string | null): Promise<unknown>
  addBatch(ids: number[], vectors: Float32Array): void
  rebuildMemoArtifact(dbPath: string, inputJson: string): Promise<NativeMemoArtifactBuildResult>
  runMemoPipeline(
    dbPath: string,
    artifactSig: string,
    inputJson: string,
    queryVector: Float32Array,
    ghostVectors: Float32Array,
  ): Promise<MemoPipelineResult>
  rerankMemoDtsc(dbPath: string, artifactSig: string, inputJson: string): Promise<string>
  rerankRivermemoTopologyV3(dbPath: string, artifactSig: string, inputJson: string): Promise<string>
  /** EPA 基底：Rust 侧只读计算（暂存内存）→ publishEpaBasisCache 短写落库。 */
  computeEpaBasis(dbPath: string, clusterCount: number, maxBasisDim: number): Promise<unknown>
  publishEpaBasisCache(dbPath: string): unknown
  /** V7/V9.1 矩阵内生残差预计算。 */
  computeIntrinsicResiduals(
    dbPath: string,
    maxSvdRank?: number | null,
    minNeighbors?: number | null,
    modelSig?: string | null,
    effectiveConfigJson?: string | null,
  ): Promise<unknown>
  /** V8.2 Tag 成对语义距离预计算（增量）。 */
  computePairwiseSimilarities(
    dbPath: string,
    modelSig: string,
    minSimilarity?: number | null,
    fullRebuild?: boolean | null,
  ): Promise<unknown>
  memoRuntimeStats?(): unknown
  clearMemoRuntime?(): void
  stats?(): unknown
}

/** registerDiaryIndex 的返回注册态（实测 2026-10-12，与上游 index.d.ts RegisteredDiaryIndexState 对齐；
 *  generation 是 unregisterDiaryIndex 的必带参数，只能从这里拿）。 */
export interface RegisteredDiaryIndexState {
  diaryName: string
  generation: number
  contentRevision: number
  dimension: number
  totalVectors: number
}

export interface NativeKnowledgeRuntime {
  registerDiaryIndex(diaryName: string, diaryIndex: NativeVexusIndex): RegisteredDiaryIndexState
  /** 实测（2026-10-12 行为探针，vexus-lite.win32-x64-msvc.node）：二参必选（缺省抛 N-API 转换错），
   *  代际不匹配/未注册返回 false，generation ≤ 0 抛错（Rust 侧校验）。 */
  unregisterDiaryIndex?(diaryName: string, expectedGeneration: number): boolean
  listDiaryIndices?(): unknown
  stats?(): unknown
  shutdown?(): void

  /* ── D154 联合查询 ABI（上游生产默认范式）─────────────────────────────────
   *
   * 实测打印 `vexus-lite.win32-x64-msvc.node` 的 NativeKnowledgeRuntime.prototype
   * 共 10 个方法：diaryIndexState / executeRiverQuery / executeRiverQueryHybrid /
   * listDiaryIndices / registerDiaryIndex / searchDiaryIndices /
   * searchDiaryIndicesDeduplicated / shutdown / stats / unregisterDiaryIndex。
   * 形状以 index.d.ts:203/211 与 knowledge_runtime.rs:1051/:1171 为准（实测行号一致）。
   *
   * 联合路径把「多索引 ANN → Chunk ID 合并 → SQLite 批量向量 hydrate → 语义去重
   * → Topology V3」整体搬进 Rust 的一次 N-API 后台任务：river_input_json 里的
   * `candidates` 会被 Rust 覆盖（knowledge_runtime.rs:694-724），JS 侧不再需要
   * 先算 KNN 再整包递进去。返回类型与 rerankRivermemoTopologyV3 一致（JSON 字符串）。
   *
   * 标记 optional：本仓在 vcp 轨用真上游二进制，reimpl 轨（kernel/ 复刻）尚未实现
   * 这两个方法，缺方法时应由调用方显式报「ABI 不可用」而不是 TS 层静默 undefined。
   * 注册但**不接**的方法（searchDiaryIndices / searchDiaryIndicesDeduplicated /
   * diaryIndexState）不入接口——本单不消费，加了反而制造"看起来能用"的假面。 */
  executeRiverQuery?(
    dbPath: string,
    artifactSig: string,
    riverInputJson: string,
    diaryNames: string[],
    query: Float32Array,
    perIndexK: number,
    candidateK: number,
    semanticThreshold: number,
  ): Promise<string>
  /** Native Query Plan V2 变体（supplemental 向量 + BM25/Time 文件候选）。
   *  **本单不接**：本地没有历史分段向量 / Time / BM25 融合输入，登记只为记录 ABI 面。 */
  executeRiverQueryHybrid?(
    dbPath: string,
    artifactSig: string,
    riverInputJson: string,
    diaryNames: string[],
    query: Float32Array,
    supplementalVectors: Float32Array,
    hybridPlanJson: string,
    perIndexK: number,
    candidateK: number,
    semanticThreshold: number,
  ): Promise<string>
}

/** D154 联合查询的调用参数（由 MemoEngine.executeRiverQuery 组装并校验）。 */
export interface RiverJointQueryParams {
  queryId: string
  queryText: string
  observationHandle: string
  queryVector: Float32Array
  /** 管线产出的查询几何状态（与 rerankTopologyV3 的 meta 同源）。 */
  meta: Record<string, unknown>
  /** 每个已注册日记索引取的近邻数（上游 nativeRiverQueryPerIndexK，缺省 300）。 */
  perIndexK?: number
  /** 进入语义去重阶段的候选池上限（上游 nativeRiverQueryCandidateK，缺省 300）。 */
  candidateK?: number
  /** 语义去重阈值（上游 nativeRiverQuerySemanticThreshold，缺省 0.92）。 */
  semanticThreshold?: number
  /** 输出条数上限（上游 options.topK → payload.topK）。 */
  topK?: number
}

/** D163：权限作用域为空时的错误码，对齐上游
 *  `KnowledgeBaseManager.js:2133` 的 `NATIVE_RIVER_QUERY_EMPTY_PERMISSION_SCOPE`。 */
export const RIVERMEMO_EMPTY_PERMISSION_SCOPE = 'NATIVE_RIVER_QUERY_EMPTY_PERMISSION_SCOPE'

/** D154：联合 ABI 不可用（reimpl 轨未实现 executeRiverQuery）。错误码对齐上游
 *  `RiverMemoEngine.js:241-247` 的 `NATIVE_RIVER_QUERY_ABI_UNAVAILABLE`。 */
export const RIVERMEMO_JOINT_ABI_UNAVAILABLE = 'NATIVE_RIVER_QUERY_ABI_UNAVAILABLE'

/** D154：未提供日记作用域。上游对应
 *  `KnowledgeBaseManager.js:2111` / `RiverMemoEngine.js:253` 的
 *  `NATIVE_RIVER_QUERY_EMPTY_DIARY_SCOPE`。 */
export const RIVERMEMO_EMPTY_DIARY_SCOPE = 'NATIVE_RIVER_QUERY_EMPTY_DIARY_SCOPE'

export interface NativeVexusModule {
  VexusIndex: new (dim: number, capacity: number) => NativeVexusIndex
  NativeKnowledgeRuntime?: new (tagIndex: NativeVexusIndex) => NativeKnowledgeRuntime
  VexusWatcher?: unknown
}

const requireFromHere = createRequire(import.meta.url)

/** 加载原生内核——票11 切换面单点（kernel='vcp'：上游 rust-vexus-lite；'reimpl'：本仓 kernel/ 复刻）。 */
export function loadVexus(vcpRoot: string, kernel: string = 'vcp'): NativeVexusModule {
  let entry: string
  if (kernel === 'reimpl') {
    /* kernel/ 在插件根（src|lib 的上一级）；index.js 自带平台候选与装载报错。
     * 与上游同形：CJS require，契约校验同一道（VexusIndex 可构造）。 */
    entry = fileURLToPath(new URL('../kernel/index.js', import.meta.url))
  } else if (kernel === 'vcp') {
    entry = join(vcpRoot, 'rust-vexus-lite')
  } else {
    throw new Error(`native.kernel 未知取值 "${kernel}"（合法：vcp | reimpl）——拒绝静默回退`)
  }
  const mod = requireFromHere(entry) as NativeVexusModule
  if (typeof mod?.VexusIndex !== 'function') throw new Error(`vexus-lite 未导出 VexusIndex: ${entry}`)
  return mod
}

/** 读 rag_params.json 的 KnowledgeBaseManager（rebuildMemoArtifact 的 effectiveConfig）。 */
export function loadKnowledgeBaseManager(vcpRoot: string): Record<string, unknown> {
  const p = join(vcpRoot, 'rag_params.json')
  if (!existsSync(p)) return {}
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { KnowledgeBaseManager?: Record<string, unknown> }
    return parsed.KnowledgeBaseManager ?? {}
  } catch {
    return {}
  }
}

/* ────────────── pipelineConfig（逐字照 native.cjs 的组装） ────────────── */

type Bag = Record<string, unknown>
const bag = (v: unknown): Bag => (v && typeof v === 'object' ? (v as Bag) : {})
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/* ── configHash（D193）：上游 `modules/tagmemoV10/immutable.js:5-48` 的 hashStable 语义 ──
 * Rust 侧 `config_hash = hash_text(serde_json::to_string(effective_config), 32)` 把配置摘要
 * 编进 artifact_sig 的六个输入之一（memo_artifact_builder.rs:778-797），但**不随
 * rebuildMemoArtifact 的返回值回传**（实测 win32 二进制 keys 无 configHash，
 * 上游 index.d.ts:22-35 同）——上游 JS 也是自己算（`_resolveArtifactBuildContext:431`）。
 * 故 TS 侧必须自算，才能把「配置是否变了」当成独立不变量来校验。
 *
 * 与 Rust 的对应关系：serde_json 无 preserve_order feature（两个 Cargo.toml 均无），
 * 序列化 Value::Object 时按键排序，与这里的 `Object.keys().sort()` 同序。
 * 本地只做自校验（与构建时冻结值比对），不要求与 Rust 逐位相同。 */

/** 确定性序列化：递归键排序。形状照上游 stableSerialize，去 Set/Map 分支（KBM 是纯 JSON）。 */
function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value))
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  const obj = value as Bag
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(obj[key])}`)
    .join(',')}}`
}

/** sha256(stableSerialize(v)) 截断到 length（上游 clamp 到 [8,64]）。 */
export function hashStable(value: unknown, length = 32): string {
  const { createHash } = requireFromNodeCrypto()
  const n = Math.max(8, Math.min(64, Number(length) || 32))
  return createHash('sha256').update(stableSerialize(value), 'utf8').digest('hex').slice(0, n)
}

/** 延迟取 node:crypto —— 顶部 import 会改动静依赖面，而本模块只在这一处用。 */
function requireFromNodeCrypto(): typeof import('node:crypto') {
  return requireFromHere('node:crypto') as typeof import('node:crypto')
}

/* ── D160 结果信封版本戳 ──
 * 上游 `RiverMemoEngine.js:476-482` 的结果信封带 6 个版本戳字段，本地裸 JSON 直接透出。
 * 上游 Rust 的 NativeOutput 已带 schema/algorithmVersion/artifactSig/queryId，但 TS 从不读。
 * 这里在 TS 侧补齐**内核未提供**的三个（schema/version/configHash），内核已提供的用
 * `??` 兜底而不覆盖。schema 名与上游同字符串，便于跨端对账。 */
const RESULT_SCHEMA = 'rivermemo-topology-v3-result-v1'
const RESULT_VERSION = 'rivermemo_v1'

export function pipelineConfig(kbm: Record<string, unknown>): Record<string, unknown> {
  const rm = bag(kbm.riverMemo)
  const local = bag(rm.localField)
  const transfer = bag(rm.transferField)
  const support = bag(rm.effectiveSupport)
  const lang = bag(kbm.languageCompensator)
  const source = bag(rm.sourceObservation)
  const activation = kbm.activationMultiplier
  const dynBoost = kbm.dynamicBoostRange
  const coreRange = kbm.coreBoostRange
  // 上游 KBM.js:1434：spikeRouting 读 KBM 顶层（非 riverMemo 子树）；maxEmergentNodes
  // 上游也从 spikeRouting 提取到 PipelineConfig 顶层（KBM.js:1581，Rust SenseConfig 无此字段）。
  const spike = bag(kbm.spikeRouting)
  return {
    baseTagBoost: num(source.baseTagBoost, 0.6),
    coreBoostFactor: num(source.coreBoostFactor, 1.33),
    localAlpha: num(local.alpha, 0.15),
    transferAlpha: num(transfer.alpha, 0.55),
    fieldMaxIterations: Math.max(num(local.maxIterations, 80), num(transfer.maxIterations, 80)),
    localTolerance: num(local.tolerance, 1e-9),
    transferTolerance: num(transfer.tolerance, 1e-9),
    localMassRatio: num(support.localMassRatio, 0.8),
    transferMassRatio: num(support.transferMassRatio, 0.9),
    maxLevels: 3,
    pyramidTopK: 10,
    minEnergyRatio: 0.1,
    layerDecay: 0.7,
    activationMultiplier: Array.isArray(activation) ? activation : [0.5, 1.5],
    dynamicBoostRange: Array.isArray(dynBoost) ? dynBoost : [0.3, 2.0],
    coreBoostRange: Array.isArray(coreRange) ? coreRange : [1.2, 1.4],
    langConfidenceEnabled: true,
    langPenaltyUnknown: num(lang.penaltyUnknown, 0.05),
    langPenaltyCrossDomain: num(lang.penaltyCrossDomain, 0.1),
    deduplicationThreshold: num(kbm.deduplicationThreshold, 0.88),
    // ── 5 键补全（段3 批1b）：上游 KBM.js:1577-1595 同名组装，默认值=Rust 编译默认。
    maxFusionTags: Math.max(1, Math.floor(num(kbm.maxFusionTags, 128))),
    maxEmergentNodes: Math.max(0, Math.floor(num(spike.maxEmergentNodes, 50))),
    techTagThreshold: num(kbm.techTagThreshold, 0.08),
    normalTagThreshold: num(kbm.normalTagThreshold, 0.015),
    spikeRouting: {
      maxSafeHops: num(spike.maxSafeHops, 4),
      baseMomentum: num(spike.baseMomentum, 2),
      firingThreshold: num(spike.firingThreshold, 0.1),
      baseDecay: num(spike.baseDecay, 0.25),
      wormholeDecay: num(spike.wormholeDecay, 0.7),
      tensionThreshold: num(spike.tensionThreshold, 1),
      maxNeighborsPerNode: num(spike.maxNeighborsPerNode, 20),
      returnFlowFactor: num(spike.v91ReturnFlowFactor, 0.15),
      firGamma: num(spike.v91FirGamma, 0.6),
      maxPropagationStates: num(spike.v91MaxPropagationStates, 2000),
    },
  }
}

/* ────────────── Topology V3 配置桥（对齐上游 RiverMemoEngine._nativeConfig:61-134） ────────────── */

/**
 * 标定覆写文件（calibrate-anchor.mjs 写入；缺失=直接回退默认值）。
 * 用 statSync 比对 mtime，标定后改文件无需重启。仅白名单键生效，其余键视为元数据。
 */
const TUNING_PATH = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memo-river', 'topology-tuning.json')
const TUNABLE_KEYS = ['anchorBonusCap'] as const
let tuningCache: { sig: string; cfg: Record<string, number> } | null = null

function loadTuning(): Record<string, number> {
  try {
    const st = statSync(TUNING_PATH)
    const sig = `${st.mtimeMs}:${st.size}`
    if (tuningCache?.sig === sig) return tuningCache.cfg
    const raw = JSON.parse(readFileSync(TUNING_PATH, 'utf8')) as Record<string, unknown>
    const cfg: Record<string, number> = {}
    for (const k of TUNABLE_KEYS) {
      const v = raw[k]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cfg[k] = v
    }
    tuningCache = { sig, cfg }
    return cfg
  } catch {
    return tuningCache?.cfg ?? {}
  }
}

/**
 * 60 条标定值（2026-10-02，见 attribution-6layer / sweep-anchor）：上游默认 0.1 相对
 * 语义分差超重 3~10 倍（R@1 63.3），0.02 为最优平台（76.7）。上游 topologyV3AnchorBonusCap
 * 不直接生效，只能经标定文件或 RIVER_ANCHOR_CAP 覆写——防止上游原值把已验证修复冲掉。
 */
const ANCHOR_CAP_CALIBRATED = 0.02

/** 上游 section → Rust NativeConfig 字段映射；只发显式存在的数值字段，其余走 Rust 编译默认。 */
export function topologyV3Config(kbm: Record<string, unknown>): Record<string, number> {
  const rm = bag(kbm.riverMemo)
  const candidate = bag(rm.candidateSuperset)
  const path = bag(rm.pathGeometry)
  const relative = bag(rm.relativeTopology)
  const omega = bag(rm.riverObservability)
  const anchor = bag(rm.directAnchor)
  const dstc = bag(rm.dstc)
  const cfg: Record<string, number> = {}
  const put = (key: string, v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) cfg[key] = v
  }
  put('queryK', candidate.queryK)
  put('denoisedK', candidate.denoisedK ?? candidate.queryK)
  put('localFieldK', candidate.localFieldK)
  put('transferFieldK', candidate.transferFieldK)
  put('bm25K', candidate.bm25K)
  put('anchorK', candidate.anchorK)
  put('maxUnionCandidates', candidate.maxUnionCandidates)
  put('localWeight', path.localWeight)
  put('transferWeight', path.transferWeight)
  put('directionFloor', path.directionFloor)
  put('closureFloor', path.closureFloor)
  put('semanticNodeThreshold', relative.semanticNodeThreshold)
  put('relativeDistanceTemperature', relative.relativeDistanceTemperature)
  put('reverseDirectionCredit', relative.reverseDirectionCredit)
  put('minimumRiverEdgeFlow', relative.minimumRiverEdgeFlow)
  put('maximumRiverEdges', relative.maximumRiverEdges)
  put('nodeOnlyReliabilityCap', relative.nodeOnlyReliabilityCap)
  put('kappaEdge', omega.kappaEdge)
  put('kappaRatio', omega.kappaRatio)
  put('omegaEpsilon', omega.epsilon)
  put('collapsedThreshold', omega.collapsedThreshold)
  put('sparseThreshold', omega.sparseThreshold)
  put('semanticAnchorThreshold', anchor.semanticThreshold)
  put('semanticAnchorDiscount', anchor.semanticDiscount)
  put('specificityFloor', anchor.specificityFloor)
  put('rarityFloor', anchor.rarityFloor)
  put('reliabilitySeedSaturation', anchor.reliabilitySeedSaturation)
  put('fallbackReliabilityCap', anchor.fallbackReliabilityCap)
  put('topologyBonusCap', dstc.topologyBonusCap)
  put('topologyPathSaturation', dstc.topologyPathSaturation)
  put('conditionalBandwidth', dstc.topologyV2ConditionalBandwidth)
  put('conditionalClosureBandwidth', dstc.topologyV2ClosureBandwidth)
  put('conditionalDirectBandwidth', dstc.topologyV2DirectBandwidth)
  put('minimumPeers', dstc.topologyV2MinimumPeers)
  put('minimumEffectivePeers', dstc.topologyV2MinimumEffectivePeers)
  put('innovationConfidenceZ', dstc.topologyV2InnovationConfidenceZ)
  put('innovationScale', dstc.topologyV2InnovationScale)
  put('omegaGamma', dstc.topologyV3OmegaGamma)
  put('structRoleMinOmega', dstc.topologyV3StructRoleMinOmega)
  put('anchorActivationZ', dstc.topologyV3AnchorActivationZ)
  put('anchorActivationFloor', dstc.topologyV3AnchorActivationFloor)
  put('anchorSaturation', dstc.topologyV3AnchorSaturation)
  put('anchorFrontierContrast', dstc.topologyV3AnchorFrontierContrast)
  put('anchorFrontierAbsFloor', dstc.topologyV3AnchorFrontierAbsFloor)
  const envCap = Number(process.env.RIVER_ANCHOR_CAP)
  cfg.anchorBonusCap =
    Number.isFinite(envCap) && envCap >= 0
      ? envCap
      : loadTuning().anchorBonusCap ?? ANCHOR_CAP_CALIBRATED
  return cfg
}

/* ────────────── 引擎 ────────────── */

export interface MemoEngineOptions {
  vcpRoot: string
  /** 票11：'vcp'（缺省，上游）| 'reimpl'（kernel/ 复刻）。透传 loadVexus。 */
  kernel?: string
  dimension: number
  modelSig: string
  diaryName: string
  store: KnowledgeStore
  /**
   * 工作区级串行闸（SIGBUS 防护，2026-09-28）：native AsyncTask 与 node:sqlite 访问
   * 必须互斥（进程内两份 sqlite 的 fcntl 锁盲区，见 store.ts 注释）。缺省恒等——
   * 独立脚本造的引擎无闸，行为与修复前一致。
   */
  gate?: <T>(fn: () => Promise<T>) => Promise<T>
}

export interface ArtifactState {
  artifactSig: string
  /**
   * D193：构建时冻结的配置摘要（hashStable(this.kbm, 32)，对齐上游
   * `_resolveArtifactBuildContext:431`）。Rust 已把它编进 artifactSig 的六个输入之一，
   * 但**不回传**；TS 侧自算才能把它当独立不变量：读出口每次比对当前 kbm 的摘要，
   * 失配即抛（`assertReplayCompatible`），而不是静默拿旧资产跑新参数。
   */
  configHash: string
  builtAt: number
  elapsedMs: number
  nodeCount: number
  edgeCount: number
  persisted: boolean
  resident: boolean
  sourceElapsedMs?: number
  /**
   * 除图资产外，生产链还依赖三类**派生资产**，rebuildMemoArtifact 本身不产出它们：
   *   · EPA 基底    → computeEpaBasis + publishEpaBasisCache（kv_store.epa_basis_cache）
   *   · 内生残差    → computeIntrinsicResiduals（tag_intrinsic_residuals / _status）
   *   · Tag 成对距离 → computePairwiseSimilarities（tag_pair_similarity / _status）
   * 实测（DESIGN 验收 #8）：缺这三类时读出仍能跑，但近似并列处会翻转名次。
   */
  assets: {
    epaBasis: { ok: boolean; basisCount: number; error: string | null }
    residuals: { ok: boolean; computed: number; skipped: number; error: string | null }
    pairwise: { ok: boolean; stored: number; error: string | null }
  }
}

/**
 * 原生引擎：持有 tag 索引 / 日记索引 / NativeKnowledgeRuntime，并管理 artifact 代。
 * 索引与 artifact 全部是**派生**资产（DESIGN.md §9），可随时从 SQLite 重建。
 */
export class MemoEngine {
  private mod: NativeVexusModule | null = null
  private tagIndex: NativeVexusIndex | null = null
  private diaryIndex: NativeVexusIndex | null = null
  private runtime: NativeKnowledgeRuntime | null = null
  private artifact: ArtifactState | null = null
  private readonly kbm: Record<string, unknown>
  private loadedChunkIds: number[] = []
  /**
   * 原生命令串行化队列（**并发正确性的关键**）。
   *
   * Rust 侧的 memo runtime 只认**一个**活动代际：`rebuildMemoArtifact` 会顶掉上一代，
   * 之后任何拿着旧 `artifactSig` 的 `runMemoPipeline` / `rerank*` 都会被拒：
   * `memo runtime artifact <sig> is not the active generation`。
   * 两个会话同时召回时，A 的 `ensureArtifact` 与 B 的流水线交错，B 的 sig 就作废了——
   * 实测症状是「串行两会话都注入、并发只注入一个」，且失败方的 fallbackReason 正是上面那句。
   *
   * 故：一个工作区一个引擎，引擎内**所有**碰原生的动作（建资产 / 跑流水线 / 读出）
   * 都排进同一条 promise 链，串行执行。队列是 per-engine 的，跨工作区不受影响，
   * 也不引入任何进程级全局状态（DESIGN §5.2 纪律）。
   */
  private queue: Promise<unknown> = Promise.resolve()
  /** 单飞：同一次资产构建被并发请求时只跑一遍（不是每个调用者各建一次）。 */
  private building: Promise<ArtifactState> | null = null
  /** 在飞 native AsyncTask 计数（SIGBUS 防护：>0 时 store 访问被护栏拒绝）。 */
  nativeBusy = 0
  /** 工作区串行闸（缺省恒等——独立脚本造的引擎保持修复前行为）。 */
  private readonly gate: <T>(fn: () => Promise<T>) => Promise<T>

  constructor(private readonly options: MemoEngineOptions) {
    this.kbm = loadKnowledgeBaseManager(options.vcpRoot)
    this.gate = options.gate ?? ((fn) => fn())
  }

  /** native AsyncTask 在飞期间执行 fn——计数器进出严格包裹提交/落定。 */
  private async withNative<T>(fn: () => Promise<T>): Promise<T> {
    this.nativeBusy++
    try {
      return await fn()
    } finally {
      this.nativeBusy--
    }
  }

  /** 把一个临界区排进引擎串行队列。**不可重入**（临界区内部请调用 `*Locked` 变体）。 */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    // 队列本身永不带拒绝态，否则一次失败会毒化后续所有调用
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  get isLoaded(): boolean {
    return this.tagIndex !== null && this.diaryIndex !== null
  }

  get artifactState(): ArtifactState | null {
    return this.artifact
  }

  get runtimeAvailable(): boolean {
    return this.runtime !== null
  }

  /** 载入原生模块 + 重建两个索引（tag 走 recoverFromSqlite，日记走 addBatch）。自闸。 */
  async load(): Promise<void> {
    return this.gate(() => this.loadLocked())
  }

  /** load 的无闸变体——供已在 engine 临界区（runExclusive 体）内的调用方使用。
   *  死锁纪律：持 Q2（engine 队列）时拿 Q1（工作区闸）会与「持 Q1 等 Q2」互喂死锁。 */
  async loadLocked(): Promise<void> {
    const mod = loadVexus(this.options.vcpRoot, this.options.kernel)
    const dim = this.options.dimension
    const store = this.options.store

    const tagIndex = new mod.VexusIndex(dim, 512)
    await this.withNative(() => tagIndex.recoverFromSqlite(store.dbPath, 'tags', null))

    const diaryIndex = new mod.VexusIndex(dim, 128)
    const chunks = store.chunks(this.options.diaryName).filter((c) => c.vector !== null)
    const ids = chunks.map((c) => c.id)
    const flat = new Float32Array(ids.length * dim)
    chunks.forEach((c, i) => flat.set(c.vector!.subarray(0, dim), i * dim))
    if (ids.length > 0) diaryIndex.addBatch(ids, flat)

    this.mod = mod
    this.tagIndex = tagIndex
    this.diaryIndex = diaryIndex
    this.loadedChunkIds = ids

    if (typeof mod.NativeKnowledgeRuntime === 'function') {
      const runtime = new mod.NativeKnowledgeRuntime(tagIndex)
      runtime.registerDiaryIndex(this.options.diaryName, diaryIndex)
      this.runtime = runtime
    } else {
      console.warn('[memo-river] 上游二进制未导出 NativeKnowledgeRuntime，运行时降级为空')
      this.runtime = null
    }
    this.artifact = null
  }

  /**
   * 重新载入原生日记索引 —— **写入之后必须调用**。
   *
   * 事故（实测）：`memo_write` 只重建 artifact，从不刷新本索引。于是写入之后的
   * 每一次召回都跑在一个**空索引**上 —— 日志里 `native-loaded chunkIds=0`，
   * Ω 被压成 `0.010 collapsed`；直到进程重启，`load()` 才第一次读到 4 个向量，
   * Ω 立刻回到 `0.269 sparse`。当时我把 Ω 低归因成「语料太小（4 篇）」，是错的：
   * 参考语料 11 篇能到 0.63，靠的正是启动时就载入了索引。
   *
   * 只重建 diary 索引 + 随之的 runtime；tag 索引与日记写入无关，保持不动
   * （它的 `recoverFromSqlite` 是整库扫描，没必要为一次写入付这个代价）。
   */
  async reloadDiaryIndex(): Promise<void> {
    if (!this.mod) return
    return this.gate(() => this.reloadDiaryIndexLocked())
  }

  /** reloadDiaryIndex 的无闸变体（临界区内用；本体现在不碰 native AsyncTask，纯内存）。 */
  private async reloadDiaryIndexLocked(): Promise<void> {
    if (!this.mod) return
    const mod = this.mod
    const dim = this.options.dimension
    const store = this.options.store

    const diaryIndex = new mod.VexusIndex(dim, 128)
    const chunks = store.chunks(this.options.diaryName).filter((c) => c.vector !== null)
    const ids = chunks.map((c) => c.id)
    const flat = new Float32Array(ids.length * dim)
    chunks.forEach((c, i) => flat.set(c.vector!.subarray(0, dim), i * dim))
    if (ids.length > 0) diaryIndex.addBatch(ids, flat)

    this.diaryIndex = diaryIndex
    this.loadedChunkIds = ids

    if (typeof mod.NativeKnowledgeRuntime === 'function' && this.tagIndex) {
      const runtime = new mod.NativeKnowledgeRuntime(this.tagIndex)
      runtime.registerDiaryIndex(this.options.diaryName, diaryIndex)
      this.runtime = runtime
    }
    // 索引换代 ⇒ 让下一次 ensureArtifact 重新比对，而不是拿旧 artifact 去跑。
    this.artifact = null
  }

  /** 已装载的 chunk id（与库中 chunks 对齐校验用）。 */
  get chunkIds(): readonly number[] {
    return this.loadedChunkIds
  }

  /**
   * ① 建/复用 Rust 侧图资产 + 三类派生资产。
   *
   * `artifactSig` 未变且非 force 时整体跳过（DESIGN §8.1「比对 artifactSig，
   * 不一致或不存在 → rebuild」。三类派生资产只在代际变化时重算）。
   * 任何一步失败都只记录在 `assets.*.error`，**保留上一代**，不抛。
   */
  async ensureArtifact(force = false): Promise<ArtifactState> {
    // 单飞 + 串行：并发调用共享同一次构建，且构建期间不会有别的原生命令插进来。
    if (this.building) return this.building
    const run = this.gate(() => this.runExclusive(() => this.ensureArtifactLocked(force)))
    this.building = run
    try {
      return await run
    } finally {
      if (this.building === run) this.building = null
    }
  }

  /** 队列内的真实构建体。调用方必须已经持有引擎临界区（`runExclusive` 或 `ensureArtifact`）。 */
  async ensureArtifactLocked(force = false): Promise<ArtifactState> {
    if (!this.tagIndex) throw new Error('engine-not-loaded')
    const ti = this.tagIndex
    const configHash = hashStable(this.kbm, 32)
    const input = JSON.stringify({ modelSig: this.options.modelSig, effectiveConfig: this.kbm })
    const t0 = Date.now()
    const result = (await this.withNative(() =>
      ti.rebuildMemoArtifact(this.options.store.dbPath, input),
    )) as NativeMemoArtifactBuildResult
    /* D193：比对的是「六输入摘要」而非只有 artifactSig。Rust 已把 configHash 编进
     * artifactSig（memo_artifact_builder.rs:786-797），此处再显式比一遍是为了让
     * 「配置变了但 sig 未变」这类内核层失配在 TS 侧**显式失败**，而不是静默复用旧资产。 */
    const unchanged = !force && this.artifact?.artifactSig === result.artifactSig && this.artifact?.configHash === configHash
    const dbPath = this.options.store.dbPath
    const modelSig = this.options.modelSig

    const assets: ArtifactState['assets'] = unchanged && this.artifact
      ? this.artifact.assets
      : {
          epaBasis: { ok: false, basisCount: 0, error: null },
          residuals: { ok: false, computed: 0, skipped: 0, error: null },
          pairwise: { ok: false, stored: 0, error: null },
        }

    if (!unchanged || force) {
      // EPA 基底：先只读计算，再短租约发布
      try {
        const epa = (await this.withNative(() => ti.computeEpaBasis(dbPath, 64, 64))) as {
          basisCount?: number
        }
        const published = this.tagIndex.publishEpaBasisCache(dbPath) as { success?: boolean; basisCount?: number }
        assets.epaBasis = {
          ok: published?.success !== false,
          basisCount: published?.basisCount ?? epa?.basisCount ?? 0,
          error: published?.success === false ? 'publish-failed' : null,
        }
      } catch (e) {
        assets.epaBasis = { ok: false, basisCount: 0, error: String((e as Error)?.message ?? e) }
      }
      // 内生残差（V7/V9.1）
      try {
        const res = (await this.withNative(() =>
          ti.computeIntrinsicResiduals(dbPath, null, null, modelSig, null),
        )) as {
          computedCount?: number
          skippedCount?: number
        }
        assets.residuals = { ok: true, computed: res?.computedCount ?? 0, skipped: res?.skippedCount ?? 0, error: null }
      } catch (e) {
        assets.residuals = { ok: false, computed: 0, skipped: 0, error: String((e as Error)?.message ?? e) }
      }
      // Tag 成对语义距离（V8.2，增量）
      try {
        const pair = (await this.withNative(() =>
          ti.computePairwiseSimilarities(dbPath, modelSig, null, false),
        )) as {
          storedCount?: number
        }
        assets.pairwise = { ok: true, stored: pair?.storedCount ?? 0, error: null }
      } catch (e) {
        assets.pairwise = { ok: false, stored: 0, error: String((e as Error)?.message ?? e) }
      }
    }

    const state: ArtifactState = {
      artifactSig: result.artifactSig,
      configHash,
      builtAt: Date.now(),
      elapsedMs: unchanged ? 0 : Date.now() - t0,
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
      persisted: result.persisted,
      resident: result.resident,
      sourceElapsedMs: result.elapsedMs,
      assets,
    }
    this.artifact = state
    return state
  }

  /**
   * D193：回放契约校验。上游 `TagMemoV10Engine.js:1581-1598 assertReplayCompatible` 的本地对位——
   * 逐项比对「查询期配置」与「构建期冻结的配置摘要」，任一失配即抛，**不静默**。
   *
   * 为什么必须做：Rust 把 configHash 编进 artifactSig（内核层已挡配置漂移），但
   * `pipelineConfig(this.kbm)` / `topologyV3Config(this.kbm)` 是**每次调用现映射**的。
   * 一旦 kbm 在 artifact 构建后被改动（配置热更、运行时覆写、未来新入口），
   * 就会出现「图资产是旧配置的、查询参数是新配置的」——结果与新配置不一致且无任何提示。
   * 本方法把这种失配变成可归因的异常（照上游 error 形状：code + mismatches 数组）。
   *
   * 三个读出口（runPipeline / rerankDtsc / rerankTopologyV3）各自调用：它们是三个独立
   * 公有入口，调用方只走其中一个，只堵一处会漏。
   */
  private assertReplayCompatible(): void {
    const art = this.artifact
    if (!art) throw new Error('artifact-not-ready')
    const current = hashStable(this.kbm, 32)
    if (current === art.configHash) return
    const err = new Error(
      `memo-river artifact is not replay-compatible: configHash (built=${art.configHash}, current=${current})`,
    ) as Error & { code?: string; mismatches?: string[] }
    err.code = 'MEMO_RIVER_REPLAY_MISMATCH'
    err.mismatches = ['configHash']
    throw err
  }

  /** ② runMemoPipeline：一次 N-API 提交拿观测包（enhancedVector + observationHandle）。 */
  async runPipeline(
    queryId: string,
    queryText: string,
    queryVector: Float32Array,
    coreTags: string[] = [],
    ghostTags: string[] = [],
  ): Promise<{ metadata: Record<string, unknown>; enhancedVector: Float32Array; elapsedMs: number }> {
    if (!this.tagIndex || !this.artifact) throw new Error('artifact-not-ready')
    this.assertReplayCompatible()
    const ti = this.tagIndex
    const activeSig = this.artifact.artifactSig
    const t0 = Date.now()
    const result = await this.gate(() =>
      this.withNative(() =>
        ti.runMemoPipeline(
          this.options.store.dbPath,
          activeSig,
          JSON.stringify({
            queryId,
            queryText,
            coreTags,
            ghostTags,
            config: pipelineConfig(this.kbm),
          }),
          queryVector,
          new Float32Array(0),
        ),
      ),
    )
    let metadata: Record<string, unknown> = {}
    try {
      metadata = JSON.parse(result.metadataJson || '{}') as Record<string, unknown>
    } catch {
      metadata = {}
    }
    return { metadata, enhancedVector: result.enhancedVector, elapsedMs: Date.now() - t0 }
  }

  /** ③-a DTSC 读出。 */
  async rerankDtsc(
    observationHandle: string,
    queryGeometryState: unknown,
    candidates: Array<{ id: number; score: number }>,
  ): Promise<Record<string, unknown>> {
    if (!this.tagIndex || !this.artifact) throw new Error('artifact-not-ready')
    this.assertReplayCompatible()
    const ti = this.tagIndex
    const activeSig = this.artifact.artifactSig
    const raw = await this.gate(() =>
      this.withNative(() =>
        ti.rerankMemoDtsc(
          this.options.store.dbPath,
          activeSig,
          JSON.stringify({
            dimension: this.options.dimension,
            observationHandle,
            queryGeometryState,
            topK: candidates.length,
            candidates,
            includeTrace: true,
          }),
        ),
      ),
    )
    return withResultEnvelope(parseJsonObject(raw), this.artifact)
  }

  /** ③-b RiverMemo Topology V3 读出（Ω / specificity / rarity 在这条上）。 */
  async rerankTopologyV3(
    queryId: string,
    queryText: string,
    observationHandle: string,
    meta: Record<string, unknown>,
    candidates: Array<{ id: number; score: number }>,
  ): Promise<Record<string, unknown>> {
    if (!this.tagIndex || !this.artifact) throw new Error('artifact-not-ready')
    this.assertReplayCompatible()
    const ti = this.tagIndex
    const activeSig = this.artifact.artifactSig
    const raw = await this.gate(() =>
      this.withNative(() =>
        ti.rerankRivermemoTopologyV3(
          this.options.store.dbPath,
          activeSig,
          JSON.stringify({
            observationHandle,
            dimension: this.options.dimension,
            topK: candidates.length,
            includeTrace: true,
            // 配置桥：rag_params.json（knowledgeBaseManager.riverMemo.*）→ Rust NativeConfig，
            // 对齐上游 RiverMemoEngine._nativeConfig；锚上限另走 env/标定文件/标定值三级。
            config: topologyV3Config(this.kbm),
            // 生产形状见 KnowledgeBaseManager.js:1664：重数据留在 Rust（observationHandle），
            // JS 侧只递空占位场 + 查询几何状态。
            query: { text: queryText, vector: [] },
            queryState: {
              queryId,
              sourceField: [],
              localField: [],
              transferField: [],
              localDomain: { ids: [] },
              transferDomain: { ids: [] },
              queryRiverGraph: meta.queryRiverGraph ?? null,
              sourceObservation: {
                epa: meta.epa ?? {},
                pyramid: meta.pyramid ?? {},
                diagnostics: meta.diagnostics ?? {},
              },
              fieldDiagnostics: { backend: 'vexus-unified-memo-pipeline-handle' },
            },
            candidates,
          }),
        ),
      ),
    )
    return withResultEnvelope(parseJsonObject(raw), this.artifact)
  }

  /**
   * D154：联合路径读出——一次 `executeRiverQuery` 内完成
   * 多索引 ANN → Chunk ID 合并 → 向量 hydrate → 语义去重 → Topology V3。
   *
   * 与 rerankTopologyV3 的分工：legacy 路由 JS 先算 KNN 候选（recall.ts 的 candidatePool）
   * 再整包塞进 payload；联合路由 Rust 自己跑 ANN，payload 的 candidates 被覆盖
   * （knowledge_runtime.rs:694-724），JS 侧只递控制面 + 权限域。
   *
   * D163 权限作用域：`allowedFileIds` 由本引擎的 diaryName 查 files 表得到
   * （对位上游 KnowledgeBaseManager.js:2121-2136 的
   * `SELECT id FROM files WHERE diary_name IN (...)`）。**空域即抛**
   * `NATIVE_RIVER_QUERY_EMPTY_PERMISSION_SCOPE`——fail-closed，不放行「恒可见」。
   * （Rust 侧 `allowed_file_ids` 缺省为空 → `explicit_scope=false` → 不过滤，
   *  见 rivermemo_topology_v3.rs:2654-2655；本地单桶单 agent 场景实际不改变可见集，
   *  本方法补的是闸。）
   *
   * 调用方必须已在引擎临界区内（runExclusive 体），且 artifact 就绪。
   */
  async executeRiverQuery(params: RiverJointQueryParams): Promise<Record<string, unknown>> {
    if (!this.tagIndex || !this.artifact) throw new Error('artifact-not-ready')
    this.assertReplayCompatible()
    const ti = this.tagIndex
    const runtime = this.runtime
    if (!runtime || typeof runtime.executeRiverQuery !== 'function') {
      const err = new Error('NativeKnowledgeRuntime joint River ABI is unavailable') as Error & { code?: string }
      err.code = RIVERMEMO_JOINT_ABI_UNAVAILABLE
      throw err
    }
    const dbPath = this.options.store.dbPath
    const activeSig = this.artifact.artifactSig
    const diaryNames = [...new Set([this.options.diaryName].map((n) => n.trim()).filter(Boolean))]
    if (diaryNames.length === 0) {
      const err = new Error('Native joint River query requires an explicit diary scope') as Error & { code?: string }
      err.code = RIVERMEMO_EMPTY_DIARY_SCOPE
      throw err
    }

    /* D163：权限域 —— 本地是单桶单 diary，一次查询即上游的 IN (?) 单值情形。
     * 复用 store.files(diaryName)（store.ts:155-160），不另写 SQL。 */
    const allowedFileIds = this.options.store
      .files(diaryNames[0])
      .map((f) => Number(f.id))
      .filter((id) => Number.isSafeInteger(id))
    if (allowedFileIds.length === 0) {
      const err = new Error('Native River query resolved an empty file permission scope') as Error & { code?: string }
      err.code = RIVERMEMO_EMPTY_PERMISSION_SCOPE
      throw err
    }

    const queryVector = params.queryVector
    if (queryVector.length !== this.options.dimension) {
      throw new Error(
        `Native River query dimension mismatch: expected ${this.options.dimension}, got ${queryVector.length}`,
      )
    }
    const finalK = Math.max(1, Math.floor(params.topK ?? 8))
    const perIndexK = Math.max(1, Math.floor(params.perIndexK ?? 300))
    const candidateK = Math.max(finalK, Math.floor(params.candidateK ?? 300))
    const semanticThreshold = Math.max(-1, Math.min(1, params.semanticThreshold ?? 0.92))

    /* payload 与 rerankTopologyV3 同构（同一个 run_native 入口、同一 NativeInput），
     * 只多 allowedFileIds 与 candidates 哨兵。candidates 必填（Rust 侧覆盖），
     * 递哨兵而非空数组——与上游 RiverMemoEngine.js:2270 的 `[{id:1,chunkId:1,score:0}]` 一致。 */
    const payload = {
      observationHandle: params.observationHandle,
      dimension: this.options.dimension,
      topK: finalK,
      includeTrace: true,
      config: topologyV3Config(this.kbm),
      query: { text: params.queryText, vector: [] },
      queryState: {
        queryId: params.queryId,
        sourceField: [],
        localField: [],
        transferField: [],
        localDomain: { ids: [] },
        transferDomain: { ids: [] },
        queryRiverGraph: params.meta.queryRiverGraph ?? null,
        sourceObservation: {
          epa: params.meta.epa ?? {},
          pyramid: params.meta.pyramid ?? {},
          diagnostics: params.meta.diagnostics ?? {},
        },
        fieldDiagnostics: { backend: 'vexus-unified-memo-pipeline-handle' },
      },
      candidates: [{ id: 1, chunkId: 1, score: 0 }],
      allowedFileIds,
    }

    const raw = await this.withNative(() =>
      runtime.executeRiverQuery!(
        dbPath,
        activeSig,
        JSON.stringify(payload),
        diaryNames,
        queryVector,
        perIndexK,
        candidateK,
        semanticThreshold,
      ),
    )
    return withResultEnvelope(parseJsonObject(raw), this.artifact)
  }

  statsSnapshot(): unknown {
    try {
      return this.tagIndex?.memoRuntimeStats?.() ?? null
    } catch {
      return null
    }
  }

  dispose(): void {
    try {
      this.runtime?.shutdown?.()
    } catch {
      /* 释放失败静默 */
    }
    this.runtime = null
    this.tagIndex = null
    this.diaryIndex = null
    this.artifact = null
  }
}

/**
 * D160：给读出结果补版本戳。内核已返回的字段不覆盖（`??` 兜底）。
 * `configHash` 一并带上——它是 D193 的诊断出口：消费方看到 sig 相同而 configHash 不同时，
 * 说明这次结果与当前配置不同源（recall.ts 的诊断栏直接可见）。
 */
function withResultEnvelope(raw: Record<string, unknown>, artifact: ArtifactState | null): Record<string, unknown> {
  if (!artifact) return raw
  return {
    ...raw,
    schema: raw.schema ?? RESULT_SCHEMA,
    version: raw.version ?? RESULT_VERSION,
    artifactSig: raw.artifactSig ?? artifact.artifactSig,
    configHash: artifact.configHash,
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {})
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
