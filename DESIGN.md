# dsh-memo-river 设计文档

> 把 VCPToolBox 的 **TagMemo / RiverMemo** 记忆算法接进 DeepSeek Harness，做成一个 agent preset。
> 本文是实现的唯一依据：作者设计原则（逐字引文 + 出处）→ 我们的实测依据 → 运行环境事实 → 架构与全部契约 → 验收标准 → 实施顺序。

---

## 0. 一句话

**被动注入为主干、工具补证、守护维护**：每轮在模型形成回答之前，用当前上下文构造查询场，走 TagMemo/RiverMemo 把相关日记片段注入到消息尾部；写入侧强制"先看见旧 Tag 再续写"；守护循环负责重建派生资产与语料体检。

---

## 1. 作者的设计不变量（**不可违背**，引自 VCPToolBox 文档原文）

| # | 不变量 | 逐字出处 |
|---|---|---|
| 1 | **时机**：注入发生在模型形成回答**之前** | `docs/VCP记忆管理系统.md` §2.1「它把记忆检索放在**模型形成本轮回答之前**：当前上下文先塑造查询场，相关日记再进入模型可见上下文，模型随后才在这些过去的参与下继续理解、回答和行动」 |
| 2 | **范式**：被动优先，主动补证 | 同节「**在我意识到自己需要回忆之前，相关过去已经参与了我正在形成的想法**」；分工：「被动记忆负责'尚未意识到需要回忆时，相关过去已经到场'；主动工具负责'已经形成明确检索意图后，定向核查和补证'」 |
| 3 | **预算**：不是无限记忆 | 同节「VCP 构造的不是'无限记忆'，而是有限 Token、有限 K 和有限计算预算下的**主动上下文**」 |
| 4 | **门控**：不无条件全量注入 | §4.1「`::LastN`…该模式适合小日记本…**大日记本不应无条件全量注入**」；`《《》》`/`::RoleValve` 的门控不过时**占位符被清空，不执行后续检索** |
| 5 | **证据分级**：结构证据必须授权 | 「结构奖励只有在查询河网可观测时才获得相应排序权限」（`VCP记忆管理系统.md:486`）；`experimentArms.js:1206` `omega < structRoleMinOmega && role==='structural_explanation'` → `thematic_neighbor`，理由串 `collapsed-river-structure` |
| 6 | **可观测**：静默即不可接受 | §5.1「未知修饰符可能被忽略，而不是报错，因此**不能通过"没有报错"判断功能已生效**」；原生读出必带 `diagnostics`（`fallbackUsed`/`fallbackReason`/`fieldTrusted`/`fieldEntropy`） |

**语料治理**（同样是硬约束，§3.2/§3.3）：
- Tag 行要「稳定、简洁」；忌同义堆砌、忌整句当 Tag、忌大小写反复横跳。
- **写新日记前必须先看见相关旧日记**，沿用稳定 Tag；只有概念真正变化时才创建新 Tag。
- 正文写清「延续、转折、因果、冲突或完成」，让 Tag 共现有可解释的叙事依据。
- 逐字警告：「若 Agent 完全看不到旧日记…更容易产生**同义 Tag 漂移**…和**孤岛式日记**。此时系统拥有许多'记忆点'，却难以形成可被未来语境稳定唤醒'记忆河流'」。
- 「**不要为了制造拓扑而堆砌无关旧 Tag。河流来自真实经历的延续，不来自标签数量。**」

---

## 2. 我们的实测依据（本机跑出来的，不是推演）

出处：`VCPToolBox/docs/费曼讲义_案例_教室建模_实跑记录.md` §11（原生链）与 §12（三版语料对照）；脚本 `VCPToolBox/sandbox/classroom-flow/`。

### 2.1 三版语料对照（同一算法、同一参数）

| | v0 孤岛 | v1 河流（枢纽 6 篇） | v2 河流均衡（枢纽 4 篇） |
|---|---|---|---|
| Tag 数 / 复用 | 54，**全部只出现 1 次** | 15，每个跨 2–6 篇 | 15，每个跨 2–4 篇 |
| **连通分量** | **11** | **1** | **1** |
| Tag 共现图 | 54 节点/212 边 | 15 节点/80 边 | 15 节点/78 边 |
| 查询 B（因果）JS 完整版 | D5 **D3** D6 | D5 **D6** D2（D6 升到 #2） | D5 **D6** D2 |
| 查询 C（视频）原生 DTSC | 仅 1 篇拿奖励 | **三篇视频日记全 +0.18，其余 8 篇 Δ=0.0000** | 同 v1 |
| 查询 A 奖励候选数 | **1/11**（锐利） | **11/11**（泛化） | 10/11 |

### 2.2 四条设计规则（由实测得出，写进实现）

1. **连通分量必须 = 1**（硬前提）：孤岛语料下「现象→真因」的多跳通路**在数学上不存在**，任何参数都救不回来。
2. **Tag 复用有甜区**：每个 Tag 跨 2–4 篇最佳；**跨 6 篇以上会造出枢纽**，直接锚证据泛化到全部候选，唯一锚的锐度消失。
3. **Ω 不能当语料健康度用**：孤岛图（11 个分量）的 Ω 照样报 0.72–0.90 `dense`——Ω 只看 `边/种子、涌现/种子、流熵` 的**比率**，**不度量连通性**。必须另配体检。
4. **奖励是绝对加分 + 封顶（+0.18）**：低分候选相对涨幅更大（实测 D4 KNN 0.566 +0.18 → 0.746 反超 D6 0.578 → 0.688）。注入侧必须对"低基数候选"设门限。

### 2.3 原生链的行为特征（我们已跑通并验证）

- `applyTagBoostAsync` 生产链：`rebuildMemoArtifact` → `runMemoPipeline` → `rerankMemoDtsc` / `rerankRivermemoTopologyV3`。
- `enhancedVector` 与查询余弦 ≈0.99：**这是设计**（观测包，不是答案），不是缺陷。
- 奖励**稀疏精准**：查询 A 只有 D3 拿到 `anchorBonus≈+0.10`，其余 10 个候选全为 0（对比 JS 兼容轨"人人 +0.03"）。
- 每个候选带 `role`（`direct_answer` / `atomic_concept` / `structural_explanation` / `thematic_neighbor`）、`anchorBonus` 与 `topologyBonus` 分离、`omega`、`riverRegime`、`matchedTags`。
- 单查询 2–7 ms。Ω 实测：A 0.608 dense / B 0.788 dense / C 0.415 sparse。

---

## 3. 运行环境事实（**已逐项实测**，勿再假设）

| 项 | 事实 |
|---|---|
| DSH 进程 Node 版本 | **v26.7.0**（`~/.dsh/3001-restart-*.log` 记录；系统默认 `node -v` 同为 v26.7.0） |
| 原生内核 | `/home/h/app/VCPToolBox/rust-vexus-lite`（我从源码重编过，含 `rebuildMemoArtifact`/`rerankMemoDtsc`/`NativeKnowledgeRuntime`） |
| vexus-lite 在 Node 26 | ✅ **加载成功**（napi-rs / N-API，跨版本 ABI 稳定） |
| 数据库 | 优先 **`node:sqlite`**（Node 内置，实测可用，零依赖）；VCP 的 better-sqlite3 在 Node 26 也可加载，作为备选 |
| 嵌入后端 | `https://api.relayrouter.ai`，模型 `gemini-embedding-2-preview`，**3072 维、模长 1.0**；key 在 `/home/h/app/VCPToolBox/config.env`（`API_URL` / `API_Key`） |
| 嵌入调用形状 | 仓库自带 `EmbeddingUtils.getEmbeddingsBatch(texts,{apiUrl,apiKey})`（URL **不带** `/v1`） |
| 构建链 | `rust-vexus-lite`：`CARGO_HOME=<可写目录> cargo build --release`（约 2m41s，`~/.cargo` 只读），产物 `target/release/libvexus_lite.so` → `vexus-lite.linux-x64-gnu.node` |
| 目录权限 | 插件目录 `/home/h/app/dsh-memo-river`、预设目录 `/home/h/.dsh/.agent-presets` 需宿主级写权限（`dev_*` 工具具备；本会话已放开 danger-full-access） |

