# 配置翁法罗斯

翁法罗斯只运行角色系统，不包含 GitHub／飞书工单模式。

1. 按 [部署指南](docs/009-amphoreus.md) 安装到已有 DeepSeek Harness Web profile；保留宿主基础服务和模型配置。
2. 将 [角色配置示例](examples/amphoreus.json) 复制到仓库外的私有目录，填写 Persona、工作区、令牌及需要的 QQ 通道。
3. 在插件设置中填写 `stateDir` 和 `configPath`。也可用 `AMPHOREUS_CONFIG` 环境变量指定角色文件。
4. 启动对应 DSH profile，从左侧栏进入「翁法罗斯」。按需配置模型、消息开关与 QQ 主动参与模式。
5. 使用临时数据库和构造的 OneBot 消息验证流程；真实 QQ 发送需单独验收。

所有定时任务、日志与展示默认使用 `Asia/Shanghai`。升级保留私有配置、状态目录、DSH 会话、附件与工作区；不要覆盖或公开这些数据。

本插件提供三个组件：翁法罗斯核心、工具助手预设、主会话预设。工具由角色运行时按职责限制，Deja 仅在工具助手内加载。
