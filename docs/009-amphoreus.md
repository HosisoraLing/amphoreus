# 翁法罗斯部署与运行

翁法罗斯是 DeepSeek Harness 的业务插件，需要宿主提供模型、会话、工具、附件和 Web 服务。它不是独立的聊天模型，也不附带角色人设、账号或记忆库。

## 运行环境

- Node.js：满足 `package.json` 中的 `engines.node`，使用 22.19+ 的 22.x 或兼容的 24+ 版本。
- DeepSeek Harness：满足 `engines.dsh`，并保留基础服务及 Web profile。
- 源码构建：pnpm 11，依赖版本见 lockfile。
- QQ：独立部署的 NapCat / OneBot，默认关闭；没有 QQ 时可先使用 Web 入口。
- 媒体与历史检索：按需独立安装 FFmpeg / ffprobe、deja 引擎。它们不是 npm 包内的二进制。

## 在已有 DSH 中安装

构建本项目，再在目标 profile 中安装源码目录：

```sh
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile amphoreus add "link:$PWD"
```

上例假定你已经创建了名为 `amphoreus` 的 Web profile。首次创建 profile 可使用 DSH 的 Web 模板；**已有 profile 不要重新初始化**，避免覆盖账户、配置或插件列表。业务 bundle 只需启用翁法罗斯，宿主的基础与 Web bundle 仍须保留。

在 profile 的插件配置中设置独立状态目录，配置示例见 [profile.cordis.patch.yml](../examples/profile.cordis.patch.yml)。状态目录保存 SQLite、锁和运行元数据，不应放进 Git。

## 角色配置

复制 [amphoreus.json](../examples/amphoreus.json) 到仓库外的私有目录，填写：

| 配置 | 用途 |
| --- | --- |
| `role` | 角色 ID、名称及核心 Persona；由部署者自行提供 |
| `workspace` | 工具与作品工作区 |
| `models` | Main、worker、continuation、topic 的模型选择；实际凭证由 DSH 管理 |
| `api` | 监听地址、允许的 Host、管理和聊天令牌 |
| `qq` | 独立 OneBot 连接与准入范围；默认不连接 |
| `memory` | 记忆策略、时区及夜间回顾 |
| `limits` | 普通 Main、内部审阅和后台任务的时间及步数限制 |

在插件配置中设置 `configPath` 指向角色文件，或通过环境变量提供路径：

```sh
AMPHOREUS_CONFIG=/absolute/private/amphoreus.json dsh --profile amphoreus
```

配置文件设置为仅部署账户可读。API 和 OneBot 使用不同令牌，不能继续使用示例占位值。示例监听回环地址；若需要跨容器访问，在部署端配置实际监听接口和最小必要端口映射。将浏览器使用的准确 `host:port` 加入 `api.allowedHosts`。

首次初始化会保存角色身份与一次性创世问候。重启不会通过重新读取配置来重置已有 Persona。新角色使用新的 `agent_id` 与独立状态目录；已有角色的数据变更应通过受控管理流程完成。

## 管理入口

- **DSH 侧栏**：`/amphoreus/`，复用宿主 owner 认证。
- **独立入口**：`/console/`，使用翁法罗斯自身认证。

两个入口连接同一个 Runtime、主会话和数据库。它们包含聊天、后台任务、记忆、人际关系、群聊参与、表情图库、模型、统计、CLI 风格日志与关于页。独立认证、HTTPS 和反向代理配置见 [standalone-auth.md](standalone-auth.md)。

模型设置对下一次请求生效，已有会话历史保留。总开关、渠道开关与群聊/私聊开关逐层生效；关闭期间消息只归档，重新开启不会补发。

## 消息与任务

消息依次经过 Adapter、统一 Gateway、持久化队列和 Main 调度。所有平台共用一个持续 Main Session，来源用于权限判断与回复路由。`assistant.content` 留作内部想法，只有 `speak` 执行对外发送。

多步工具任务交给 worker；潜意识 continuation 使用原生 Fork，保留人格和经历背景；topic 分支按需回答话题问题。分支通过报告回到 Main，不要求 Main 等待或轮询。工具助手独享 dsh-deja 的工具及自动召回，其他角色不加载该插件；索引可覆盖其他分支的历史。

