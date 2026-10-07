# dsh-memo-river 仓守则（AGENTS.md · 会话自动加载）

> 定位：VCPToolBox TagMemo/RiverMemo 记忆算法的 dsh 插件化（含 zcode-adapter 侧）。活知识三通道：本文件（仓级工程守则）｜工作区 `~/dsh-plugins/AGENTS.md`（环境硬坑与运维速查）｜记忆河流（教训脉络，被动召回）。

## 布局与产物

- `src/` → 编译 `lib/`（**构建产物，.gitignore 不入库**）；`kernel/` 是 rust 复刻内核（cdylib → `kernel/memo-kernel.linux-x64-gnu.node`，同样不入库，`cargo build --release` 后 cp）；上游对照真件在 `/home/h/app/VCPToolBox/rust-vexus-lite`（有 `ensure_sqlite_keepalive`，行为基准）。
- `zcode-adapter/` 是 ZCode 侧分支形态；`scripts/` 含验收/差分/运维件。

## 构建红线

- **勿信 `.bin/tsc`**（兄弟仓 billion-context-dsh 的是 0 字节坏壳——退出码 0 零输出假成功）。编译：`node ../billion-context-dsh/node_modules/typescript/lib/tsc.js -p .`，编完 `grep -c <新标记> lib/<文件>.js` 必须非零。
- 内核改动：`cd kernel && cargo build --release && cp target/release/libmemo_kernel.so memo-kernel.linux-x64-gnu.node`。

## 验证闸门（改动分级）

- **内核/写路径改动**（kernel/、store.ts、workspace.ts、daemon.ts）：`node kernel/tools/diff-runner.mjs` 五腿 PASS（判据分数差 ≤1e-6，健康史 1.11e-16）+ `node scripts/acceptance.mjs` 37/37（reimpl 轨跑法：`MEMO_NATIVE_KERNEL=reimpl node scripts/acceptance.mjs`）。#8 归档比对项有相邻近平局名次互换的固有抖动——单红复跑再定罪。
- 生产内核轨切换：双轨 acceptance 全绿才允许改 `~/.config/systemd/user/dsh-web.service.d/kernel-reimpl.conf` 的 `Environment=MEMO_NATIVE_KERNEL`，改后 daemon-reload + restart dsh-web。

## WAL 双库契约（BUG-0930 血案，违者静默丢数据）

同进程内 node:sqlite（store 长连接）与 rusqlite 是**两份独立编译的 sqlite**——任何在活桶上开 readwrite 的代码路径**必须保 keepalive**（对照 `kernel/src/memo_artifact_builder.rs` 的 `ensure_sqlite_keepalive`：static SQLITE_KEEPALIVES 每 dbPath 一条永生连接，禁止每次构建开→commit→close）。close 从第二实例视角会重置 -wal，把 node 侧未 checkpoint 的提交行在进程边界静默回卷（integrity_check 仍是 ok——回卷不是损坏）。健康信号：health.log 出现 `ROLLBACK-TRIPWIRE files=N→M` 行 = 回卷实锤，立即取证（-wal 尺寸、最近重启、journal）。

## 运维件

- `scripts/reimport-orphans.mjs <workspace-cwd>`：桶 dailynote/*.md 与库 files 行比对，孤儿走 writeDiaryCore 全管线重灌。**必须 `env -u MEMO_NATIVE_KERNEL`**（防继承服务 env）；内置 reimpl 旧内核拒跑闸。
- schema 变更：`src/schema.ts` 53 条幂等 DDL，源参考 VCPToolBox classroom-flow；`scripts/gen-schema.mjs` 再生。
- 嵌入：api.relayrouter.ai 需代理（TAG_EMBED_PROXY=7890 三处兜底）；embed 失败写入 NULL 向量+告警（不阻断）。
