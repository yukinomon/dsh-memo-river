# 03 — 交换层根治：zram 下层磁盘 swap + 死水位清理 runbook

**What to build:** 两次 OOM 的直接放大器是交换层：zram0（7.7G，253:0）容量耗尽（write-error=满，非坏盘）且无下层。两件事：

1. **诊断快照（先做，只读）**：`swapon --show`、`zramctl`（压缩比/data/total）、`dmsetup table` 排除 dm 层疑点；`smartctl -a` 底层 NVMe 一次（顺手排除坏盘，虽然已判定 write-error=zram 满）。
2. **加磁盘 swap 下层**：建 swap 文件或分区（建议 16-32G，`pri=10` 低于 zram 的 100）。效果：zram 满后冷页可下刷磁盘而不是 write-error → 内核回收链不断 → OOM 阈值大幅后移。可选进阶：zram writeback（`/sys/block/zram0/backing_dev`）把冷页自动下刷。系统层变更：改 fstab/systemd swap unit，保留回滚注释。
3. **死水位清理 runbook**（写进本票，供下次事故直接引用）：
   - 现状清点：`swapon --show` + `for f in /proc/[0-9]*/status; do ...VmSwap...` 排出 swap 滞留大户；
   - 轻清理：重启滞留大户应用（本例 Chrome 系 ~2G+）即释放其 zram 页；
   - 全清理：`swapoff -a && swapon -a` **仅当 RAM 可用 > swap used 时**（本例 6.7G>4.2G 不可行，先关大户再评估）；最干净 = 重启；
   - 禁止项：zram 死水位下盲目开新大内存应用（原神 3.65G 即第二杀）。
4. 验收：zram 满水位场景（开大内存压力进程）不再出现 swap write-error 前置 OOM；`swapon --show` 显示两层 prio 正确。

**Blocked by:** None — 诊断部分立即可做；swap 配置需用户确认窗口（游戏/工作会话避开）。

**Status:** done（实施半，2026-09-29 11:54）——诊断快照 + 磁盘 swap 下层 + zswap 永久禁用落地；死水位 runbook 已写入本票。读数：`swapon --show` 两层（zram0 7.7G pri=100 / /swap/swapfile 16G pri=10，总交换 23G）；swap 文件在 **sda4**（/home 区，独立 @swap 子卷 + `btrfs filesystem mkswapfile --size 16g`，根分区零占用）；zswap 运行时 N + GRUB cmdline 追加 `zswap.enabled=0`（备份 /etc/default/grub.bak-oom0929、/etc/fstab.bak-oom0929）。待重启验证：fstab 自动拉起两层 + cmdline 生效 + zram 死水位清零。

- [x] 诊断快照落档（本票附录）：zram0 zstd 7.7G（压缩比 ~2.7:1，死水位 6.7G）；253:0=zram 非坏盘；sda4 Data single ✅
- [x] 磁盘 swap 下层生效（prio 10 < zram 100）
- [ ] 死水位 runbook 验证一遍（重启后：zram USED 应归零附近、/swap/swapfile 自动挂载）