---

## 4. 总体架构：三通道

```
                         ┌──────────────────────────────────────────┐
   每个会话回合           │  dsh-memo-river 插件（preset 内挂载）      │
                         └──────────────────────────────────────────┘
   ┌─ 请求前 ────────────────────────────────────────────────────────┐
   │ llm/stream waterfall 拦截（必须 next() 委托，只追加不改写）      │
   │   ① 取本会话最近 N 条消息 → 构造查询场                           │
   │   ② 门控（《《》》语义）：不达标 → 清空，带 fallbackReason        │
   │   ③ 原生召回：runMemoPipeline →(dtsc | topology_v3)              │
   │   ④ 截断到预算（k=3 / 600 token）                                │
   │   ⑤ 追加到【消息尾部】：片段 + role + 锚/拓扑奖励 + Ω + 未注入说明│
   └──────────────────────────────────────────────────────────────────┘
   ┌─ 回合中 ────────────────────────────────────────────────────────┐
   │ 工具：memo_write（写前强制回注旧 Tag）/ memo_recall（主动补证）   │
   │       memo_stats（四项体检）/ memo_tags（词汇表）                 │
   │ systemPrompt.context = 【固定契约文本】（零动态 → 保前缀缓存）    │
   └──────────────────────────────────────────────────────────────────┘
   ┌─ 回合边界 ──────────────────────────────────────────────────────┐
   │ agent/turn-stopping → 只产出【候选草稿】，不落库                  │
   └──────────────────────────────────────────────────────────────────┘
   ┌─ 守护循环（timer，intervalMs）──────────────────────────────────┐
   │ ① 资产重建（artifactSig 比对 → rebuildMemoArtifact）             │
   │ ② 四项体检（连通分量 / 枢纽度 / Ω 分布 / 未覆盖率）→ 日志 + 告警  │
   │ ③ 草稿落盘 pending/*.md（等模型/用户确认，不自动入库）            │
   └──────────────────────────────────────────────────────────────────┘
```

**分层职责**：
- **system 段**：只放固定契约（能力说明 + 写作规范 + 工具用法）。逐轮 hash 必须一致。
- **消息尾**：放动态召回（每轮变化）。**不得**放进 system 段（破坏前缀缓存）。
- **存储**：工作区级 SQLite（VCP schema 子集），单一事实底座；索引与图资产全部是**派生**、可重建。
- **原生**：一切向量/图/读出计算交给 `rust-vexus-lite`，插件只做查询观测 + 一次 N-API 提交 + 注入。

---

## 5. 预设形态（DSH 实现细节）

### 5.1 位置与文件

```
/home/h/.dsh/.agent-presets/memo-river/
├── preset.yml            # 展示元数据
├── agent.cordis.yml      # 组装：列插件/工具/提示词段
└── memo-river.mjs        # 本地插件 wrapper（绝对路径 import 构建产物）
```

`preset.yml`：
```yaml
name: 记忆河流（Memo River）
description: "VCPToolBox TagMemo/RiverMemo 记忆算法接入：每轮被动注入相关日记片段（带 role/Ω 证据分级），写入前强制回注旧 Tag 词汇，守护循环做语料体检（连通性/枢纽度）。"
order: 2
```

`agent.cordis.yml` 关键片段（**本地 `.mjs` 引用是本部署的既有模式**，见 `router-standard-v34` 的 `./router-bootstrap-v34.mjs?v=88`）：
```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config: { text: >- ... }        # 沿用现有预设的人格段

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config: { maxBytes: 65536 }

# ── 记忆河流（本预设的私有能力）──
- id: memo-river
  name: ./memo-river.mjs?v=1
  config:
    workspaceScoped: true
    intervalMs: 900000          # 守护循环 15 分钟
    embed: { apiUrl: '', apiKey: '', model: 'gemini-embedding-2-preview', dimension: 3072 }
    inject: { gate: true, k: 3, tokenBudget: 600, mode: 'topology_v3' }
    native: { vcpRoot: '/home/h/app/VCPToolBox' }
```

`memo-river.mjs`（wrapper，绕开包解析问题）：
```js
export { name, inject, Config, apply } from 'file:///home/h/app/dsh-memo-river/lib/index.js'
```
> `?v=N` 由 `dev_reload_preset` 自动自增做热更新。

### 5.2 约束与坑（来自 `dsh-agent-presets` README）

- preset id 必须匹配 `[a-z0-9][a-z0-9-]*`（会成为目录名）。
- **只有空会话能切换 preset**；创建后按"复制既有 preset"的方式落地（复制 `standard` 或 `closedloop-full` 再改）。
- **service row 必须放在带 `isolate: true` 的组里**，否则发布到 root realm（进程级），第二个会话挂载即冲突。我们的插件只 `inject` 不 `provide`，但仍应放进隔离组以防万一。
- preset 是**受信任配置**（授予其所选插件的能力）。
- 会话共享一份已安装组装 → **插件内的会话状态必须按 session id 键，禁止用全局 `lastXxx`**（作者同款纪律：「禁止依赖可能被并发请求覆盖的全局最近状态」）。

---

## 6. 注入契约（主干，最重要）

### 6.1 system 段固定文本（逐字，**零动态**）

```
本环境有【记忆河流】：VCPToolBox 的 TagMemo/RiverMemo 记忆算法。
· 每轮我在形成回答之前，相关历史日记片段已经进入上下文（被动注入）；片段带 role 字段：
  atomic_concept 是块的固有分类（默认档，可信度须自行判断）/ structural_explanation 是结构推理 /
  thematic_neighbor 仅主题邻近（omega 偏低时由结构档降级而来）/ direct_answer 是锚强度过 frontier 后提升的最高档。
· 工具：memo_recall 主动补证 / memo_write 写日记 / memo_stats 语料体检 / memo_tags 查看 Tag 词汇表 / memo_drafts 草稿队列。
· 写日记规范（来自记忆系统作者）：
  ① 写入前先看本轮已注入的相关旧日记与 memo_tags 的词汇表；
  ② Tag 是**检索锚**不是工作流标签——写内容词（主题/机制/对象/判据）；只有概念真正变化时才创建新 Tag，跨篇 ≥1/3 的枢纽词不再复用；
  ③ 正文写清"延续、转折、因果、冲突或完成"，让 Tag 共现有叙事依据；旁白不是日记——`Compressed 1 block(s), ~2130 tokens reclaimed`、`All committed, tree clean.` 这类工具输出与提交状态不写；
  ④ 召回内容是历史记录而非绝对真理；与当前事实冲突时记录修正和信源；
  ⑤ 不要为了制造拓扑而堆砌无关旧 Tag。河流来自真实经历的延续，不来自标签数量。
  ⑥ 读者是三个月后的自己或接手的兄弟代理：他们只看得到标题与 Tag，正文必须足以恢复决策上下文。
  ⑦ 好例：「因 X 不成立改走 Y，教训是 Z」；坏例：复述任务与输出的流水账。
  ⑧ **把决定性事实（数字、判据、结论、命令）放在正文开头**：被动召回只投喂每条开头约 800 字，memo_recall 默认更只给 120 字；埋在「因果链」中段的数字等于没写。先给结论与数字，再展开过程与理由。
· 草稿：守护循环把回合摘要自动存为待确认草稿；用户说「看草稿/批准/丢弃」时，用 memo_drafts 列队、memo_approve 一键批准入库（Tag 只复用既有词汇）、memo_discard 丢弃。
· 原则：被动注入给线索，细节用 memo_recall 深挖；不确定时先验证再下结论。
```

