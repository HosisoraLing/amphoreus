import { expect,it } from 'vitest'
import { cardPreview } from '../src/amphoreus/forward-preview.ts'

it('uses the exact native QQ card title, visible preview lines and message count',()=>{
  const news=['东方铁蛋: [图片]','东方铁蛋: 这异环在搞啥','东方铁蛋: 怎么还能解包出绯英立绘','空吟: 工位崩铁摸鱼买了绯英皮肤用...']
  const preview=cardPreview([{arkElement:{bytesData:JSON.stringify({app:'com.tencent.multimsg',meta:{detail:{source:'群聊的聊天记录',news:news.map(text=>({text})),summary:'查看4条转发消息'}},extra:{tsum:4}})}}])
  expect(preview).toEqual({title:'群聊的聊天记录',preview:news,summary:'查看4条转发消息',count:4})
  expect(cardPreview([{multiForwardMsgElement:{xmlContent:'<msg><title>群聊的聊天记录</title><title>小鱼: &lt;图片&gt;</title><summary>查看2条转发消息</summary></msg>'}}])).toEqual({title:'群聊的聊天记录',preview:['小鱼: <图片>'],summary:'查看2条转发消息',count:2})
  expect(cardPreview([{multiForwardMsgElement:{resId:'id'}}])).toBeNull()
})
