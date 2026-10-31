# 01 — dsh-web cgroup 内存护栏

**What to build:** `~/.config/systemd/user/dsh-web.service` `[Service]` 段加三行：

```ini
MemoryHigh=8G
MemoryMax=10G
MemorySwapMax=2G
```

`systemctl --user daemon-reload && systemctl --user restart dsh-web` 生效。验证：`systemctl --user show dsh-web -p MemoryHigh,MemoryMax,MemorySwapMax` 读数正确；人为压测（可选：`stress-ng --vm 1 --vm-bytes 11G --vm-hang 0` 打进 dsh-web 的 cgroup 不现实，改为信任 cgroup 语义 + 观察 MemoryPeak）。

**Blocked by:** None — can start immediately. 止损性质：下次膨胀时服务自愈式死亡（systemd 5s 拉起），不再拖死桌面/游戏/整机。

**Status:** open

- [ ] 三行配置落盘 + daemon-reload
- [ ] show 读数核验
- [ ] README 看板事实表补一行「护栏生效」读数
