export interface LegacySource {name:string;path:string;exclude?:string[];excludeComponents?:string[]}
export interface LegacyPlan {
  agentId:string;database:string;destination:string;containerDestination:string;sources:LegacySource[];
  currentSelf?:string;diaries?:string;secrets?:string[];memory?:unknown;nativeHome?:string;
  projects?:{source:string;destination:string;references?:string[]}[];
}
export interface LegacyManifest {
  version:number;captured_at:string;directories:string[];excluded:string[];deduplicated_bytes:number;
  files:{path:string;type:string;bytes?:number;sha256?:string;mtime?:string;target?:string}[];
  sqlite:{source:string;path:string;sha256:string}[];
}
export function captureLegacy(plan:LegacyPlan):Promise<LegacyManifest>
export function importLegacy(plan:LegacyPlan,manifest:LegacyManifest):Promise<Record<string,number>>
export function materializeLegacy(plan:LegacyPlan,manifest:LegacyManifest):Promise<{native_files:number;project_files:number}>
