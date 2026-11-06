import { expect,it } from 'vitest'
import { Speak,speakContent,speakTarget,speakResult } from '../src/amphoreus/speak.ts'

it('defaults to text and the current source; explicit modalities and mixed blocks retain their order',()=>{
  const plain=Speak.parse({content:'你好'});expect(speakContent(plain)).toEqual([{type:'text',text:'你好'}]);expect(speakTarget(plain,[])).toBeUndefined()
  expect(speakContent(Speak.parse({content:'/workspace/image.gif',modality:'image'}))).toEqual([{type:'image',path:'/workspace/image.gif'}])
  const blocks=[{type:'text',text:'前'},{type:'image',url:'https://media.test/picture'},{type:'text',text:'后'},{type:'file',path:'/workspace/notes.txt'}]
  expect(speakContent(Speak.parse({content:blocks}))).toEqual(blocks)
  const encoded=JSON.stringify([{type:'image',path:'/workspace/motion.gif'}])
  expect(speakContent(Speak.parse({content:encoded,modality:'image'}))).toEqual([{type:'image',path:'/workspace/motion.gif'}])
  expect(speakContent(Speak.parse({content:encoded}))).toEqual([{type:'text',text:encoded}])
})

it('routes only to an explicitly selected known channel and rejects ambiguous shortcuts',()=>{
  const channels=[{channel:'qq:group:123',name:'第一个群',target:{platform:'qq',account_id:'1',conversation_id:'group:123'}},
    {channel:'qq:group:456',name:'第二个群',target:{platform:'qq',account_id:'1',conversation_id:'group:456'}}]
  expect(speakTarget(Speak.parse({content:'你好',channel:'qq:group:456'}),channels)).toEqual(channels[1]!.target)
  expect(()=>speakTarget(Speak.parse({content:'你好',channel:'qq'}),channels)).toThrow('渠道不明确')
  expect(()=>speakTarget(Speak.parse({content:'你好',channel:'unknown'}),channels)).toThrow('渠道不明确')
})

it('routes explicit QQ group or private IDs only through known authorized channels',()=>{
  const group={platform:'qq',account_id:'1',conversation_id:'group:123'},privateChat={platform:'qq',account_id:'1',conversation_id:'private:456'}
  const channels=[{channel:'qq:group:123',name:'群',target:group},{channel:'qq:private:456',name:'私聊',target:privateChat}]
  expect(speakTarget(Speak.parse({content:'你好',channel:'QQ',qq:{group_id:'123'}}),channels)).toEqual(group)
  expect(speakTarget(Speak.parse({content:'你好',channel:'qq',qq:{user_id:'456'}}),channels)).toEqual(privateChat)
  expect(()=>speakTarget(Speak.parse({content:'你好',channel:'QQ',qq:{group_id:'999'}}),channels)).toThrow('未授权')
  expect(()=>Speak.parse({content:'你好',channel:'web',qq:{group_id:'123'}})).toThrow()
  expect(()=>Speak.parse({content:'你好',qq:{group_id:'123'}})).toThrow()
  expect(()=>Speak.parse({content:'你好',channel:'QQ',qq:{group_id:'123',user_id:'456'}})).toThrow()
  expect(()=>Speak.parse({content:'你好',channel:'QQ',qq:{group_id:'../123'}})).toThrow()
  expect(()=>Speak.parse({content:'你好',channel:'QQ',qq:{}})).toThrow()
  const two=[...channels,{channel:'qq:group:123',name:'另一账号',target:{...group,account_id:'2'}}]
  expect(()=>speakTarget(Speak.parse({content:'你好',channel:'QQ',qq:{group_id:'123'}}),two)).toThrow('账号不明确')
  expect(speakTarget(Speak.parse({content:'你好',channel:'QQ',qq:{group_id:'123',account_id:'2'}}),two)?.account_id).toBe('2')
  expect(speakTarget(Speak.parse({content:'你好',channel:'QQ'}),[channels[0]!])).toEqual(group)
})

it('renders a compact success or failure without echoing output IDs, content or routing JSON',()=>{
  expect(speakResult({status:'sent',output_id:'hidden',content:'不要复述'})).toEqual([{type:'text',text:'成功'}])
  for(const status of ['failed','unknown','pending'])expect(speakResult({status})[0]!.text).toContain('失败，系统正在自动核查并重试')
})
