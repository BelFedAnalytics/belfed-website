import { createClient } from "https://esm.sh/@supabase/supabase-js@2.118.0";
import { closureRows, mediaUrl } from "./position-charts.mjs";
export const URL_BASE=Deno.env.get("SUPABASE_URL")!;
export const BUCKET="position-close-charts";
export const db=createClient(URL_BASE,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const ORIGINS=new Set(["https://belfed.ru","https://www.belfed.ru","https://belfed.com","https://www.belfed.com"]);
export function cors(req:Request){
 const o=req.headers.get("origin")||"";
 return {"Access-Control-Allow-Origin":ORIGINS.has(o)?o:"https://belfed.ru",
   "Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info",
   "Access-Control-Allow-Methods":"POST, GET, OPTIONS","Vary":"Origin"};
}
export const json=(req:Request,body:unknown,status=200)=>new Response(JSON.stringify(body),{
 status,headers:{...cors(req),"Content-Type":"application/json","Cache-Control":"no-store"}});
export async function authenticate(req:Request,admin=false){
 const token=req.headers.get("authorization")?.replace(/^Bearer\s+/i,"");
 if(!token)throw new Error("unauthorized");
 const {data,error}=await db.auth.getUser(token);
 if(error||!data.user)throw new Error("unauthorized");
 const {data:p,error:pe}=await db.from("profiles").select("subscription_status").eq("id",data.user.id).single();
 if(pe)throw new Error("forbidden");
 if(p.subscription_status==="admin")return data.user;
 if(admin)throw new Error("forbidden");
 const {data:access,error:ae}=await db.rpc("user_has_access",{uid:data.user.id});
 if(ae||!access)throw new Error("forbidden");
 return data.user;
}
export async function audit(){
 const {data,error}=await db.rpc("position_chart_audit_data");
 if(error)throw new Error("audit_unavailable");
 return closureRows(data);
}
export async function boundedBody(req:Request,limit:number){
 const reader=req.body?.getReader();if(!reader)return new Uint8Array();
 const chunks:Uint8Array[]=[];let total=0;
 for(;;){const {done,value}=await reader.read();if(done)break;
  total+=value.byteLength;if(total>limit){await reader.cancel();throw new Error("invalid_file_size");}chunks.push(value);
 }
 const bytes=new Uint8Array(total);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return bytes;
}
export async function withPreview(row:any){
 const result={...row,chart_image_url:row.attachment_id&&row.image_path?mediaUrl(URL_BASE,row.attachment_id):null};
 if(row.image_path){
  const {data,error}=await db.storage.from(BUCKET).createSignedUrl(row.image_path,600);
  if(error)throw new Error("preview_unavailable");
  result.preview_url=data.signedUrl;
 }
 delete result.image_path;
 return result;
}
export function fail(req:Request,error:unknown){
 const message=error instanceof Error?error.message:"internal_error";
 const status=message==="unauthorized"?401:message==="forbidden"?403:message==="chart_conflict"?409:message.startsWith("invalid")?400:500;
 console.error("position-charts",message);
 return json(req,{error:message},status);
}
