import type { DatabaseSync } from 'node:sqlite'
export interface PeopleActor {ref:string;owner:boolean;admin:boolean;group:boolean;conversation:string;sessionId:string;messageId:string}
export interface Profile {person_id:string;identity:string;display_name:string;accounts:{ref:string;display_name:string;last_seen:string}[];impressions:{id:string;subject_ref:string;key:string;body:string;evidence:string;certainty:string;visibility:string}[];contacts:{channel:string;address:string;label:string}[]}
export function parseIdentity(ref:string):{ref:string;platform:string;namespace:string;externalId:string}
export class PeopleStore {
 constructor(file:string)
 db:DatabaseSync
 close():void
 identity(ref:string):{person_id:string}|undefined
 encounter(ref:string,name?:string):{person_id:string}
 samePerson(a:string,b:string):boolean
 profile(ref:string,actor:PeopleActor):Profile|null
 list(query?:string,offset?:number,limit?:number):{total:number;offset:number;people:Profile[]}
 note(ref:string,args:Record<string,unknown>,actor:PeopleActor):unknown
 contact(ref:string,args:Record<string,unknown>,actor:PeopleActor):unknown
 link(from:string,to:string|null,actor:PeopleActor,reason:string):unknown
}