> ⚠️ 该段文本**编译期常量**，运行时不得拼接任何变量（含日期、计数、Ω 值）。

#### 6.1.1 role 字段的**可达性**（2026-09-26 实测，票 01 / corpus-governance-0926）

契约段描述了四个 role，但实现上只有两个能出现——**这不是 bug，是形态闸门的语义**：

- `role` 由 `queryMode` 决定：`rivermemo_topology_v3.rs:2231` `direct_answer = mode != "atomic" && …`、
  `:2238` `mode == "atomic"` ⇒ `atomic_concept`（后段只可能把它晋升成 `direct_answer`，或把
  `structural_explanation` 降级成 `thematic_neighbor`）。**atomic 模式下 `structural_explanation`
  结构性不可达**。
- `queryMode` **由图拓扑派生，与查询措辞无关**：logits 由 `shallow_energy_ratio` /
  `energy_concentration` / `effective_depth` / `chainness` / `branching` … 算出（`:2088-2100`），
  `confidence = sqrt((1-e^{-nodes/8})(1-e^{-edges/8})) × completeness`（`:2077-2086`），
  `weights = confidence·softmax(logits) + (1-confidence)·[⅓,⅓,⅓]`（`:2109-2113`），
  平局归 atomic（`:2114`）。
- **实测**（`scripts/probe-query-morphology.mjs`，10 种查询形态含 3 种 ≥40 字长句，artifact 29 节点）：
  **10/10 `queryMode=atomic`**，atomicW 0.45–0.58、propW/narrW 0.20–0.33，confidence 0.48–0.87，
  `effectiveDepth` 恒 0.02–0.04 ——观测图始终是**浅星形**，所以 atomic logit 恒胜。
  ⇒ 当前语料规模下实际只会看到 `atomic_concept` 与 `direct_answer` 两种 role。
- 取证通道：`src/recall.ts` 的召回 `diagnostics` 已透出 `queryMode` 与 `queryMorphology`
  （Rust 侧 `NativeOutput.query_morphology` 一直随结果序列化，字段见 `:2122-2138`；此前 TS 只消费了
  `queryMode` 字符串）。要看形态分量，读 `diagnostics.queryMorphology` 即可，**无需重建 vexus-lite**。

### 6.2 尾注入格式（每轮，追加为消息）

```
[记忆河流·被动召回 | 本桶=教室建模归档 | Ω=0.68 dense | mode=topology_v3 | 动态K×1.0]
D5「桌子漂浮：一次因果反转」 role=direct_answer  anchor=+0.100  tags=接触阴影,因果排查
  现象是漂浮，真因是缺接触阴影，不是几何错。
D6「终局报告：六轮盲测 0 误判」 role=thematic_neighbor  topology=+0.006  tags=接触阴影,盲测验收
  R2 0/36、R3 0/18…已修：双圈接触阴影 72 处，暗环 1.36x→1.62x。
[本次未注入 D3：fallbackReason=gate-below-threshold；候选 11 条，截断 8 条]
```

**硬性要求**：
- 给**片段原文**，不是标题列表（注入目的是"让过去参与理解"）。
- 必须带 `role` + 奖励 + `Ω/regime`（证据分级是作者的纪律）。
- 必须带**未注入说明**（不静默）。
- 注入块与用户消息之间用固定分隔符，便于回归测试定位。

### 6.3 门控与预算

| 项 | 默认 | 语义 |
|---|---|---|
| 门控 | **开**（`《《》》` 语义） | 当前上下文与日记本主题相似度不达标 → **清空，不注入**，`fallbackReason=gate-below-threshold`。判定 = `gU@0.55 ∨ gA@0.62`（票⑧ 分锚阈值，详见 §6.5 判决段） |
| gateAssistantAnchor | true | 票⑧ 锚拼接开关：助手锚（最近 >150 字助手消息前 1200 字）参判门控；false 回滚用户锚单选 |
| k | 3 | 条数上限 |
| tokenBudget | 600 | 硬预算，超出按 `::Truncate` 截断（保留 role 与首句） |
| 动态 K 倍率 | 1.0 | `[[本:1.5]]` 语义，**是倍率不是条数** |
| 低基数门限 | 规则 4 | 对 KNN 分数低于阈值（如 0.6）的候选**不发放**结构奖励，避免"低分反超高分的封顶偏置" |
| 模式 | `topology_v3` | 可选 `dtsc`；两者共用同一次 `runMemoPipeline` 观测 |
| autonomousInjectEverySteps | 15 | 自主态节律（0=关）。触发族：回合首发（step=1 或中途新用户输入）/ 压缩事件（新 compactionId 立即重注并绕过同集合去重）/ 步律节拍；步维刷新计数防去重饿死 |
| recencyFloorDays | 7 | 近因保底（0=关）：最近 N 天的最新日记被 k-limit/预算挤出时，挤掉**分数最低席**换入（绝不挤 top1；入选集<2 席不启动；预算仍硬约束） |
| writeNudgeEveryMinutes | 7 | 写入节律提醒·时间锚（ACP nudge 移植，0=关）：**模型主动思考累计**超 N 分钟（llm/stream 流时长逐次累加为 activeMs；工具执行与空闲不计入——2026-09-13 用户拍板口径：空闲一下午回来不该把墙钟欠账一次性触发）且有未入河回合进展 → 提醒（文案「已主动思考 N 分钟未写」）。默认 7（30→15→7：提醒仅两行成本极低，防噪靠闸门不靠拉长冷却）。memo_write 观测/提醒触发即重置 activeMsAnchor——**工程触发，不靠模型承诺** |
| writeNudgeEveryTurns | 2 | 写入节律提醒·汇报轮锚（0=关，2026-09-13 用户经验拍板）：**小轮**=用户一条消息→内部多步工具/思考→实质性汇报收尾（助手正文 ≥400 字，session.ts SUBSTANTIVE_REPORT_CHARS）→回合停。N 个小轮未写日记 → 提醒，兜住快节奏会话（时间锚 7 分钟内连出两轮汇报也该催）。轮锚 = max(lastDiaryWriteTurn, lastWriteNudgeTurn)；聊天式短回合（非实质汇报）不计入。提醒文案带触发理由（「已 N 轮汇报未写」/「距上次写入 N 分钟」） |
| writeNudgeEverySteps | 40 | 写入节律提醒·自主态步锚（0=关，2026-09-13 用户拍板 oneshot 适配）：距上次写入/提醒 ≥N 步 → 提醒。**不依赖 draft**（oneshot 单回合 turn-stopping 永不触发、lastDraftSummary 恒空，步数本身就是进展信号）；交互态长回合同样适用。步号回卷（新回合）从回合起计；触发后四锚同时重置，自主态同回合可再触发 |
| writeNudgeGrowthChars | 50000 | 写入节律提醒·自主态增量锚（0=关）：会话上下文（deriveMessages 全量文本）自锚点累计增长 ≥N **字符** → 提醒（5 万字符 ≈ 2–3 万 token）。与步锚互补——密集工具输出先到增量，稀疏思考先到步数。memo_write 观测点重置全部锚（含字符基线） |

