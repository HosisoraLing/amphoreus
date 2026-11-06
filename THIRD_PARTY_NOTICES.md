# Third-party software notices

翁法罗斯新增与修改部分采用 [GNU AGPLv3](LICENSE)。本文件列出主要组件，不改变其原始许可；随安装依赖附带的 LICENSE / NOTICE 同样适用。

原型上游的 MIT 全文保存在 [LICENSES/MIT-upstream.txt](LICENSES/MIT-upstream.txt)。随包内嵌代码的许可分别保存在 `vendor/dsh-deja/LICENSE` 与 `vendor/dsh-meme/LICENSE`。

| 组件 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| [DeepSeek Harness Superagent Prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | upstream | MIT | 本项目继承的基础架构与工作流 |
| [@deepseek-ai/dsh](https://github.com/deepseek-ai/deepseek-harness) | 0.2.1-rc.4 | MIT | Agent 会话、推理与工具运行框架 |
| [@deepseek-ai/cordis](https://github.com/deepseek-ai/deepseek-harness) | 4.0.5-alpha.1 | MIT | 插件与服务生命周期 |
| [zod](https://github.com/colinhacks/zod) | 4.4.3 | MIT | 配置及接口校验 |
| [ws](https://github.com/websockets/ws) | 8.22.0 | MIT | WebSocket 通信 |
| [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) | 4.1.2 | MIT | 运行状态锁 |
| [qrcode](https://github.com/soldair/node-qrcode) | 1.5.4 | MIT | 本地生成验证器二维码 |
| [dsh-deja](https://github.com/vshulcz/deja-vu/tree/main/extensions/dsh) | 0.23.3 | MIT | 仅在工具助手中启用的历史检索与自动召回，随翁法罗斯提供 |
| [Node.js](https://nodejs.org/) | runtime | MIT 及随附第三方许可 | JavaScript 运行环境 |
| [FFmpeg / ffprobe](https://ffmpeg.org/) | 外部运行组件 | LGPL-2.1-or-later / GPL-2.0-or-later，随构建而异 | 动图抽帧、音视频解码 |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) | 独立部署 | Limited Redistribution License for NapCat（受限许可） | 通过 OneBot 接口进行 QQ 收发 |
| [MiSans](https://hyperos.mi.com/font/en/) | VF (official Unicode subsets) | MiSans Font Intellectual Property License Agreement | 中文与西文界面可变字体 |
| [dsh-meme](https://github.com/yyh-001/dsh-meme) | 0.1.71 | MIT | 图库、搜索、AI学图、GIF解析和管理接口，隔离后随翁法罗斯提供 |

## 随包代码与外部运行组件

- **随包代码**：原型上游代码、dsh-deja 和 dsh-meme 保留原始 MIT 声明，项目改动说明见 [NOTICE](NOTICE) 和各 vendor 目录中的 README。
- **安装依赖**：DSH 宿主、Cordis 和 npm 依赖按各自发布包的许可证使用；本文件不是对其重新授权。
- **字体**：MiSans 从小米官方 CDN 按需加载。源码及 npm 包不携带字体文件，字体遵循小米的字体知识产权许可。
- **媒体工具**：FFmpeg / ffprobe 需独立安装，许可取决于所用构建；本项目不附带其二进制。
- **QQ 传输**：NapCatQQ 为独立外部服务，遵循其 Limited Redistribution License；本仓库只实现 OneBot 协议适配，不分发 NapCat 或 QQ 客户端。
- **历史检索引擎**：dsh-deja 的 MIT 插件代码随包提供，`deja` 可执行文件另行安装，并遵循其发行版许可。

## 程序许可与使用者数据

角色设定、记忆、聊天、日记、作品、个人图库、凭证及部署数据不属于源码发行内容，也不因安装本程序而获得公开授权。示例、测试与展示使用合成数据。不要把这些私有数据混入公开仓库、npm 包或问题报告。
