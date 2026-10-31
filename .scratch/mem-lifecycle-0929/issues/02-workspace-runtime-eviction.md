# 02 — acquireWorkspace 运行时淘汰（LRU + 临时桶即用即关）

**What to build:** `src/workspace.ts` 的 workspace 注册表加生命周期：

1. **临时打开走独立通道**：跨桶检索（memo_recall folder 真路由）、memo_stats 等一次性访问 → 开临时 WorkspaceRuntime，用完 `runtime.close()`，不进注册表。修改点：`resolveBucket` 路由调用处（workspace.ts 票 01 recall-quality 段）与 `src/index.ts` 的 memo_stats/memo_tags 入口。
2. **注册表 LRU 上限**：`acquireWorkspace` 保留会话常驻桶；上限 3（可配 `config.native.maxOpenWorkspaces`，缺省 3），超出 evict 最久未用——evict 前 `close()`（关 Vexus 实例、释放 rayon 池与图/EPA 缓存；防 SIGBUS 的 SQLITE_KEEPALIVES 连接小、保留不动）。
3. **touch 语义**：guardian 轮询与会话活动刷新 LRU 时钟，避免活跃桶被误逐。
4. 验收：`node -e` 脚本循环 acquireWorkspace 10 个不同临时桶 → 注册表 size ≤3、进程 RSS 稳定（前后采样差 <50MB）；acceptance.mjs 37/37 + acceptance-p3.mjs 4/4 仍绿（双轨 vcp/reimpl 各跑一遍）。

**Blocked by:** None — 可与 01 并行。

**Status:** open

- [ ] 临时打开通道 + close 落地
- [ ] LRU + 配置项 + touch
- [ ] 循环 acquire 压测脚本 + RSS 判据读数
- [ ] 双轨验收绿 + Status 回填 commit
