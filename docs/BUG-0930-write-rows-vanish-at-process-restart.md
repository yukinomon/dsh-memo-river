# BUG-0930: memo_write 行在进程启动边界被静默删除（surface 分叉根因）

> 报告方：genshin-ts 工作区（桶 `4bde2299850f027e`）｜2026-09-30｜取证上下文：dsh 会话 09-29~09-30

## 一句话

**zcode-adapter 的 memo_write 全链路返回成功且文件落盘，但 files/chunks 行在后续某个进程启动边界被静默删除——写入只在长驻服务进程内存里可见，盘上 knowledge_base.sqlite 无行，进程重启即丢；09-29 08:12 以来 genshin-ts 桶 6 次写入全部如此。**

## 证据链（全部可复验）

1. **写入侧日志**（`4bde2299850f027e/memo-river.log`）：6 次 `memo_write` 全部成功，chunkIds 涨落后回落：
   `09-29 08:12 D85(48) → 08:44 D86(49) → 09:00 D87(50) →【行消失】→ 09-30 02:22 D85(48) → 02:31 D86(49) →【行消失】→ 08:09 D85(48)`
   同一 Tag「客户端Lua」被 `newTags=客户端Lua` 记录 **3 次**（同一 Tag 反复重新创建）。
2. **盘上 DB**：files 表 47 行、max id=84（2026-09-29 04:02 的 mum5hbvu）；09-29 08:12 后 6 篇全部无 files/chunks 行；files.id 跳号（61/62/64/74/75/78/81 缺）=删行痕迹；migration_deleted_files=0（非 merge 路径）。
3. **体检分母回落与进程重启对齐**：health.log files 分母 47→48→49→50 后回落 47，回落点全部在 guardian round 重置（守护进程重启）处。
4. **文件层零丢失**：dailynote/genshin-ts/ 53 个 .md 全在（含被删行的 6 篇）。

## 已排除（实证）

多桶分裂 ✗ / memo_merge 归档 ✗ / WAL 未 checkpoint（wal=0B）✗ / guardian artifact-gc（`pruneArtifactGenerations` daemon.js:282 只删 rivermemo_artifacts 表）✗ / SQLite 触发器×15（全为 vector/stale 维护）✗ / dsh 主包删除（dist 无 memo-river 代码）✗ / 写错 DB（24 次 workspace-open db 路径全同）✗。

## 主嫌疑（建议排查方向）

**进程启动路径的重建/迁移逻辑**（workspace.js 的 open → ensureLoaded → migrate 链）：启动时从某个**不包含新写入的数据源**（嫌疑：emb-cache.json 旧快照 / 某种 manifest / 陈旧读事务）重建 files/chunks，把写入方已 commit 的行覆盖删除。

## 快速复现

```bash
# 1. 记录基线
sqlite3 ~/.dsh/memo-river/<bucket>/knowledge_base.sqlite 'SELECT COUNT(*) FROM files'
# 2. memo_write 一篇（任意工作区）
# 3. 不重启进程：sqlite3 再查 → +1（写入时进程内存/事务可见）
# 4. 杀光 node .*dsh-memo-river/zcode-adapter/mcp-server.mjs 进程，重开一个（或等 dsh 会话重启）
# 5. sqlite3 再查 → 回到基线（新行消失）
```

## 影响

- 检索侧：近期写入的日记被动召回/主动 recall 全部不可见（candidates 不含），直到修复+重放。
- 统计侧：Tag 词汇表/D 编号/体检篇数全部失真（D85 被分配 3 次）。
- 修复后需重放 09-29 以来 6 篇（文件在 dailynote/ 原样可重放）。

## 报告方临时纪律

写后对账：`sqlite3 .../knowledge_base.sqlite 'SELECT COUNT(*) FROM files'` vs memo_write 返回篇数，不一致即视为又发生。

---

## ✅ 结案附记（2026-10-03，dsh-plugins 会话独立取证）

**根因已端到端实证（本文「主嫌疑」段的方向猜错了——不是启动路径重建覆盖，而是 WAL 双库互毁）：**

同进程内两份独立编译的 sqlite 实例——node:sqlite（store 长连接）与 rusqlite（复刻内核 kernel/src/memo_artifact_builder.rs，eacf947 起生产在役）——复刻轨**省略了上游的 `ensure_sqlite_keepalive`（WAL 双开防护，上游 lib.rs:1459）**，每次 artifact rebuild 的 `open_readwrite → commit → close` 从第二实例视角重置 -wal，把 node 侧未 checkpoint 的提交行静默丢弃。沙箱复现：6 写全 commit 成功 → 下一进程 count=2（丢 5 行）+ SQLITE_IOERR 522 + -wal 重置 0 字节 + integrity_check ok（回卷而非损坏）。三层闸（withDb 串行）只管「访问」不管「连接生命周期」，故 09-28 的 SIGBUS 修复把崩溃面修掉后，同根的回卷面长了出来。

**修复与恢复读数：**
- keepalive 忠实移植进复刻内核（static SQLITE_KEEPALIVES + normalized_sqlite_path + open_readwrite 包装）→ 同实验 7/7 无丢失；
- daemon.ts 回卷 tripwire（files 环比净下降 → guardian-rollback-tripwire + health.log ROLLBACK-TRIPWIRE）；
- vcp 回切 → 重启 → 重灌 → 复验（diff 五腿 PASS 分数差 1.11e-16 + 双轨 acceptance 37/37）→ **已带防护切回 reimpl 轨**（journal 实证 keepalive retained）；
- 数据：genshin-ts 桶 47→56（9/9）、dsh-plugins 桶 16→26（10/10），全走 writeDiaryCore 真嵌入管线；重灌件 `scripts/reimport-orphans.mjs`。

完整决策链见记忆河流：dsh-plugins 桶 D26《根因闭环》+ D27《修复执行》。
