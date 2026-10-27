# 分期实施计划

| 期 | 文档 | 状态 |
| --- | --- | --- |
| P1 | [P1-agent-runtime-resume.md](./P1-agent-runtime-resume.md) | ✅ 已实现（2026-10-24），偏差记录在文首 |
| P2 | [P2-domain-manual-loop.md](./P2-domain-manual-loop.md) | ✅ 已实现（2026-10-25），偏差记录在文首 |
| P3 | [P3-mock-interview-notify.md](./P3-mock-interview-notify.md) | ✅ M1 文本面试 + M3 通知已实现（2026-10-25）；M2 语音待厂商 |
| P4 | [P4-browser-agent.md](./P4-browser-agent.md) | ✅ 已实现（2026-10-25，agent-browser 0.39.2） |

> P5 已于 2026-10-25 拆并：语音面试 → P3，简历 PDF 导出 → P2，本目录不再有独立 P5。
> 2026-10-27 目录重构：本文各期路径已同步为当前结构（main 按 app / agent / browser / stores / services / ipc / workspace 分层）。

约定：

- 每期**开工前**先修订对应计划（对齐届时代码现状、补齐开放决策点）并交审批，再动代码；
  实现过程中的偏差回写到该期文档头部（见 P1 的做法）。
- 路线图总纲在 `docs/ARCHITECTURE.md` §8 与 `docs/PRODUCT.md` §7；本目录是细化执行层，
  两处不一致时以最新批准的版本为准并同步另一处（P5 拆并即一例，PRODUCT §7 的 P5 行
  在 P2/P3 开工修订时一并更新）。
- 每份计划里的「开放决策点」是需要产品/用户拍板的问题，默认值只是建议；
  文中「已拍板决策」是用户已确认的结论，不再重议。
