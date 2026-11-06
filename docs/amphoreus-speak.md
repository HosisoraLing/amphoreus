# 统一消息出口

`speak` 默认把文字发回当前消息的原渠道。可指定 `channel` 发送到已配置、已知的另一个渠道；不确定时按需调用 `list_channels`。旧的完整 `target` 参数仍可用，不能同时传 `channel`。

```json
{"content":"你好"}
{"content":"你好","channel":"qq:group:123456"}
{"content":"群消息","channel":"QQ","qq":{"group_id":"123456"}}
{"content":"私聊消息","channel":"QQ","qq":{"user_id":"987654"}}
{"content":"指定机器人账号","channel":"QQ","qq":{"group_id":"123456","account_id":"10001"}}
{"content":"/workspace/picture.gif","modality":"image"}
{"content":[{"type":"text","text":"这是附件"},{"type":"file","path":"/workspace/notes.txt"}]}
```

`channel` 支持 `QQ` / `qq`。`qq.group_id` 与 `qq.user_id` 必须且只能填一个，均为字符串数字 ID。只解析到 `list_channels` 提供的已有授权会话；不会因传入群号就新增权限。多机器人账号命中同一群/用户时必须补 `qq.account_id`。不传 `qq` 时保留现有渠道选择规则；全都不传时原路回复。跨会话不携带旧 `reply_to`，重试仍由统一输出网关核验原目标。

未指定模态时，字符串始终是文字。`modality` 支持 `text/image/audio/video/file`，也支持原顺序混合内容块。支持 HTTP(S) 地址、工作区本地文件及已存储的原生附件引用。单个本地附件上限 50MB，不能通过路径或符号链接读取授权工作区和附件目录之外的文件。

本地附件保存为不可变原始文件，重试引用同一份内容。GIF 保留原始动画。QQ 使用 NapCat 原生消息段发送，收发服务没有消息处理补丁。Web 附件经登录权限检查后显示或下载，音视频支持字节范围读取。

## 结果与自动恢复

模型只看到「成功」或简短失败说明，不再收到消息内容、目标、事件 ID 和时间戳组成的大段 JSON。完整 Outbox 和平台回执保留在服务端。

发送失败后，后台独立于 Main 执行：

1. 核查发送结果；超时或进程中断产生的未知结果优先查平台回执及近期发送历史。
2. 对已知失败自动重试一次。
3. 仍失败则通过已配置的 SMTP 发信服务通知管理员。

**不自动启动修复 subagent。** 无法确认的发送不会被当成已知失败而盲目重复；会邮件通知结果仍未知。恢复决定和邮件通知阶段持久化，重启不会重新发送已确认成功的消息或重复告警。SMTP 本身未确认成功时，管理端显示错误。

SMTP 告警复用鱼缸的现有发信服务：私密配置 `delivery.mail` 指定 URL、令牌及收件人，`delivery.retryDelayMs` 默认 1000。SMTP 密码继续留在原发信服务，不进入项目。没有配置 SMTP 时，不会声称告警已发送。

唤醒消息省略平台消息 ID，确有需要时可以通过 `memory_read` 查询原始来源的消息 ID。原始事件和引用关系保持完整。原生 Harness 界面里的固定触发说明是显示文案，没有进入模型提示；翁法罗斯插件将这句重复说明隐藏。
