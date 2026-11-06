# 记忆增强实施记录

保留统一 Gateway、原生 Main Session、原文归档、SQLite、现有记忆工具及 Main 确认权限；不增加外部存储或常驻分类器。

## 阶段状态

- P0 压缩可靠性：本轮由维护者明确暂缓。沿用 DSH 原生限额及不限时 Main，不增加软阈值或额外压缩适配器。此前的模拟后端测试不能视为真实模型压缩验收。
- P1 社交上下文：按来源补足未观察区间，取消固定跨渠道快照和自动人物印象；观察状态以原生消息及请求提交为证据。新增配置位于 `memory.socialContext`，仅使用现有 record 存储，不改变原始消息或 Schema 版本。
- P2 巩固：新增结构化候选、来源/证据分类校验、同窗口同源同主张幂等、冻结批次提交及断点恢复；零候选可正常完成。`memory.dreaming.consolidation` 默认关闭，P0 暂缓期间不启用新的自动提炼负担。开启后新建 Job 使用批次协议；旧 Job 和工具参数兼容。
- P3 检索：待实现可重建 FTS5 索引、兼容迁移及事实时间查询。
- P4 评测与观测：待实现合成评测集、性能记录及不变量告警。

## 验证与回退

各阶段独立验证、提交。P1 可用 `memory.socialContext.enabled=false` 停止附加上下文，主会话与原文不删除。后续数据库迁移必须先在一致状态副本演练；索引、运行配置及私人备份不进入公开仓库。测试使用合成消息与临时数据库，不向在线角色注入测试消息。

## 增量巩固协议

`memory_review_read` 默认从协议 v2 Job 的 `processed_position` 读取，返回冻结范围内的真实记录、`batch_id`、`next_position` 和 `complete`。`memory_review_commit` 校验归属、连续位置及候选证据，接受带说明的零候选；只在提交后推进批次游标。分支结束但尚有未处理历史时，Job 为 `incomplete`，不推进日常游标。

管理员可向 `/api/dreaming` 提交 `job_id`、`action: "resume"` 和幂等键，继续原分支；`action: "review"` 只恢复 Main 审阅。使用 `backfill: {from,to}` 创建独立历史回填窗口，其进度不覆盖日常回顾游标。

`memorize` 向后兼容扩展 `category`、`evidence_type`、`entity_refs`、`observed_at`、`valid_from`、`valid_to`、`review_job_id`。结构化事实必须有可验证来源，推测与创造性联想不伪装成明确来信或成功行动。未知日期为空；同源重试不会恢复已归档候选。正式 Self/日记仍需 Main 确认。
