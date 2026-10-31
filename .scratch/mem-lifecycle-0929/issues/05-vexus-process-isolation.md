# 05 — Vexus 内核进程隔离（每桶 worker，长期架构票）

**What to build:** 「单进程容器」是本次事故的结构性根因：会话、插件、Vexus Rust 内核（rayon 池 + 图 + EPA 缓存 + SQLITE_KEEPALIVES）同住一个 node 进程，无隔离边界、无独立记账。终解 = 把原生内核拆出主进程：

1. **形态**：每桶一个 worker（`worker_threads` 或子进程），主进程持 RPC 句柄；桶内存（索引/图/基底/线程池）全在 worker 内。dsh-memo-river 已有双内核切换面（kernel-reimpl 票 11 `config.native.kernel`），隔离层落在这条切换面之上即可不碰算法层。
2. **收益**：内存隔离与独立记账（单桶膨胀只死单桶 worker，可独立重启）；顺带收窄「进程内两份 sqlite 的 fcntl 锁盲区」（SIGBUS 系问题的并发面）；与票 02 的 LRU 天然衔接（evict = 杀 worker）。
3. **先决**：RPC 协议面（loadVexus 契约的方法集）；超时与 worker 崩溃重启策略；差分对账器（kernel-reimpl 02）复用作等价性验收。
4. 验收：acceptance.mjs 双轨全绿（RPC 透明）；杀单桶 worker 不影响主进程与其他桶；RSS 记账 per-worker 可见。
5. **规模预估**：大票，吃 02/04 的经验；在 01-04 落地、护栏兜底的前提下不紧迫。

**Blocked by:** 02（淘汰语义先定型）、04（会话生命周期结论——决定 worker 生命周期锚点）。

**Status:** open

- [ ] RPC 契约面清单（loadVexus 方法集盘点）
- [ ] 单桶 worker 原型 + 差分对账器等价验收
- [ ] 崩溃重启策略 + 记账面
- [ ] 双轨 acceptance 绿 + Status 回填
