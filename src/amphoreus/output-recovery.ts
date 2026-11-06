/** Bounded output recovery, independent of Main inference. Escalation is email, never a subagent. */
import { z } from 'zod'
import type { MessageGateway } from './gateway.ts'
import type { AmphoreusStore,OutputRecord } from './store.ts'
import type { OutputTarget } from './gateway.ts'

export const DeliverySettings=z.object({
  retryDelayMs:z.number().int().min(0).max(60000).default(1000),
  mail:z.object({url:z.url(),token:z.string().min(1),to:z.email()}).strict().optional(),
}).strict().prefault({})
type Recovery={output_id:string;state:'waiting'|'retrying'|'notifying'|'sent'|'alerted'|'mail-failed';attempts:number;due:number;error?:string}

export class OutputRecovery {
  private timer?:ReturnType<typeof setInterval>
  private work?:Promise<void>
  private stopped=false
  constructor(private readonly store:AmphoreusStore,private readonly gateway:MessageGateway,
    private readonly authorize:(target:OutputTarget,output:OutputRecord)=>boolean,
    private readonly settings:z.infer<typeof DeliverySettings>,private readonly now=()=>Date.now(),
    private readonly notify?:(output:OutputRecord)=>Promise<void>,private readonly changed=()=>{}){ }
  schedule(output:OutputRecord){
    if(output.status==='sent'||output.status==='sending')return
    if(!this.store.record<Recovery>('output-recovery',output.output_id))this.store.setRecord('output-recovery',output.output_id,
      {output_id:output.output_id,state:'waiting',attempts:0,due:this.now()+this.settings.retryDelayMs} satisfies Recovery)
  }
  start(){this.stopped=false;this.timer=setInterval(()=>this.wake(),1000);this.timer.unref();this.wake()}
  private wake(){
    if(this.stopped||this.work)return
    this.work=this.tick().catch(()=>{this.store.setRecord('error','output-recovery',{error:'发送恢复暂未完成，持久化记录保留，下轮继续。'})}).finally(()=>{this.work=undefined})
  }
  async stop(){this.stopped=true;clearInterval(this.timer);await this.work}
  private async mail(output:OutputRecord){
    if(this.notify)return this.notify(output)
    const config=this.settings.mail
    if(!config)throw new Error('SMTP告警服务未配置')
    const url=new URL('/send',config.url)
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Tank-Token':config.token},
      body:JSON.stringify({to:config.to,subject:'角色消息发送失败',body:[
        '系统未能确认角色的一条消息发送成功。',
        `渠道：${output.platform} / ${output.target.conversation_id}`,`状态：${output.status}`,`记录：${output.output_id}`,
        output.status==='unknown'?'平台未确认结果，系统已先核对回执，未盲目重复发送。':'自动重试仍未成功，已停止本条消息的重复尝试。',
        '请在翁法罗斯管理页查看发送记录。系统未启动修复 subagent。',
      ].join('\n')}),signal:AbortSignal.timeout(45000)})
    const value=await response.json().catch(()=>null) as {ok?:boolean}|null
    if(!response.ok||value?.ok!==true)throw new Error(`SMTP告警服务未确认成功（HTTP ${response.status}）`)
  }
  async tick(){
    let changed=false
    try{
    for(const record of this.store.records<Recovery>('output-recovery')){
      if(this.stopped||record.due>this.now()||['sent','alerted','mail-failed'].includes(record.state))continue
      let output=this.store.output(record.output_id)
      if(!output)continue
      if(!this.gateway.canSend({...output.target,platform:output.platform}))continue
      changed=true
      if(output.status==='sent'){this.store.setRecord('output-recovery',output.output_id,{...record,state:'sent'});continue}
      // A crash while sending is ambiguous. Ask the platform before considering another send.
      if(output.status==='unknown')output=await this.gateway.verifyOutput(output.output_id)
      if(output.status==='sent'){this.store.setRecord('output-recovery',output.output_id,{...record,state:'sent'});continue}
      if(record.attempts===0&&output.status!=='unknown'&&output.status!=='sending'){
        record.attempts=1;record.state='retrying';this.store.setRecord('output-recovery',output.output_id,record)
        output=await this.gateway.retryOutput(output.output_id,target=>this.authorize(target,output!))
        if(output.status==='unknown')output=await this.gateway.verifyOutput(output.output_id)
      }
      if(output.status==='sent'){this.store.setRecord('output-recovery',output.output_id,{...record,state:'sent'});continue}
      if(record.state==='notifying'){
        // An interrupted SMTP acknowledgement may already have delivered the email. Keep it visible, do not send duplicates.
        this.store.setRecord('output-recovery',output.output_id,{...record,state:'mail-failed',error:'邮件发送确认中断，请查看收件箱与服务日志。'});continue
      }
      record.state='notifying';this.store.setRecord('output-recovery',output.output_id,record)
      try{await this.mail(output);this.store.setRecord('output-recovery',output.output_id,{...record,state:'alerted'})}
      catch{this.store.setRecord('output-recovery',output.output_id,{...record,state:'mail-failed',error:'SMTP告警未确认送达，请检查发信服务。'})}
    }
    }finally{if(changed)this.changed()}
  }
}
