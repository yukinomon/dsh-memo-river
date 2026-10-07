# BUG-1003: reimpl 内核轨生产爆炸（437MB→5.97GB）+ SEGV——挂载风暴 × 生命周期泄漏

**状态**: 取证完成，修复执行中 ｜ **报告方**: dsh-plugins 工作区 ｜ 2026-10-03 ｜ 关联: BUG-0930（keepalive/tripwire 已并入本案背景）

## 案情（时间线，北京时间）

| 时间 | 事件 | 证据 |
|---|---|---|
| 11:42 | dsh-web 实例 SEGV，`si_code=SI_TKILL`，栈顶 `memo-kernel…node+0x15cf40` | coredump 839809（117MB，在盘） |
| 12:00-12:50 | **挂载风暴**：plugin.log 每分钟 15-30 次 `contract-registered→tools-installed→plugin-ready→guardian-started` 全序列，持续 ~50 分钟（~700 次挂载），期间用户在 GUI 批准日记（memo_approve） | plugin.log 04:00-04:50Z 直方图 |
| 12:12-12:33 | 实例 1332214（reimpl 轨，keepalive 构建）运行 24 分钟，RSS 437MB | watchdog |
| 12:33-12:36 | **437MB→5.97GB 静默爆炸**（journal 零日志、无内核调用日志）；5.98GB 全私有匿名，AnonHugePages 1GB，VmSize 18GB，27 线程 | /var/tmp/dsh-leak-forensics/123452-1332214 |
| 12:38-12:40 | 用户重启（stop 超时 89s→SIGKILL） | journalctl |

**fd 全景**（爆炸时）：5 桶 × 每桶 8 fd，均匀少量——**连接泄漏排除**。

## 定性（符号化实证）

- coredump 模块 build-id `56412119…` = keepalive 构建（懒加载：老实例 dlopen 到 cp 后的新文件）。
- 带符号重建（`CARGO_PROFILE_RELEASE_STRIP=none CARGO_PROFILE_RELEASE_DEBUG=true`，debuginfo 不改代码布局）+ addr2line：`memo_dtsc::run`（kernel/src/memo_dtsc.rs:1225，LTO 内联进 `__napi__rerank_rivermemo_topology_v3`）。
- 关键反汇编 0x15cef4-0x15cf03：`mov edi,1; mov esi,0x28; call alloc::raw_vec::handle_error; ud2`——**40 字节分配失败→abort**。
- **结论：SEGV 不是内存安全缺陷，是内存耗尽的死点采样。** 真凶=挂载风暴下的生命周期泄漏，把 RSS 推到耗尽。

## 根因链（三层）

1. **dsh 侧（风暴源）**: session `resolve()` 每次都 `composeAgent(preset)` 全量重挂（D68 实录），GUI 轮询/用户操作期间 2-8 秒一次；预设 wrapper 以 `?v=<mtime>` import 插件——组合可产生全新模块实例。
2. **插件侧（泄漏面）**: `releaseAllWorkspaces()`（src/workspace.ts:288）**无任何调用方**——fiber dispose 不释放工作区运行时（KnowledgeStore/MemoEngine/native 索引）；sessions/daemons/RoutePool 部分有收口，registry 没有。
3. **内核侧（放大器?）**: 每实例「各持一份 native 索引在同一张库上做重建」（index.ts 历史注释自证）；V8 堆在 700 次挂载churn下扩张+THP 钉住（AnonHugePages 1GB）——待独立压测定责。

## 票

- **票12 内核轨内存安全复审**: ①复现挂载churn×内核调用的 RSS 曲线（修复前后对照）；②确认/排除内核侧每实例保留大分配；③ASAN/debug 构建跑五腿+acceptance。**验收: 独立压测 RSS 稳态 + 双轨 37/37。**
- **票13 dsh 侧挂载风暴**: resolve() 每次全量 compose 的缓存化（上游 dsh 仓）；本仓侧先量化+文档化触发链。**验收: GUI 活跃期 plugin-ready 频次 < 1/min。**
- **票14 插件生命周期止血**: ①fiber dispose → 释放本代工作区资源（含 registry 引用计数，最后一代 close）；②挂载churn回归测试。**验收: churn 压测 RSS 平坦。**
- **票15 独立端口验证**: 第二 dsh-web 实例（独立端口）挂 reimpl 轨跑全链+观察期，全绿后才切生产。

## 处置记录

- 2026-10-03 ~13:00 生产已回滚 vcp 轨（kernel-reimpl.conf→.disabled）；watchdog 阈值 3G→1.5G + inspector 重试。
