import {db,audit,authenticate,json,cors,fail} from "../_shared/position-charts-http.ts";
import {buildReminder,isReminderSlot,moscowDay} from "../_shared/position-charts.mjs";
const OWNER_ID=118296372;
Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors(req)});
 if(req.method!=="POST")return json(req,{error:"method_not_allowed"},405);
 let day:string|null=null;
 try {
  const input=await req.json().catch(()=>({}));
  if(input.dry_run===true){
   await authenticate(req,true);
   const rows=await audit();
   return json(req,{day:moscowDay(),recipient:OWNER_ID,payload:buildReminder(rows,moscowDay()),missing:rows.filter((r:any)=>r.needs_chart).length,sent:false});
  }
  const secret=req.headers.get("x-cron-secret")||"";
  if(!secret)return json(req,{error:"unauthorized"},401);
  const {data:valid,error:ve}=await db.rpc("weekly_digest_check_cron_secret",{p_secret:secret});
  if(ve||!valid)return json(req,{error:"unauthorized"},401);
  if(!isReminderSlot())return json(req,{ok:true,skipped:"outside_21_00_Moscow_window"});
  day=moscowDay();
  // Unique daily claim prevents duplicate messages, including concurrent runs.
  const {error:claim}=await db.from("position_chart_reminder_runs").insert({day_msk:day,status:"claimed"});
  if(claim?.code==="23505")return json(req,{ok:true,skipped:"already_claimed"});
  if(claim)throw new Error("claim_failed");
  const rows=await audit(),message=buildReminder(rows,day),count=rows.filter((r:any)=>r.needs_chart).length;
  if(!message){
   const {error}=await db.from("position_chart_reminder_runs").update({status:"silent",finished_at:new Date().toISOString()}).eq("day_msk",day);
   if(error)throw new Error("run_log_failed");
   return json(req,{ok:true,sent:false,missing:0});
  }
  const token=Deno.env.get("TELEGRAM_BOT_TOKEN")||Deno.env.get("TELEGRAM_TOKEN");
  if(!token)throw new Error("telegram_config_missing");
  // Fixed verified owner destination; request payload cannot redirect delivery.
  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
   method:"POST",headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(15000),
   body:JSON.stringify({chat_id:OWNER_ID,parse_mode:"HTML",disable_web_page_preview:true,...message})
  });
  const result=await response.json();
  if(!response.ok||!result.ok)throw new Error("telegram_send_failed");
  const {error}=await db.from("position_chart_reminder_runs").update({status:"sent",finished_at:new Date().toISOString(),missing_count:count,message_id:result.result.message_id}).eq("day_msk",day);
  if(error)throw new Error("run_log_failed_after_send");
  return json(req,{ok:true,sent:true,missing:count});
 }catch(e){
  if(day)await db.from("position_chart_reminder_runs").update({status:"failed",finished_at:new Date().toISOString(),error_code:e instanceof Error?e.message:"failed"}).eq("day_msk",day);
  return fail(req,e);
 }
});