### 6.4 前缀缓存纪律（**回归测试项**）

- `systemPrompt.context` 文本逐轮 byte 级一致；测试：连续两轮取 system 段 hash，必须相等。
- 一切动态内容（召回片段、Ω、计数、时间）**只允许**出现在尾注入里。

### 6.5 触发与并发

- `ctx.on('llm/stream', (options, next) => { ...; return next() })` —— **必须 `next()` 委托**，只在 `next()` 之前追加消息，不改写既有消息。
- 会话状态（cwd、上次注入、回合号）**按 session id 存在 Map 里**；不使用全局变量。
- 注入失败必须降级为"不注入 + 记日志"，绝不阻塞主流程。

**日志可归因契约（2026-09-14 票02，验收 #27/#28）**：`inject` / `inject-skip` 桶日志行一律带 `session=<id>`；`inject` 成功行带 `gate={passed,maxKnn,threshold,gateVector,retrievalMaxKnn}`——校准实验此前只有压制样本分数、拿不到通过样本分布，此为补齐。`write-nudge` 触发行与 `pre-step-inject-failed` 兜底行**必须落桶日志**（workspace logger；`deps.log` 是宿主面，生产实测两处都看不到——票01 的教训），nudge 行带 `session/turn/step/reason`。

**写入节律限流（2026-09-14 票05，用户拍板口径，验收 #24/#29/#30）**：
- **增量锚工具输出封顶**：单次工具输出计入增量锚 = min(实际长度, 本会话截尾均值)；均值 = 最近 ≤20 次工具输出长度去最高/最低 10% 后平均（适应会话形态：浏览器会话均值自然高）；样本 <8 用保守默认 4000 字。助手产出与真实用户消息不封顶。动机：DOM dump 全额计入曾造成 90 秒-2 分钟三连拍（生产实锤）。
- **最小重发间隔 5 分钟**：任何锚不豁免（issue #108 正反馈教训）。
- **digest 现取**：自主态锚（步/增量）的弹药取自最近一条 ≥150 字助手正文首行（观测循环同步维护），不走 turn-stopping 存货；交互态锚仍优先回合摘要。

**压缩后查询锚（2026-09-14 票07，验收 #31）**：压缩事件触发的重注，查询场取**压缩消息之后**的首段真实内容；压缩后无内容退回全窗口。动机（生产实锤）：压缩摘要概括整轮旧主题 → 相似度摊平 → 注入昨日热点、漏掉 3 分钟前刚写的最相关篇。

**门控校准判决（2026-09-14 票04，scripts/probe-gate-calibration.mjs 可复现）**：生产 17 条 gate-skip 全部误杀（短指令 0.44-0.55 死区），纯阈值方案死刑（正带与任务外负带 0.468-0.536 重叠）；**推荐锚拼接 max(gU, gA)@0.55**——误杀 0/17、误放 0/8，分离力全在助手锚（误杀集 gA 0.709-0.881）。实施票：`.scratch/prod-hardening-0914/issues/08`。

**门控锚拼接·分锚阈值（2026-09-14 票⑧ 已落地，验收 #32）**：门控判定 = `gU@0.55 ∨ gA@0.62`（`GATE_ASSISTANT_MARGIN=0.07`，src/recall.ts）。助手锚口径与校准探针一致：最近一条 >150 字助手消息前 1200 字（injector 提取，`gateAssistantAnchor=false` 可回滚到用户锚单选）。**分锚阈值的依据**：长文本向语料质心漂移（与 w≥2 窗口同现象）——离题 150+ 字助手陈述的 gA 负例带 **0.5384-0.5810**（做饭/天气/英文/数学四样本，教室语料实测），落在 0.55 之上，纯 max@0.55 会整带误放；0.62 落负例带上界（0.5810）与在题带下界（0.709）之间。窗口向量兜底语义不变（只在双锚俱缺时参判）。日志：gateVector 新增 `assistant`，败选锚分值进 diagnostics（gateUserKnn/gateAssistantKnn/gateAssistantThreshold）。探针「生产 gU@0.55 ∨ gA@0.62」行：误杀 0/17、误放 0/8。

### 6.6 调参面板（tuning，2026-09-13 用户拍板）

四锚数字（分钟/小轮/步/增量）是用户经验值，须可实时调控。**生效即时**（改 config 活对象 + 求值链每步现读），优于「下次会话生效」。

- **双域**：`preset` 预设级——落盘 `~/.dsh/.agent-presets/memo-river/tuning.json`（apply 时重放进 config，重启存活；mtime 变化会被下次求值自动重读）；`session` 会话级——进程内 Map，仅该会话、随进程消亡（实验旋钮：先单会话试，好用再固化）。优先级 会话 > tuning.json > 代码默认。
- **两个面**：HTTP（webServer exact 路由 `/memo-river/tuning` GET/POST JSON + `/memo-river/tuning/panel` 面板页，同源 fetch、零依赖 HTML）与工具 `memo_tuning`（action=get/set + 四个数值参数，scope 双域）。非法键/越界值拒绝且不落盘。⚠ 面板页 URL 末段是 `panel`，页面内 fetch **必须绝对路径** `/memo-river/tuning…`——首版相对路径 `fetch('tuning')` 被解析成 `/memo-river/tuning/tuning` 404，`load()` 抛错后只剩静态 `.bar`（症状「只见保存+范围选择、无参数行」，2026-09-13 实测）；现 `load().catch` 把失败写进 #msg。
- **GUI 卫星包**：`panel/`（@dsh-external/dsh-memo-tuner）——client-modules 只扫 loader entries，而预设插件是 subtree 挂载进不了 entries，故 GUI 侧由独立小包承载：host 半面纯载体，client 半面（lib/client.js）**v2 相对锚定**（2026-09-13 用户拍板，否掉 v1 右下角浮动按钮）：header 布局是「标题 → 当前预设显示」，client 扫 header 叶子元素文本（匹配 `记忆河流`/`Memo River`/`memo-river`），命中则在该节点右侧插半透明小标「🌊 记忆河流」（仅选中记忆河流预设时出现；MutationObserver+3s 轮询跟随重渲染，锚消失自动移除），点击弹跟随式 iframe → /memo-river/tuning/panel；另暴露 `/memo-river/tuning/active` 探针（?session= 问该会话是否挂载，无参问本进程任一挂载，v2 留作诊断/后备）；由 dsh-market 按纯客户端包自动 shim 挂载（dep + dsh.client、无 dsh.bundle ⇒ boot 时写 .dsh-market hot shim）；禁止再给它加 patch insert 行，否则与 shim 撞车、开机报 multiple active Loader sources。⚠ `ctx.effect(fn)` 把 fn **返回值**当清理函数——注册路由须写 `ctx.effect(() => () => {...})`，写成 `() => { d1(); d2() }` 会当场注销（2026-09-13 实测 404 事故）。
- **键面**：`TUNING_SPEC`（src/tuning.ts）是唯一键清单，面板/工具/校验同源；扩键只加一处。
- inject 声明含 `webServer`（无该服务的环境走守卫降级，不注册路由不崩）。

---

## 7. 工具契约

### 7.1 `memo_write` —— 把 §3.3 闭环做成**硬契约**

