/** Host plugin settings; character data and credentials live in a private JSON file. */
import s from '@deepseek-ai/schemastery'
export const Config = s.object({
  stateDir: s.string().required().description('翁法罗斯状态目录的绝对路径，保存数据库与运行锁。'),
  configPath: s.string().default('').description('私有角色配置 JSON 的绝对路径；留空时读取 AMPHOREUS_CONFIG 环境变量。'),
})
export type DeploymentConfig = ReturnType<typeof Config>
