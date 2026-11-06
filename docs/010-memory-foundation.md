# Memory Foundation v1.2

## M0 能力审查

基于当前 Amphoreus 的唯一 Main Session、Gateway、SQLite、独立任务池和 Harness 侧栏插件增量实现；继续保持 `speak` 才对外发送。`assistant.content` 是角色明确生成的想法、自言自语及工作文本，与对外发言、原生 reasoning、分支报告、工具行动分别保存。

已核对本机实际安装版本和类型声明：

- DSH `sessionController.fork({sessionId})` 原生复制最后完成 Turn 的事件前缀，保留 parentSession/isSeeded；返回真实子 Session ID。当前未结束 Turn 用独立交接消息补足，不伪造父历史。
- 原生 `AgentDelivery` 可持久化 queue/steer/inject 并以稳定消息 ID 去重；Agent Inbox 在 Step 边界接收输入，`whenIdle()` 与持久化 flush 用于资源释放。
- `assistant/message` 是已合并的模型步骤内容，含 Turn/Step、stream、usage、中断标记；归档以提交事件为准，避免逐 delta 重复。只记录实际提供的 reasoning，绝不重建未提供内容。
- Fork 与续跑复用原生 Session 和持久化，任务池/Gateway 仍由 Amphoreus 管理，避免第二套调度器和原生工具自动回报旁路。
- 按用户补充要求，`worker` 加载完整 Persona 作为设计风格和价值基准，历史仍保持任务范围；`continuation` 使用真实 Fork 并获得与 Main 相同的记忆读取工具。分支不获得正式 Diary/Self 确认权限。
- 已阅读参考项目 [dsh-world](https://github.com/chenkezhen480/dsh-world) 和本机安装代码（0.6.6）的 archive、memoryTool、Self、diary/life：复用原文保留、主动分页检索、Self/Persona 分离、历史版本和主导日记的设计，保留现有鱼缸运行状态。

实施单元按指南 M1–M8：历史归档；双类型任务/真 Fork；持续双向通信/恢复；Main 协作 Steering；时间与重要性记忆；日记和 Self 的 Main 确认；增量 Dreaming；管理页、真实模型及恢复导出验收。每个独立单元验证后本地提交，不自动推送。

## M1 原文归档

同一 SQLite 增加统一记忆表，原 Gateway 和原生 Session 继续保留。以事件/Session+seq 为稳定 ID 增量归档，来源字段保留角色、Run/Step/Task、平台及分支。跳过 Fork 继承前缀和回忆注入，防止把读到的历史重新当成新经历。工具参数及结果中的凭据字段脱敏。

Main 的显式 `assistant.content` 同时作为不触发推理的内部想法事件显示在主消息中心，绝不调用平台发送。原生 reasoning 独立存储，仅配置允许的 provider 可保存，默认 7 天；未提供、未获配置允许、中断和到期均可区分。到期清除记忆表原文，保留来源和此前巩固结果；DSH 自身不可变技术日志不由此功能篡改，备份和原生日志的保留由其部署策略负责。

`memory_find` 默认返回 8 条短摘录，`memory_read` 按 ID 分页读原文。检索按字面相关性、重要性和时间排序，旧重要历史仍可召回；不引入向量服务。全局记忆接口仅管理者可读，普通外部聊天用户不因此获得档案权限。

## M2 双类型分支

`delegate_task(kind=worker|continuation)` 默认 worker；按用户最新要求，执行助手加载完整角色 Persona 作为设计风格和价值基准，但不自动加载 Main 全部历史，按任务需要授予记忆读取。continuation 必须调用 DSH 原生 Fork 并验证已持久化的 parentSession/isSeeded，记录完成 Turn 边界、Persona 哈希、Self 版本、记忆视图时间及当前 Run 交接。后台准备和执行不阻塞 Main。潜意识只有记忆及汇报工具，不得到技术 Worker 的 shell 或正式日记/Self 写入权；来源标识和归档保留分支关系。

## M3 持续通信与恢复

`report_to_main` 仍通过 Gateway 可靠唤醒 Main；`send_message`/兼容 `task_message` 也先生成带方向的内部 Gateway 事件，再持久化投递到分支 Inbox。返回 pending/accepted，不把入队伪装成完成或已读。潜意识提问后可结束本轮并进入 waiting，释放执行槽；Main 指导后在原 Fork Session 上开启新周期，不再 Fork。每周期的终结报告独立编号。

原生 Fork 分支可暂停、恢复、终止；运行时中断后保留来源、未投递消息及同一 Session，再带中断说明继续；工具型任务仍按原安全策略标记中断，避免盲目重做外部副作用。分支原始 Session 缺失时明确报错，不以空白会话替代。管理端可查看 Fork 关系和双方消息。

## M4 长程协作与 Steering

Main 可用 `collaborate` 保存长期目标，工作时使用独立的有界步数/时长预算，休息时不发空请求。协作中 Scheduler 仍只允许一个 Main Run，新消息持久化后进入原生 steer Inbox；直到真实 `user/message` 被当前 Step 接纳才切换默认回复来源。新消息不取消原工作。当前 Run 已接纳的来源均保留授权上下文，可回答新来信后明确回复原创作来源；输出记录带真实 origin_event_id，恢复时按该来源校验。未接纳的输入继续排队，已接纳但中断的输入须审查后重试，不伪装成成功。

## 工具助手的 Deja（用户补充）

直接使用现有 `dsh-deja`（本机 0.23.3）的工具和自动召回，只把插件注册到技术 worker preset；Main/router 和 continuation 不安装插件、不暴露 deja 工具、不注入自动召回。检索语料不按角色分支过滤，包含 Main 和潜意识的记录；正常分页不构成语料范围限制。技术 worker 同时可读角色全局记忆，完整 Persona 作为设计基准。不会另造工作记忆工具或受限索引。部署时安装/链接依赖，不把 dsh-deja 的全局 bundle patch 加入 profile；CLI 与缓存持久化，允许索引子分支。

部署复用现有0.23.3包和同版本CLI，仅读挂载，不下载重复副本；需要zstd解压原生Session日志。环境只启用 `DEJA_INCLUDE_SUBAGENTS=1` 和持久缓存，不设置排除分支或限定来源的查询参数。包挂载于业务模块的node_modules下，以便解析Harness工具依赖；profile仅链接依赖，不启用全局bundle。

Deja 0.23.3 的工具和 hook 已随包提供在 `vendor/dsh-deja`，保留 MIT 声明；唯一兼容修改让自动召回同时识别委派任务来源和旧来源。仅工具助手预设加载 `@hosisora_ling/dsh-amphoreus/worker-deja`，无需全局安装或启用 Deja bundle；Main、潜意识和话题分支仍不加载其工具及自动召回，索引检索范围不受此作用域限制。

真实模型联调发现，addition-only接口在Fork收窄到全新工具集合时会将所有工具延迟声明。潜意识在原生Turn内追加当前可用工具的 `request/header(reason=series)`，保留全部父历史，重设工具基线。作用域与JSON声明均显式取自该分支；不恢复Main的发言、执行或主观确认权限。

## M5 时间、重要性与灵感

`memorize` 生成候选、CreativeInsight 或 Topic Thread，所有引用须属于真实存在的本角色记录。模型自报的重要性受上限约束，并结合实际行动证据或明确的长期记忆意图；只有 Main 的可追踪采纳操作可使其成为 adopted。保留决策、修订、替代关系和原始来源，不把分支提议当作 Main 已认可的事实。原始 reasoning 到期后保留合法巩固结果，不重建到期文本；可选配置允许重要已采纳来源延长原文保留。

原文按来源和半小时片段形成 Activity Segment，游标增量维护；`list_topics`/`read_topic` 提供同一角色全部平台的摘要和原文引用，话题修订保留旧版本，不因昵称相同就合并人物身份。

## M6 主观创作控制

潜意识或 Main 用 `memorize` 提交独立日记/Self 草稿；技术 worker 的服务端权限拒绝这两种主观草稿。只有 Main 拥有 `memory_confirm`，可亲自修改正文、说明确认理由并显式列出采用的灵感；确认记录带 Main Run 和草稿来源，不把分支原创文本伪称 Main 独立生成。管理员的“请审阅”只向 Main 的 Gateway 发出请求，不绕过最终创作权。

正式 Self 与创建者 Persona 分开，限制 4000 字，采用乐观版本检查防止旧草稿覆盖新认知；旧版本保留。日记只确认今天的版本，已合上的日期不允许改写，纠正写在当日日记。Fork 保留原 Self 快照，后续变化通过带来源的双向消息提示并由分支 `memory_refresh` 主动同步；不并发修改共享 Session。
### M7 · 增量回顾

默认香港时间23:00将增量经历作为网关意图交给Main，再由其安排原生Fork回顾。记录固定区间、游标、任务状态与审阅理由；支持手动触发和重启重试。潜意识只能提交草稿，正式日记、Self仍由Main确认，也可明确跳过。关闭回顾前检查待审草稿，不强制生成每日内容。
### M8 · 管理端

原生侧栏继续复用同一管理面板，新增记忆与自我：原文分页、分支/时间/类型筛选、推理保留状态、灵感采用轨迹与反向关联、话题和Self版本、草稿审阅、增量回顾状态和日分布。浏览器审阅操作只向Main提交意见，不直接确认角色主观内容。分支详情按时间合并双向通信，显示Fork来源和版本。
### 私有备份与恢复

停服后运行 `node scripts/amphoreus-data.mjs export DATABASE ARCHIVE DSH_HOME WORKSPACE_ROOT`。v4 导出八张领域表、Main/分支及已迁入旧会话的原生压缩日志、工作区登记；同时将原生附件、当前实例自己的旧鱼缸归档、独立人际关系数据库和完整项目工作副本保存到 `ARCHIVE.assets`，逐文件校验 SHA-256。内容相同的备份只保存一份对象，不引用运行中的源文件；工作副本恢复后可独立修改。人物库使用 SQLite 一致快照，包含已提交 WAL 数据。密码哈希与加密的验证器绑定状态保留，另行保管现有私密配置才能解密。

JSON 与同名 `.assets` 目录必须一起保管。恢复使用新数据库、空 DSH_HOME 和空项目目录：`node scripts/amphoreus-data.mjs restore NEW_DATABASE ARCHIVE EMPTY_DSH_HOME EMPTY_WORKSPACE_ROOT`。创建数据库前先校验附件哈希、路径及链接范围，拒绝穿越目录、通过链接写出目标或覆盖已有状态。v4 保留 rowid 与增量游标，兼容旧 v2/v3 归档；旧格式没有附件与项目字节。省略 WORKSPACE_ROOT 时明确报告工作副本未导出。

恢复部署保持容器内原工作区与 DSH_HOME 挂载路径，另行配置凭证；不覆盖现有数据，不自动重发不确定的外部消息。归档含私人对话、人物资料、原始迁移文件及加密认证状态，必须按私密备份保管；不能提交到 Git 或公开发布。

## M8 原生运行验收结果

实际模型已完成：同Session潜意识提问/回信/续跑、工具助手Deja读取Main与潜意识历史、Main确认日记和Self、带真实来源的接口reasoning→分支灵感→Main采纳。回环OneBot群消息在同一个长程Main Run内接入并经speak回复，随后返回原网页来源继续创作，未连接真实NapCat。恢复样本的19份原生日志逐字节一致，原生后端读回3055条事件及4个Fork；728条记忆、来源和游标保持一致。相关单测、类型检查、构建及原生侧栏浏览器检查通过。

联调过程中的失败与中断记录保留真实状态。推理到期清理针对Memory Store可检索副本；原生DSH不可变日志和已有私有备份未被重写，需按部署的数据保留策略独立管理。

## 消息多媒体输入

Main 与 Steering 使用原生结构化内容，文字、图片和引用按原顺序送入；@ 明确区分“叫你”和“叫的是别人”，并按需查询真实群名片。图片直接送入视觉模型；GIF 保留完整原文件并按时间顺序抽取最多8帧。语音经现有 MiMo `mimo-v2.5-asr` 转写，不另建识别服务。视频默认只看封面，文件默认只看文件名；Main 想读完整内容时调用 `read_media`，当前消息可仅传文件名或视频序号，历史内容才需来源ID。长下载地址和大段JSON不进入普通来信，也不应转贴给群友。

NapCat保持原版，仅负责收发和取回消息。转发预览、引用、@及多媒体处理全部在Runtime完成。合并转发优先使用已有卡片字段；标准OneBot只提供ID时，Runtime取回记录并缓存，默认仅把标题、前4行“发送者：文字/[图片]”和总条数给模型，完整正文只在主动调用 `read_forward` 时分页显示。内部图片不会因生成预览而下载或送入模型。引用原消息通过现有OneBot API读取，保留发送者和时间。

附件原文件由 DSH 保存，读取结果与来源进入统一记忆；临时解码目录用完移除。单文件上限100MB，图片数量服从 Harness 限制；超限或读取失败明确标识，不能假称看见或听见。动图/视频解码运行环境需要 FFmpeg。模型看到的成功 `speak` 回执仅保留状态；完整正文、目标、回执和错误仍保留在 Gateway/Event Store。

## 历史故障的处理状态

总览只展示尚未核对处理的事件故障。管理员可标记已处理，记录说明、操作人和时间；原事件、失败运行及错误原文继续保留。标记绑定本次失败与运行尝试，重试后再次失败会重新提示，旧页面不能处理新故障。此操作不重放消息或工具。运行记录及管理员消息详情可查看处理说明。

## Subagent 自动归档

工具助手与潜意识在本轮结束、等待反馈或暂停后使用DSH原生归档，当前Main及正在执行/排队的任务保留。原生侧栏隐藏归档会话，只剩归档会话的任务工作区移除显示登记；会话日志、任务目录、角色记忆与报告均保留，不设置定时删除。归档潜意识收到Main消息后自动解除归档，在原Session继续，结束后再次归档。启动及每小时检查已有任务，并收起单一Main迁移前的旧会话和未使用的空白入口；当前Main明确排除。
