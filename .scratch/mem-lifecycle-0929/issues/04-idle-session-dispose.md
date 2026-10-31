# 04 — harness 闲置会话自动 dispose + 驻留上限（上游提案）

**What to build:** 6.3GB 的驻留主体是 harness 侧会话生命周期缺失——打开后永不释放 Agent 上下文（事件历史 + API messages 多副本 + 工具结果缓冲）。本票分两半：

1. **调查半（先行，只读）**：定位 dsh-web 的会话生命周期代码：`@deepseek-ai/dsh` 安装面（`~/.local/lib/node_modules/@deepseek-ai/dsh` 及其 dsh-web 子包）里 session 打开/恢复/dispose 的实现；确认既有 dispose+reopen 机制（载入历史慢归因时的结论）可否复用为自动触发；单会话驻留实测（开 1 会话前后 dsh-web RSS 差）。
2. **提案半**：向 dsh 上游提 issue/PR，或本地补丁（dsh 主程序是上游包，本地补丁要记录 drift）：
   - 闲置自动 dispose：web 端 detach 超过 N 分钟（建议 30）的会话释放 Agent 上下文，session 文件在盘、重打开低频；
   - 同时驻留上限：建议 4，超出 evict 最久闲置；
   - 观测面：web UI/状态端点暴露每会话内存占用与总驻留数。
3. 验收：开 6 会话 → 30 分钟闲置后驻留 ≤4、dsh-web RSS 回落到基线+活跃会话数×单会话驻留；重打开被逐会话功能无损（历史可载入）。

**Blocked by:** None（调查半可先行；提案半依赖调查结论）。

**Status:** open

- [ ] 生命周期代码定位（文件:行 落档本票）
- [ ] 单会话驻留实测读数
- [ ] 上游 issue 提交（链接回填）或本地补丁 + drift 记录
- [ ] 闲置 dispose 验证读数
