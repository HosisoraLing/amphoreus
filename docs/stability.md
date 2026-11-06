# 离线长程稳定性验证

不向部署中的机器人发送测试消息，不连接真实 NapCat，不访问部署状态接口，也不调用真实模型。

## 加速生命周期测试

复用现有依赖运行：

```sh
AMPHOREUS_STABILITY_REPORT=/absolute/private/stability.json node node_modules/vitest/vitest.mjs run --config scripts/stability-audit.config.mjs
```

测试仅使用临时 SQLite、合成角色、隔离的原生 DSH 工具／提示词注册表，并在结束后删除临时数据库。需要支持 `--expose-gc` 的 Node.js；报告记录多轮强制 GC 后的 JavaScript 堆、RSS、external 和 ArrayBuffer 数值。

- 16,000 次工具、提示词、监听器注册与释放：检查注册表回到原状态，观察堆是否持续增长。
- 26,000 个合成 Session 身份：检查归档与统计游标的保留、去重和恢复；这些不是实际模型会话或完整原生 Agent。
- 固定负载增量的堆预算为 3 MiB，用于发现明显线性回归，不代表任意环境的内存上限。

归档与统计的游标每次都会写入 SQLite；不再额外将所有历史 Session 永久保存在进程 Map 中。原始记录、统计和恢复位置继续保留。

## 结论边界

加速测试不能替代多天真实使用，也不覆盖模型服务商、网络中断、NapCat 登录失效、实际媒体文件与第三方工具的全部行为。RSS 不会随每次 GC 立即下降，不能单凭 RSS 上涨认定 JavaScript 对象泄漏。

原生 Agent 的驻留与卸载由 DSH 宿主负责；翁法罗斯归档后台会话不会删除原生日志、作品或角色记忆。