参数：`content`(必填，正文，末尾可含 Tag 行)、`tags`(建议)、`title`、`date`、`folder`(=工作区桶)

执行顺序（**不可省略**）：
1. **回注**：现有 Tag 词汇表（按频次 top 30）+ 语义相关旧日记 3 条 + 体检警告（当前连通分量数 / 是否有 Tag 超过总量 1/3）；
2. **校验**：必须有 `Tag:` 行；单篇 3–5 个 Tag；Tag 名 ≤20 字；不得含同义漂移高风险词（与现有 Tag 余弦 > 0.92 视为同义 → 要求复用）；必须有标题派生源（票 02，2026-09-16：显式 `title` 参数 > 正文首个 `# ` 标题行 > 改写/合并保留篇原标题，三级皆无 → `missing-title` 拒绝——不再自动落「未命名」占位标题；标题取自正文 `# ` 行时该行从写盘全文剥掉，不再重复拼两次）；
2.5. **hub 闸门场景化**（票 06，2026-09-16，详 §7.1.4）：autonomous/delegation 会话写已枢纽化 Tag（桶内跨篇频次 ≥1/3）→ 按 `write.hubGateMode` 档位处理（缺省 1=suggest 放行+观察；2=enforce 硬拒；0=off）；交互会话任何档位都只走第 1 步的软警告；
3. **新 Tag 闸门**：若引入库中不存在的 Tag，必须在参数 `newTagReason` 里给出"概念确实变了"的理由，否则拒绝；
3.5. **内容去重闸门**（写侧对称物 of inject.dedupeSelection）：新日记全文嵌入 vs 本桶既有 chunk 的最大余弦 > `write.dedupCosine`（默认 0.95，定标见 config.ts 注释：合法同话题续写 0.9325 放行 / 逐句重排复读 0.9793 拦截）→ 拒绝并**指认孪生篇**（路径+分数），提示「写增量/转折，或合并进旧篇」。嵌入算一次，入库复用；
4. **写入**：`files`/`file_tags`/`tags`/`chunks` 落库（VCP schema）→ 嵌入 → 索引追加 → 触发 artifact 重建（异步）；
5. **返回**：体检增量（连通分量是否仍为 1、新 Tag 频次、该篇在河中的位置）。

**拒绝条件**（明确报错，不静默）：缺标题派生源（missing-title）/ 缺 Tag 行 / 未确认新 Tag / Tag 超过单篇 5 个 / 与既有 Tag 同义 / 与既有日记正文近重复 / autonomous·delegation 会话写已枢纽化 Tag（hub-tag-scoped，仅 enforce 档）。

### 7.1.1 `memo_update` —— 单篇原地改写（票 02，2026-09-14；兑 3.5「或合并进旧篇」的承诺）

参数：`id`（D 编号）或 `title`（标题子串）**二选一恰好一个** + `content`(必填，新全文) + `tags`/`date`/`folder`/`newTagReason`。

- **目标解析**：`id` 直取；`title` 匹配 chunk `#` 首行或路径，0 命中→提示用 `memo_stats`，多命中→列 ≤8 候选要求用 `id` 重试。
- **与 memo_write 完全同一份闸门**（`writeDiaryCore`，含新 Tag 闸门/同义漂移/枢纽警告/体检增量）——三个入口（write/update/approve）口径只此一份。回注前置段多一行【改写目标】。
- **自排除**：内容去重闸门跳过改写目标自身的旧 chunk（自我改写与原文相近是合法用例）；与其他篇近重复（>dedupCosine）仍拒绝。
- **标题闸门**（票 02，2026-09-16）：新标题派生链 = 新正文首个 `# ` 标题行 > 保留目标原标题（库内标题是强检索信号，改写不降级「未命名」）；目标原标题本身是「未命名」残次品 → `missing-title` 拒绝，须在新正文首行给 `# 新标题`（存量一次性修复指引见 `docs/GUIDE-未命名存量修复.md`）。`memo_merge` keep 模式同口径（保留篇原标题保底；新篇模式无保底）。
- **身份不变**：磁盘**原路径重写**（文件名不换）、库内同路径 upsert → `fileId` 不变 → 票①使用台账足迹随篇保留（改写=同一篇记忆的刷新，不是新记忆）；chunks/file_tags 先删后插（chunkId 会换）。
- **护栏**：目标路径在**工作区根之外**（导入语料常带源库绝对路径，如 VCP dailynote 参照库）→ 只更新库、不写磁盘，日志记 `path-outside-workspace`——工作区写路径永不触碰外部文件。
- **写后顺序**：沿用「先刷原生日记索引、再重建资产」（§7.1 第 4 步），改写后召回立即返回新内容（验收 A-4 实测）。
- 审计：日志留 `memo_update` 行（D-id、路径、checksum 旧→新、新标题）。验收：`scripts/acceptance-update.mjs`（改写本体）+ `scripts/acceptance-title-gate.mjs`（标题闸门）。

### 7.1.2 `memo_merge` —— 多篇归一与归档退役（票 03；压缩式遗忘的执行通道）

参数：`sources`（D-id 列表，file/chunk 双口径，≥2）+ `content`（合并后新全文）+ `keep`(可选，D-id) + `tags`/`date`/`folder`/`newTagReason`。

- **两种模式**：缺省 = **新篇模式**（全部源归档，合并篇走 memo_write 新文件路径，archive/ 留全部源文件）；`keep=D-id` = **并入模式**（保留篇走 §7.1.1 upsert，身份/路径/使用台账足迹延续，其余源归档）。
- **归档语义**：源篇退役 = 磁盘 + 库两侧行级清除。磁盘：`.md/.txt` 移入 `archive/`（人可读、保留原 Tag 行）；**源路径在工作区根之外（导入语料带源库绝对路径）→ 原文复制归档、源文件不动**（与 §7.1.1 护栏同源）。库：`chunks`/`file_tags`/`files` 行删除——召回不再命中；使用台账（§7.3 ⑤）同步清扫源篇条目（强化足迹随篇消亡，不被继承）。
- **溯源规范**：正文自动落 `> 合并自 D…, D…（日期 退役归档，原文见 archive/）`；调用方自带含「合并自」的正文则尊重原文。溯源行是历史文本：D 编号在后续库演进中可能因行删除而复用（SQLite rowid 无 AUTOINCREMENT），溯源以 archive/ 原文为准。
- **去重豁免只对声明源**（`exemptFileIds`）：合并文与声明源近重复是合法用例；与未声明第三篇余弦 > dedupCosine 仍拒绝（验收 M-3 实测 0.9716 拦截）。
- 闸门/回注/体检增量与 memo_write 同一份 `writeDiaryCore`；写后顺序（先刷原生日记索引再重建资产）同 §7.1 第 4 步。
- 验收：`scripts/acceptance-merge.mjs`（M-1..M-6）。

### 7.1.3 合并候选检测（票 04；压缩式遗忘的主引擎，守护循环每轮跑）

**冗余三判定，全部满足才进候选**（按冗余退役，不按时间无差别衰减——老而独特的篇不进候选，天然绕开「永久设定不该被衰减」的分类难题）：

