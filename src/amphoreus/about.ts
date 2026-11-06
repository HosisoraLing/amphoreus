/** Public application metadata and verified third-party notices; no deployment secrets. */
import notices from './software-notices.json?raw'
import manifest from '../../package.json?raw'
export function aboutInfo(){
 const application=JSON.parse(manifest) as {version:string;license:string}
 const software=JSON.parse(notices) as {components:{name:string;version:string;license:string;purpose:string;source:string;license_url?:string;license_text?:string;note?:string}[]}
 return {name:'翁法罗斯 · Amphoreus',version:application.version,runtime:`Node.js ${process.versions.node}`,license:application.license,
  description:'基于 dsh-superagent 开发的角色运行系统，感谢 DeepSeek Harness 团队。所有平台共用一个主对话，后台分支独立工作，对外发言通过统一消息出口。',
  usage:['总开关关闭时停止推理、后台工作和对外发言，管理页与历史仍可使用。','渠道和会话开关只影响对应来源；父级关闭时，子级设置保持保存但不会生效。开启并不强制回复，群聊仍按心意／混合策略参与。','关闭期间消息只归档，重新开启不补发。已发出的消息和已经开始的外部操作无法撤回。','重新开启可继续暂停的潜意识和话题分支；工具助手被中断后需检查，不会自动重做。'],
  open_source:'翁法罗斯新增与修改部分采用 GNU AGPLv3，保留上游 MIT 版权与许可。主要组件分别遵循各自协议；字体和外部服务的受限许可单独列明，并非都属于开源软件。',
  source_url:'https://github.com/HosisoraLing/amphoreus',license_url:'https://github.com/HosisoraLing/amphoreus/blob/main/LICENSE',
  license_usage:['可依AGPLv3使用、研究、修改和再分发本程序，包括商业用途；分发时须保留声明并履行对应源码等义务。','通过网络向用户提供修改版服务时，须按AGPLv3第13条向这些用户提供对应源码的获取方式；完整条文以LICENSE为准。','人格、人设、记忆、聊天记录、日记、作品、图库和凭证属于部署者的数据，不随程序发布，程序许可证不授予这些资料的权利。','MiSans仅从官方CDN加载；NapCat、FFmpeg及deja引擎由部署者另行安装，使用和再分发遵循原许可。'],
  components:software.components.map(component=>component.version==='runtime'?{...component,version:process.versions.node}:component)}
}
