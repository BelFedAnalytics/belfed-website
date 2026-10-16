import {assertEquals,assert} from "https://deno.land/std@0.224.0/assert/mod.ts";
Deno.env.set("SUPABASE_URL","https://test.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY","test-service-role");
Deno.env.set("TELEGRAM_BOT_TOKEN","test-token");
const handlers:((req:Request)=>Promise<Response>)[]=[];
const originalServe=Deno.serve;
(Deno as any).serve=(h:any)=>{handlers.push(h);return {};};
const originalFetch=globalThis.fetch;
let role="admin",calls:any[]=[],closed=true,claimExists=false,attachment=false;
const uid="10000000-0000-0000-0000-000000000001";
const aid="20000000-0000-0000-0000-000000000001";
const data=()=>({positions:[{id:1,ticker:"BTC",direction:"long",opened_at:"2026-09-01T00:00:00+03:00",closed_at:"2026-10-01",status:"closed",publish_to_ru:true,exit_price:100}],
 events:[{id:2,position_id:1,event_type:"closed",triggered_at:"2026-10-01",triggered_price:100,message_id_ru:2,payload:{}}],partials:[],attachments:attachment?[{id:aid,position_id:1,event_id:2,chart_url:"https://www.tradingview.com/x/ABC123/"}]:[]});
const ok=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
globalThis.fetch=async(input:any,init?:any)=>{
 const url=typeof input==="string"?input:input.url||String(input);
 const method=init?.method||"GET",body=typeof init?.body==="string"?JSON.parse(init.body):init?.body;
 calls.push({url,method,body});
 if(url.includes("/auth/v1/user"))return ok({id:uid,email:"test@example.test"});
 if(url.includes("/rest/v1/profiles"))return ok({subscription_status:role});
 if(url.includes("/rpc/user_has_access")){assertEquals(body.uid,uid);return ok(role==="premium");}
 if(url.includes("/rpc/position_chart_audit_data"))return ok(data());
 if(url.includes("/rpc/position_chart_save")){assertEquals(body.p_event_id,2);assertEquals(body.p_actor,uid);return ok({id:aid,updated_at:"2026-10-16T18:00:00Z"});}
 if(url.includes("/rpc/weekly_digest_check_cron_secret"))return ok(body.p_secret==="valid-cron-secret");
 if(url.includes("/rest/v1/position_chart_reminder_runs")){
  if(method==="POST"&&claimExists)return ok({code:"23505",message:"duplicate"},409);
  if(method==="POST")claimExists=true;return ok(null,200);
 }
 if(url.includes("/rest/v1/position_chart_attachments"))return ok(method==="GET"&&url.includes("image_path%2Cposition_id")?{position_id:1,image_path:"1/a.webp"}:[{id:aid,image_path:"1/a.webp"}]);
 if(url.includes("/rest/v1/active_positions"))return ok({status:closed?"closed":"partially_closed",publish_to_ru:true,archived_to_sheet_at:"2026-10-01"});
 if(url.includes("/storage/v1/object/sign/"))return ok({signedURL:"/object/sign/position-close-charts/1/a.webp?token=temporary"});
 if(url.includes("/storage/v1/object/")&&method==="POST")return ok({Key:"position-close-charts/1/a.webp"});
 if(url.includes("/storage/v1/object/"))return new Response(new Uint8Array([137,80,78,71,13,10,26,10]),{headers:{"Content-Type":"image/png"}});
 if(url.includes("api.telegram.org"))return ok({ok:true,result:{message_id:123}});
 throw Error("Unexpected HTTP "+url);
};
await import("../supabase/functions/position-chart-admin/index.ts");
await import("../supabase/functions/position-chart-media/index.ts");
await import("../supabase/functions/position-chart-reminder/index.ts");
(Deno as any).serve=originalServe;
const request=(body:any,token=true)=>new Request("https://test.supabase.co/functions/v1/test",{method:"POST",headers:{"Content-Type":"application/json",...(token?{authorization:"Bearer test-user"}:{})},body:JSON.stringify(body)});

Deno.test("admin: unauthenticated rejected; nonadmin cannot save; admin list/save only metadata",async()=>{
 assertEquals((await handlers[0](request({action:"list"},false))).status,401);
 role="premium";assertEquals((await handlers[0](request({action:"save",key:"event:2"}))).status,403);
 role="admin";calls=[];
 const list=await handlers[0](request({action:"list"}));assertEquals(list.status,200);assertEquals((await list.json()).rows[0].needs_chart,true);
 const save=await handlers[0](request({action:"save",key:"event:2",chart_url:"https://www.tradingview.com/x/ABC123/"}));assertEquals(save.status,200);
 assert(!calls.some(c=>/partial_closes|position_events|positions-publish|telegram/.test(c.url)));
 assertEquals((await handlers[0](request({action:"save",key:"event:2",chart_url:"https://evil.test/"}))).status,400);
});
Deno.test("media: public cannot read open-position image; paid user gets short-lived access",async()=>{
 closed=false;
 assertEquals((await handlers[1](new Request("https://test.supabase.co/functions/v1/position-chart-media?id="+aid))).status,404);
 closed=true;
 const image=await handlers[1](new Request("https://test.supabase.co/functions/v1/position-chart-media?id="+aid));assertEquals(image.status,200);await image.arrayBuffer();
 role="free";assertEquals((await handlers[1](request({ids:[aid]}))).status,403);
 role="premium";const signed=await handlers[1](request({ids:[aid]}));assertEquals(signed.status,200);assert((await signed.json()).urls[aid]);
 role="admin";
});
Deno.test("reminder: admin dry run never sends; no unauthenticated send",async()=>{
 calls=[];const preview=await handlers[2](request({dry_run:true}));assertEquals(preview.status,200);
 assertEquals((await preview.json()).sent,false);assert(!calls.some(c=>c.url.includes("api.telegram.org")));
 assertEquals((await handlers[2](request({},false))).status,401);
});
Deno.test("reminder: 21:00 Moscow send once, fixed owner, no recipients from input",async()=>{
 const RealDate=Date;
 (globalThis as any).Date=class extends RealDate {constructor(...args:any[]){super(args.length?args[0]:"2026-10-16T18:00:00Z");} static override now(){return new RealDate("2026-10-16T18:00:00Z").getTime();}};
 try{
  claimExists=false;attachment=false;calls=[];
  const req=()=>new Request("https://test.supabase.co/functions/v1/reminder",{method:"POST",headers:{"Content-Type":"application/json","x-cron-secret":"valid-cron-secret"},body:JSON.stringify({chat_id:999})});
  const one=await handlers[2](req());assertEquals(one.status,200);assertEquals((await one.json()).sent,true);
  const two=await handlers[2](req());assertEquals((await two.json()).skipped,"already_claimed");
  const sends=calls.filter(c=>c.url.includes("api.telegram.org"));assertEquals(sends.length,1);assertEquals(sends[0].body.chat_id,118296372);
  claimExists=false;attachment=true;calls=[];
  const silent=await handlers[2](req());assertEquals((await silent.json()).sent,false);
  assert(!calls.some(c=>c.url.includes("api.telegram.org")));
 }finally{globalThis.Date=RealDate;attachment=false;}
});
globalThis.addEventListener("unload",()=>{globalThis.fetch=originalFetch;});
