# mem-lifecycle-0929 —— dsh-web OOM 事故根治（内存生命周期 campaign）

**由来**：2026-09-29 11:06:36 与 11:29:35 内核两次全局 OOM。第一杀 dsh-web 主进程（pid 893961，RSS 6.3GB，运行 1h37m）；第二杀 YuanShen.exe（pid 976018，RSS 3.65GB）。完整调查存记忆河流 D200 + 本看板事实表。容器 = dsh-memo-river 子项目 `.scratch/mem-lifecycle-0929/`。

## 一、已钉死的事实（票据依据，均已实测，勿重查）

| 事实 | 读数 |
|---|---|
| 第一杀 | 11:06:36 dsh-web node 893961：anon-rss 6589424kB、total-vm 24.4GB、CPU 仅 2min12s（98 分钟里）——对象堆积非计算。OOM 表断层第一（第二名 zcode 334MB） |
| 驻留模型 | 98 分钟内 web UI 先后打开 **8 个 AI 会话**并存（10:31-10:59 密集开 7 个）；(6300−230)/8 ≈ **每会话 200-750MB 进程内驻留**（盘上单会话最大仅 5.5MB 文本） |
| 自然对照 | 前一次运行（04:03-09:28）仅 1-2 会话，5h25m 峰值 **555.9M**——会话数×驻留的线性叠加，非偶发 |
| 桶运行时 | 主进程 retain 6 桶 keepalive（b94d8836/8acc4f5a/8d283eef/f23d80bb/fe7af38d/de138c92），全部对应用户打开的会话工作区；`acquireWorkspace`（src/workspace.ts:279）注册表只增不减，`releaseAllWorkspaces` 仅进程退出调用 |
| kernel-reimpl 排除 | reimpl 轨验收均为短命子进程（10:58:55 启动、11:02 前退出），OOM 表无大 node 子进程；主进程日志全为 [Vexus-Lite]（vcp 轨），reimpl 从未进入主进程；无 selftest 桶泄漏到主进程 |
| 第二杀 | 11:29:35 原神 3.65GB 被 OOM；彼时 dsh-web 新进程仅 60MB 三采样零增长——**第二杀与 dsh-web 无关**，是第一杀的余震 |
| **zram 真相（归因纠偏）** | swap 设备 253:0 = **zram0**（内存压缩盘 7.7G）。两次 OOM 的 "Write-error on swap-device" = **zram 容量耗尽的设计行为，不是坏盘**；Free swap=164kB。16G 物理机的全部交换空间 = zram 7.7G（压缩后实际腾挪 ~3G 物理），**无磁盘 swap 下层** |
| 死水位 | 首杀后 zram 冷页不清（Chrome 系 2G+ 滞留），第二杀时 zram 仍 6.7G 满——任何新的大内存进程（原神 3.65G）上量即再度触底 |
| 干净基线 | 11:06 重启后 dsh-web：RSS 60-92MB、CPU 0.3%、25 分钟仅 2 次 plugin-ready |

## 二、票据

| # | 问题 | 票 |
|---|---|---|
| L0 护栏 | dsh-web 无 cgroup 内存限额，膨胀即整机 OOM | 01 |
| L1 插件 | WorkspaceRuntime 只增不减（注册表无淘汰、跨桶临时 runtime 不关） | 02 |
| L1 系统 | zram 满水位无下层兜底 + 死水位清理无 runbook | **03 done（2026-09-29 实施半）** |
| L2 harness | 会话打开后永不 dispose，8 会话并存 = 6.3GB 驻留主体 | 04 |
| L3 架构 | 单进程容器：会话+插件+Vexus 内核同进程无隔离 | 05 |

## 三、依赖图

```
01（独立，立即）      03（独立，立即）
02（独立，本周）──┐
04（上游调查先行）┴──> 05（长期，吃 02/04 经验）
```

## 四、执行纪律

1. 判据 = 可复现读数（RSS 采样/OOM 表/zram 水位），不接受「看起来对了」。
2. 一个主题一个提交；票面 `Status` 回填 commit 号。
3. 票 03 涉及系统级变更（swap 配置）——先诊断快照后动手，保留回滚路径。
4. 生产桶只打副本（live 库有 rust keepalive 连接，kernel-reimpl §11 教训沿用）。