Main 的普通回复、回顾审阅与长程协作默认无时间上限；`mainTimeoutMs`、`reviewTimeoutMs`、`collaborationTimeoutMs` 为 `0` 时不安装运行截止定时器，显式正值仍可启用限时。停止、角色/渠道关闭及服务退出仍可取消运行。普通 Main 默认 8 步、审阅默认 16 步；步数与时间分别配置，后台任务默认一小时。夜间回顾在 `Asia/Shanghai` 的 01:00 **直接启动 continuation**；进度保留但不唤醒 Main，完成、失败或需要澄清时再汇报。日记与 Self 只能由 Main 确认，程序不会自动把候选写成正式人格。

角色预设在隔离作用域内使用 DSH 原生逐步压力检查，不再按固定 32k 提前压缩。默认 `thresholdRatio: 0.95`，实际触发线取模型窗口的 95% 与“窗口减去输出预留、再减 8192 Token 余量”中的较小值。`retainRatio: 0.8` 使压缩保留至少约 80% 输入预算对应的近期原文（以工具调用成对边界选择），只将更早片段替换成摘要；原始历史与媒体仍可查询。原生服务记录压缩事件和历史替换，仍可按需手动 `/compact`。上游过载或 429 仍可能导致模型请求失败，取消本地时间上限不会消除服务商错误。

已中断或失败的推理不会自动重跑；发送失败先核查、尝试重发，仍失败可通过已配置 SMTP 告警。所有重试均应先核对已经完成的操作。若潜意识已保存候选而 Main 审阅失败，管理员可向 `POST /api/dreaming` 提供 `job_id` 与 `idempotency_key`，只恢复审阅，不重新整理整批记忆。

## 为 Session 加载附加工具

使用 DSH 原生插件配置或预设的 `plugins` 加载工具，翁法罗斯会保留其原生可见范围，不再用固定工具白名单屏蔽它们。仅注册到某个 Session 的工具不会因此开放给其他会话；运行期间加载和卸载的工具也遵循原生注册状态与权限策略。

Main、worker、潜意识和话题分支均支持附加工具；默认预设保持各自职责，多步执行仍优先交给 worker。潜意识 Fork 的工具声明包含当前实际可用的附加工具。角色专属的发言、管理和正式 Diary/Self 确认权限仍按职责限制，Deja 工具和自动召回仍仅用于技术 worker。无需另设翁法罗斯工具名单。

## QQ 与多模态

OneBot 只负责收发；解析、权限、去重、群聊参与和多模态处理均位于 Runtime。支持正向和反向 WebSocket，账号与令牌必须匹配。授权列表为空不接收；`*` 表示该范围全部，启用前应确认目标。

- 图片与 GIF 按原消息顺序进入模型；图片能力依赖所选模型。
- 语音使用已配置的 ASR；未配置时明确提示，不编造转录。
- 视频默认封面加短引用，文件默认名称加短引用；详细读取由角色主动调用工具。
- 引用保留可取得的原文，合并转发默认仅展示摘要，展开需主动调用。

群聊支持心意模式与混合调度，详细行为见 [amphoreus-social-presence.md](amphoreus-social-presence.md)。被明确 @、普通回复和主动参与采用不同引用规则；渠道与会话开关优先于参与策略。

表情图库只随包提供程序代码，不携带任何图片或个人收藏。上传、收藏、检索、编辑和 ZIP 导入导出均通过受控接口；角色选图后交给 `speak` 发送，GIF 保留原始字节。

## 数据与升级

私有配置、DSH home、数据库、原生日志、工作区和作品分别持久化。程序更新不应重建这些目录。旧部署可保留原状态路径和会话标识，程序继续读取原有翁法罗斯数据，不删除旧表或改写原生日志。

数据迁移与完整导出说明见 [010-memory-foundation.md](010-memory-foundation.md) 和 [amphoreus-legacy-import.md](amphoreus-legacy-import.md)。复制旧图库与索引时应生成独立副本并核对内容，不能依赖旧服务目录的链接。

## 统计与验证边界

统计记录 Token、缓存、模型/Agent 分布、激活次数、回复延迟、上下文填充周期、联网搜索及估算费用；日志单独分页，正文、凭证与私人推理不写入运行日志。Go 窗口仅为本程序观察值，价格使用标注日期的快照，均不代表供应商账单或账号全局余量。

```sh
pnpm typecheck
pnpm exec vitest run tests/amphoreus-runtime.spec.ts tests/amphoreus-dreaming.spec.ts tests/amphoreus-http.spec.ts
pnpm build
```

自动化测试使用临时数据和模拟传输。真实模型、浏览器和 QQ 交付应按实际部署另行核验，模拟 OneBot 不等于真实平台验收。Bilibili 入口仍暂缓，不作为已接通功能宣传。
