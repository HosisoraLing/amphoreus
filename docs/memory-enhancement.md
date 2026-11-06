# 记忆增强实施记录

保留统一 Gateway、原生 Main Session、原文归档、SQLite、现有记忆工具及 Main 确认权限；不增加外部存储或常驻分类器。

## 阶段状态

- P0 压缩可靠性：本轮由维护者明确暂缓。沿用 DSH 原生限额及不限时 Main，不增加软阈值或额外压缩适配器。此前的模拟后端测试不能视为真实模型压缩验收。
- P1 社交上下文：按来源补足未观察区间，取消固定跨渠道快照和自动人物印象；观察状态以原生消息及请求提交为证据。新增配置位于 `memory.socialContext`，仅使用现有 record 存储，不改变原始消息或 Schema 版本。
- P2 巩固：新增结构化候选、来源/证据分类校验、同窗口同源同主张幂等、冻结批次提交及断点恢复；零候选可正常完成。`memory.dreaming.consolidation` 默认关闭，P0 暂缓期间不启用新的自动提炼负担。开启后新建 Job 使用批次协议；旧 Job 和工具参数兼容。
- P3 检索：Schema 2 增加可重建 FTS5 bigram 索引；原文短语再次校验，完整短语优先，按字段相关性、重要性与时间排序。宽泛词使用兼容扫描，单字保留回退。新增事实有效时间与已确认人物引用查询，Main 采纳替代事实时保留旧正文及明确的失效时间。
- P4 评测与观测：待实现合成评测集、性能记录及不变量告警。

## 验证与回退

各阶段独立验证、提交。P1 可用 `memory.socialContext.enabled=false` 停止附加上下文，主会话与原文不删除。后续数据库迁移必须先在一致状态副本演练；索引、运行配置及私人备份不进入公开仓库。测试使用合成消息与临时数据库，不向在线角色注入测试消息。

## 增量巩固协议

`memory_review_read` 默认从协议 v2 Job 的 `processed_position` 读取，返回冻结范围内的真实记录、`batch_id`、`next_position` 和 `complete`。`memory_review_commit` 校验归属、连续位置及候选证据，接受带说明的零候选；只在提交后推进批次游标。分支结束但尚有未处理历史时，Job 为 `incomplete`，不推进日常游标。

管理员可向 `/api/dreaming` 提交 `job_id`、`action: "resume"` 和幂等键，继续原分支；`action: "review"` 只恢复 Main 审阅。使用 `backfill: {from,to}` 创建独立历史回填窗口，其进度不覆盖日常回顾游标。

`memorize` 向后兼容扩展 `category`、`evidence_type`、`entity_refs`、`observed_at`、`valid_from`、`valid_to`、`review_job_id`。结构化事实必须有可验证来源，推测与创造性联想不伪装成明确来信或成功行动。未知日期为空；同源重试不会恢复已归档候选。正式 Self/日记仍需 Main 确认。

## 索引升级、查询与回退

Schema 1 升级为 2，不修改原记录 ID、正文和来源。索引通过 SQLite 触发器随写入、元数据更新及删除维护；reasoning 到期清空正文时同步清除检索项。高于本程序支持的版本拒绝写入。停服后可运行 `node scripts/amphoreus-memory-index.mjs check|rebuild DATABASE ROLE` 检查或重建派生索引。

`memory.search.enabled=false` 可单独回退查询适配器；当前程序继续维护索引。Schema 2 不能直接交给仅支持 Schema 1 的旧程序；代码降级需恢复一致备份，不能仅删除 FTS 表或改版本号。

`memory_find` 新增 `as_of`（已认可事实的历史有效时间）、`current_facts`、`entity_ref`、`platform` 与 `actor_id`。原有 `since/until` 仍表示记录时间。未知有效期保持空值，不假定入库时间就是生效时间。人物引用必须来自已登记的稳定身份；查询按当前已确认关联扩展账号，解除关联后查询立即反映变化，不改写旧事件。

复制状态演练：18,308 条记录，Schema 1→2，索引条数一致且无缺失；非 reasoning 的 ID/正文/来源/创建时间校验值一致，SQLite 完整性检查通过，未修改生产库。reasoning 仍按既有 TTL 处理。

10 万条合成记录、8 类查询各 5 次，在 Node 22.22.0 / Linux x64 / i7-9700K 上最终 P95 约 94ms，数据库约 100MB。初测 P95 约 151ms；优化完整短语优先、宽泛词回退和只排序 ID 后达到本次 100ms 目标。该数字不是其他数据分布或线上模型响应的保证。可用 `node node_modules/vitest/vitest.mjs run --config scripts/memory-search-benchmark.config.mjs` 独立复测；设置 `AMPHOREUS_SEARCH_REPORT` 输出报告，`AMPHOREUS_SEARCH_DATABASE` 可复用明确指定的合成数据库，默认清理临时数据库。