| 判定 | 参数 | 默认 | 定标依据 |
|---|---|---|---|
| ① 年龄 | `maintenance.consolidation.minAgeDays` | **14** | 对齐 §7.3 ⑤ 使用台账的陈旧口径（USAGE_STALE_DAYS=14：14 天未被动用视为陈旧）——年龄与低使用同一把尺 |
| ② 低使用 | `maxRecalls` | **1** | 台账计数（被动+主动，冻结遗留集 ≥1）≤1 = 近未被召回：强化信号缺席的篇才谈退役 |
| ③ 语义覆盖 | `overlapCosine` | **0.90** | 合并带 = 写侧拦截线 dedupCosine=0.95 **之下**、一般同话题续写（实测 ~0.88）**之上**——专抓「没到拦截线但语义已被新篇覆盖」的篇；验收正例实测 0.9270 命中此带 |

- 检测：`src/consolidation.ts` 纯函数 `consolidationCandidates`（守护循环与验收共用一份口径）；理由串带三项判定值（age=X ≥ N；recalls=R ≤ M；overlap=0.xxxx vs 更新篇 D-id ≥ T）。
- 报告：覆写式落 `<workspace>/candidates/merge-candidates.md`（每轮重生成 → memo_merge 执行后**下一轮自动收敛**，不留陈旧报告）。**不落 pending/**：drafts 通道是 Tag 闸门日记专属，报告混入会被 memo_approve 误消费（报告头部已注明「候选建议，勿 approve，用 memo_merge 执行」）。
- 守护接线：`daemon.ts` runOnce ② 步（体检前），health.log 行新增 `mergeCandidates=off|无从判定（空库）|无候选|K/checked`；`GuardianRound.mergeCandidates`（null=关闭，-1=空库）。
- 闭环：票①台账（判定②数据）→ 票③ memo_merge（执行通道）→ 本票检测（建议生产）——「压缩式遗忘」从手动工具升级为守护循环的自动建议流。
- 验收：`scripts/acceptance-consolidation.mjs`（C-1..C-5）。

### 7.1.4 hub 写入闸门场景化（票 06，2026-09-16；子代理防推爆）

**由头**：软警告对无人类在场的会话没有约束力——c9f838ba 一夜 26 子代理写 25 篇把「千星官方课程」推到 21/26=80.8%（health round=27 告警），写侧枢纽警告**全部触发放行**；本仓桶同病（「记忆自驱」等 top3 均 ≥1/3）。与 perf-funnel-0915 票 08 存量手术衔接：手术后本票防复发。

**写侧会话形态（三个信号，任一命中 = autonomous/delegation 会话）**，探明顺序即可信度顺序：
1. `session.header.delegationDepth > 0`——DSH 派发子代理时盖章持久化，写工具的 `exec` 与 injector 的 payload 同源（c9f838ba 的 26 个推爆者全在此列）；
2. `delegationActive` 闩锁（票05 探针）：本会话日志增量出现过委托工具调用且进展未落盘（父侧扇出在飞）；
3. `SessionState.lastInjectMode === 'autonomous'`（本票新增持久化）：injector 每 pre-step 落 `isTurnStart ? 'interactive' : 'autonomous'`——`injectMode=autonomous` 的写侧等价物。全不命中 = 交互会话。

**频次口径**：Tag 的**桶内**跨篇数 / 本桶文件数 ≥ `HUB_RATIO_LIMIT`(1/3)（与体检判据②同一条线；`tagFrequency()` 是跨桶全局口径，多桶共用 sqlite 时会错分母，故写侧单独算）。

**档位** `write.hubGateMode`（preset 级可调：`memo_tuning` / tuning.json / 面板，改完即生效）：

| 档 | 值 | 场景内行为（交互会话任何档都只是软警告） |
|---|---|---|
| off | 0 | 回旧行为：场景内也只软警告（回滚位） |
| suggest | **1（缺省）** | 放行 + 报告带【hub 闸门·观察】段 + 词汇表内替代建议 + `hub-gate-observe` 日志行（先观察后收紧：攒误伤证据再上 enforce） |
| enforce | 2 | **硬拒** `hub-tag-scoped`：拒绝文案带该 Tag 桶内频次与会话形态来源 + 词汇表内替代建议（嵌入可用时按与被拒 Tag 的向量近邻排序，否则桶内高频非枢纽词） |

**豁免**（都有闸门语义依据，不是漏洞）：`memo_merge` 整体豁免——合并把源篇退役归一，净文件数只减不增，是去枢纽的手术工具；`memo_update` 豁免改写目标自身已有的 Tag——该 Tag 跨篇数不 +1，拦它只会阻止修复。覆盖 `memo_write`/`memo_update`/`memo_approve` 三入口（同一份 `writeDiaryCore`；approve 的会话形态按**批准者**算——D10 机械批准污染正是无人把关的批量入库）。

**试运行**（生产桶 6c8bcf85 的 /tmp 副本，2026-09-16，files=70：被动召回 27/70=38.6%、记忆自驱 25/70=35.7%、上游对照 24/70=34.3% 均 ≥1/3）：模拟委托子代理写「记忆自驱」——suggest 档放行+观察段+替代建议（归因错误/写入去重/回合边界依赖/上下文审计/门控校准）；enforce 档 `hub-tag-scoped` 硬拒+带频次的替代建议；同 enforce 档交互会话放行（软警告仍在）。验收：`scripts/acceptance-hub-gate.mjs`（H-1..H-8）。

### 7.2 `memo_recall`

参数：`query`(必填)、`k`、`mode`(`tagmemo`|`rivermemo`|`dtsc`|`topology_v3`)、`rerank`、`truncate`、`timeRange`（`::Time` 语义，如 `2026-09-10~2026-09-11`）、`folder`

返回：候选列表，每条带 `id / title / score / role / anchorBonus / topologyBonus / omega / riverRegime / matchedTags`，并附 `diagnostics`（含 `fallbackUsed/fallbackReason`）。

### 7.3 `memo_stats` —— **四项体检**（补 Ω 的缺口，规则 3）

| 指标 | 判据 | 依据 |
|---|---|---|
| 连通分量数 | **必须 = 1** | 孤岛语料下多跳通路不存在 |
| 最大 Tag 频次 / 总篇数 | **< 1/3** | 枢纽 Tag 会让直接锚泛化 |
| Ω 分布（近 N 次查询） | 报告分布，不只报均值 | Ω 不度量连通性 |
| 未覆盖率（入库但从未被召回） | 报告，>50% 需警告 | 冷启动体检 |

**⑤ 使用台账视图**（2026-09-14，票 01）：每次被动注入（`agent/pre-step`，recall 之后、入选集去重**之前**——去重跳过也算一次召回足迹）与每次 `memo_recall` 主动补证（**只记刻意呈现的 selected**，k 条，与被动同口径；不记 candidates 诊断列表）都按 fileId 记账：`{passive, active, lastPassiveAt, lastActiveAt}`，存 `kv_store` 键 `memo_river.usage_ledger`。视图随体检输出：常用 top5 / 从未使用 / 陈旧（>14 天无足迹）/ legacyOnly。**三条红线**：① 不进打分——召回排序至今不读台账（先跑数据再谈转向，票 05 的前置）；② 只写 kv_store，内容表与图资产零变更——原生内容摘要只吃 tags 向量（lib.rs `SELECT id, vector FROM tags`），kv_store 不是签名输入（验收 U-3：记账前后 tagmemo_artifacts 行逐字节不变）；③ 旧键 `memo_river.recalled_file_ids`（布尔集合）冻结为历史种子只读，「曾被召回」= 台账 ∪ 遗留集。空库时视图报「无从判定（空库）」而非全零假通过。验收：`scripts/acceptance-usage.mjs` 6/6。

> 已知（本票无关的既有行为）：引擎级 composite artifactSig 存在**漂移窗口**——漂移源是 `source_graph_generation`（图边权摘要，memo_artifact_builder.rs:666-679，摘要拼接本身已排序），实测漂移窗口内每次重建该分量都变，而 config_hash / database_generation / provenance_generation 三个分量始终稳定；根因指向权重推导路径的非确定性浮点求和序（生产库同一语料累计出现过 16/25 种 `node_count×edge_count` 图形状变体，说明噪声大到影响过阈值切边）。后果：① 漂移窗口内 `unchanged` 短路永不命中 → builders 每轮重跑（EPA 全量重算只是**症状**，非原因）；② `rivermemo_artifacts` 每次调用插一行死 payload（`ON CONFLICT` 不清旧行，生产实测 23 篇语料积 148 行/754KB、31 篇积 136 行/796KB）。派生缓存齐备后进入冻结态，重建停止（生产 83 守护轮 0 重建）。
>
> **〔2026-09-14 票⑥ 已修复〕**根因=build_transport 三处 HashMap 迭代序 f64 累加（target_inflow 累加序 / raw_rows Vec 序 / total 归一化分母序）+ digest 站点 inbound 累加，全部排序化定序（只定序不改值，VCPToolBox 提交 e1f54b7d）；探针 12/12 跨调用跨进程逐位一致（#33 回归线）。死行由守护轮 ①b `pruneArtifactGenerations` 自动清理（#34）。防御性红线保留：学习态仍不得以 sig 稳定性为键；验收断言仍用 tagmemo_artifacts 行比对。

### 7.4 `memo_tags`

返回按频次排序的 Tag 词汇表（供模型续写时复用）。

### 7.5 草稿消费通道（`memo_drafts` / `memo_approve` / `memo_discard`）

草稿（§8.3）此前只进不出（实测 genshin 桶堆积 17 个）。2026-09-12 拍板的消费方案：

- `memo_drafts`：列 pending/ 草稿（缺省本工作区，`all: true` 扫全部工作区——跨桶清积压）。
- `memo_approve`：一键批准入库。每篇走 `writeDiaryCore`（与 memo_write **同一份** §7.1 闸门，口径不二）；Tag 只复用既有词汇（建议 Tag ∩ 词汇表，3–5 个），**可复用 Tag 不足 3 个的草稿跳过**（待人工 memo_write 撰写）。批准后草稿移入 `approved/`（不删文件，可追溯）。
- `memo_discard`：丢弃（移入 `rejected/`）。
- 草稿定位：`ids`（文件名子串，须唯一命中）或 `all: true`（可加 `bucket` 过滤）。
- 跨工作区打开：草稿所属工作区根的 `workspace.json`（§9）反查 cwd → `acquireWorkspace`。

---

## 8. 守护循环职责（timer）

1. **资产重建**：比对 `artifactSig`，不一致或不存在 → `rebuildMemoArtifact`（失败保留上一代）。
1b. **artifact 行换代清理（票⑥B）**：重建成功后低频（24h 节流）执行 `pruneArtifactGenerations`——每 `schema_version` 按 `updated_at` 保最新 3 代，DELETE 其余；活跃代永不删（调用时序保证活跃代=最新行）；表缺失安全返回 0。漂移历史存量（票⑥A 修复前的死行）由首轮守护自动清空。
2. **体检**：跑 §7.3 四项，写日志到 `~/.dsh/memo-river/<bucket>/health.log`；超阈值在返回值里告警。
3. **草稿**：把 `agent/turn-stopping` 收集的回合摘要写成 `pending/<date>-<slug>.md`（含建议 Tag 与相关旧日记），**等确认，不自动入库**；消费通道见 §7.5（memo_approve 批准入 `approved/`、memo_discard 入 `rejected/`）。turn-stopping 同时记录 `lastDraftSummary`（回合进展摘要，不被消费）——它是**写入节律提醒**的弹药（§6.3 writeNudgeEveryMinutes）：提醒在下一回合 pre-step 注入，把「默默落草稿」升级为「在正确时机主动催促模型写正式日记」。
4. **节流与退避**：默认 15 分钟一轮；连续失败指数退避；每轮耗时与结果写日志。

---

## 9. 数据与存储

- 路径：`~/.dsh/memo-river/<workspace-hash>/knowledge_base.sqlite`（**文件名必须是 `knowledge_base.sqlite`**——原生 IR 用 `dirname(db.name)` 反推）。
- 表：VCP schema 子集（`tags` / `files` / `file_tags` / `chunks` / `kv_store`），DDL 取自 `VCPToolBox/modules/knowledgeBase/schemaManager.js`。
- 向量：3072 维 Float32，`chunks.vector`；Tag 向量在 `tags.vector`。
- 派生资产：图 / CSR / provenance 全部由 `rebuildMemoArtifact` 从库重建，**不单独持久化为真相**。
- 嵌入缓存：`emb-cache.json`（文本 → 向量），重跑不重复消耗额度。

---

## 10. 验收标准（逐条可测）

| # | 判据 | 测法 |
|---|---|---|
| 1 | 注入时机正确 | 构造一次回合，断言注入块出现在**模型请求的消息数组尾部**，且在 assistant 回答之前 |
| 2 | 前缀缓存不破 | 连续两轮，system 段文本 hash 相等（零动态） |
| 3 | 门控生效 | 无关查询（如"今天天气"）→ 不注入，且带 `fallbackReason` |
| 4 | 证据分级透出 | 注入文本含 `role=` 与 `Ω=`/`regime=` |
| 5 | 未注入说明存在 | 有候选被截断时，注入块末行含"本次未注入" |
| 6 | 写入契约 | 无 Tag 行的 `memo_write` → 拒绝；引入新 Tag 未给 reason → 拒绝 |
| 7 | 体检抓孤岛 | 拿我们的**孤岛语料**（54 个一次性 Tag）做回归 → 必须报"连通分量 11"警告 |
| 8 | 与原生直跑一致 | 同一语料 + 同一查询，插件输出与 `sandbox/classroom-flow/native.cjs` 的名次一致（允许 <1e-6 浮点差） |
| 9 | 不阻塞主流程 | 拔掉嵌入 API（断网）→ 注入跳过 + 日志，主流程正常回答 |
| 10 | 并发隔离 | 两个会话同时用，各自注入互不串（按 session id 键） |
| 11 | 闭环捞回 | 空库 → memo_write 写一篇 → 下一轮被动注入把它捞回 |
| 12 | 入选集合去重 | 连续同集合不重复注入（键=id 集合而非块文本） |
| 13 | 截断不吞正文 | 每条入选日记都带正文行（`::Truncate` 路径保 role 与首句） |
| 14 | 草稿消费通道 | 批准入库走 memo_write 同一闸门 + 文件出队；Tag 不足 3 个跳过；丢弃可追溯 |
| 15 | 自主态节律 | 每 N 步重评一次召回，中间步零尝试（用尝试总数证节奏，不假设选集稳定） |
| 16 | 压缩联动 | 新 compactionId 立即重注并绕过同集合去重；同 id 不重复触发 |
| 17 | 步维刷新 | 自主尝试次数达 dedupeRefreshTurns → 强制重注同集合 |
| 18 | 中途新输入 | step>1 带新用户输入按回合首发立即评估；无输入且节律未到零尝试 |
| 19 | 近因保底 | k-limit 挤掉最近日记时保留一席；关掉开关即纯分数序 |
| 20 | 写入节律提醒 | 触发/每回合限流/memo_write 观测重置时钟三段 |
| 21 | 写入去重闸门 | 近重复被拒（near-duplicate-diary+指认孪生）；不同主题放行；dedupCosine=0 关闸放行 |
| 22 | 写入节律·汇报轮锚 | 两轮实质汇报未写 → 提醒；提醒后轮锚重置；聊天回合不触发；memo_write 推进轮锚 |
| 23 | 调参通道（§6.6） | memo_tuning get/set 双域；tuning.json 落盘+config 即时变异；会话级仅该会话生效；evaluateWriteNudge 吃到覆盖值；非法键拒绝不落盘 |
| 24 | 时间锚思考口径 | 空闲墙钟不计入；llm/stream 思考累计达阈值才触发；锚随写入/提醒重置；2 分钟内重发被最小间隔压制 |
| 25 | 近因保底·写入时间戳（票06） | 同日平局由 files.updated_at 决胜；关保底即纯分数序 |
| 26 | 近因保底·退路（票06） | updated_at 置空回退标题日期不劣化不崩溃 |
| 27 | 空桶留痕（票03） | 空语料注入评估留 empty-corpus 行 + session 归因 |
| 28 | 注入日志可归因（票02） | inject 成功行带 session 与 gate 分数块 |
| 29 | 限流三件套（票01/05） | 截尾均值封顶 warm/cold/small；5 分钟最小间隔压/放；write-nudge 行落桶日志 |
| 30 | digest 现取（票05） | 自主态用最近助手实质文本、非陈旧 draft；交互态回合摘要优先 |
| 31 | 压缩后查询锚（票07） | 压缩联动注入选材=压缩后内容而非摘要旧热点；日志带 trigger+session |
| 32 | 门控锚拼接·分锚阈值（票⑧） | 短指令+在题助手陈述 → 放行（gateVector=assistant+败选锚留痕）；gateAssistantAnchor=false 回滚压制；离题长助手陈述仍压制（负例带 0.5384-0.5810 < 0.62） |
| 33 | artifactSig 确定性（票⑥A） | 同库连打 3 次构建 sig 逐位一致 + nodes>0 防空洞；跨进程版=probe-sig-determinism.mjs（12/12，修复前基线 6/6 唯一见 D24） |
| 34 | artifact 行换代清理（票⑥B） | 每 schema 保最新 3 代且留的是 updated_at 最新三行（活跃代永不删）；幂等（二次 0 删除）；runOnce 挂钩触发 guardian artifact-gc 日志行 |

---

## 11. 边界与不承诺（诚实声明）

- **不承诺固定召回率/延迟**（作者原话：「不承诺脱离测试条件的固定召回率」）。
- **小库保守是设计**：`boostFactor` 卡在下限（0.6×0.3=0.18）= 作者写的「在对话逻辑混乱时，几乎完全关闭标签增强，退化为普通向量检索」。
- **Ω 不度量连通性**，所以体检不可省（规则 3）。
- **奖励封顶偏置**尚未在算法内解决，插件侧用"低基数门限"缓解（规则 4）。
- 注入内容**是历史记录而非真理**（作者要求写进契约，§6.1 第 ④ 条）。
- **已知原生风险（2026-09-12 实测）**：node:sqlite 与 Rust 侧 vexus-lite 对同一 `knowledge_base.sqlite` 双开（WAL 模式，`-shm`/`-wal` 共享内存）存在竞态——跨进程累积残留的 WAL 态曾稳定触发 SIGBUS（验收 #6 崩 3/3；抹掉残留后连跑 + 15 连写全绿，与数据规模无关）。缓解：验收 #6/#11/#14 均从零工作区起跑；生产侧规避手段（写前 checkpoint / 串行化双开）待后续轮评估。
- **票 05 tie-breaker 的反馈环风险声明（2026-09-14）**：使用即强化是一个反馈环，天然带三种病——**曝光偏差**（被动注入≠使用，注入多的篇只会更多被注入）、**马太效应**（强者恒强直至锁死）、**自我确证**（召回了所以证明相关所以再召回）。本实现的四道限制：①**只认主动使用**（memo_recall 命中）——主动检索是唯一的真实兴趣信号，被动注入计数被明确拒绝；②**上界 0.05 ≪ 锚奖励 0.18**——只够在近似并列（Δ<0.05）处翻序，绝不创造常胜将军；③**tanh 饱和 + 30 天半衰**——多用不再多涨、长期不用向基线收缩（强化随遗忘衰减，不积分）；④**默认关**——读侧基线保持纯语义匹配，开关是观察台账数据后的远期期权（`memo_tuning scope=session` 可实验）。语义匹配本身已经是隐式强化（相关内容天然多被召回），本层只做查询漂移时的并列裁决，不做曝光积累。

---

## 12. 实施顺序（三步，各带完成判据）

**P1 · 注入管线（主干）**
- 落地：DB schema + 嵌入 + 原生加载 + `llm/stream` 尾注入 + system 固定契约。
- 完成判据：验收 #1 #2 #3 #4 #5 #9 全绿；用教室建模 11 篇语料跑通三查询。

**P2 · 工具面（补证 + 写入契约）**
- 落地：`memo_recall` / `memo_write` / `memo_tags` / `memo_stats`。
- 完成判据：验收 #6 #7 #8 全绿；用 §12 的孤岛语料做写入回归，确认工具会拒绝"无理由的新 Tag"。

**P3 · 守护与预设化**
- 落地：timer 维护 + 体检日志 + 草稿；创建 `.agent-presets/memo-river/`。
- 完成判据：验收 #10 全绿；新会话选 `memo-river` 预设能起来、注入生效。

---

## 13. 参考索引

**VCPToolBox（事实来源）**
- 范式与语法：`docs/VCP记忆管理系统.md` §2.1（核心范式）、§3.1–§3.3（DailyNote 写法与 Tag 规范）、§4（四类日记本入口）、§5（RAG 修饰符）、§7.1（LightMemo）
- 算法与门控：`TagMemoEngine.js`（`_buildV9PropagationKernel` / `_propagateSpikes`）、`modules/tagmemoV10/riverObservability.js:44-135`（Ω 公式）、`modules/tagmemoV10/experimentArms.js:1206`（结构奖励授权）
- 原生读出：`KnowledgeBaseManager.js:1422`（payload 形状）、`:1664`（queryState）、`:1697-1725`（读出门面）
- Hub 治理：`docs/TAGMEMO_V9_1正式版更新说明_2026-07-14.md` §5.2
- 调参：`docs/TAGMEMO_TUNING_GUIDE.md`、`rag_params.json`

**我们的实测**
- `VCPToolBox/docs/费曼讲义_案例_教室建模_实跑记录.md` §11 / §12
- `VCPToolBox/sandbox/classroom-flow/`：`full.cjs`（JS 轨）、`native.cjs`（原生链）、`retag.cjs`（Tag 河流改造）、`compare.cjs`（三版对照）

**DSH 侧参考实现**
- 被动注入 + 回合后蒸馏：`/home/h/app/dsh-agi-harness/plugins/dsh-engram-relay/src/relay.ts:460`（`systemPrompt.context` 固定文本 + 尾注入）、`src/index.ts:44`（`inject = ['llm','systemPrompt','tools']`）
- 预设机制：`@deepseek-ai/dsh-agent-presets/README.zh.md`；本机实例 `/home/h/.dsh/.agent-presets/router-standard-v34/`（本地 `.mjs` 引用模式）
- 工具注册：`dsh-engram-relay/src/tools.ts:88`（`defineTool` + `ctx.tools.register`）
