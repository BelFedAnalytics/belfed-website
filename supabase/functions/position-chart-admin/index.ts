import {db,BUCKET,audit,authenticate,withPreview,json,cors,fail,boundedBody} from "../_shared/position-charts-http.ts";
import {normalizeLink,imageType,MAX_IMAGE} from "../_shared/position-charts.mjs";
Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors(req)});
 if(req.method!=="POST")return json(req,{error:"method_not_allowed"},405);
 let uploaded:string|null=null,committed=false;
 try {
  const user=await authenticate(req,true);
  if(Number(req.headers.get("content-length")||0)>MAX_IMAGE+65536)throw new Error("invalid_file_size");
  const multipart=(req.headers.get("content-type")||"").includes("multipart/form-data");
  const bytes=await boundedBody(req,multipart?MAX_IMAGE+65536:65536);
  const input:any=multipart?await new Response(bytes,{headers:{"Content-Type":req.headers.get("content-type")!}}).formData():JSON.parse(new TextDecoder().decode(bytes));
  const get=(k:string)=>multipart?input.get(k):input[k];
  const action=get("action")||"list";
  if(action==="list"){
   const rows=await audit();
   // Only resolve a selected upload preview, not N signed URLs on every audit.
   const clean=rows.map(({image_path,...r}:any)=>({...r,has_image:!!image_path}));
   return json(req,{rows:clean,cutoff:"2026-09-01",timezone:"Europe/Moscow",reminder_time:"21:00"});
  }
  if(action==="preview"){
   const row=(await audit()).find((r:any)=>r.key===get("key"));
   if(!row)throw new Error("invalid_closure");
   return json(req,{row:await withPreview(row)});
  }
  if(action!=="save")throw new Error("invalid_action");
  const row=(await audit()).find((r:any)=>r.key===get("key"));
  if(!row)throw new Error("invalid_closure");
  const raw=String(get("chart_url")||"").trim(),link=normalizeLink(raw);
  if(raw&&!link)throw new Error("invalid_chart_url");
  const file=multipart?get("image"):null;
  if(file instanceof File&&file.size){
   if(file.size>MAX_IMAGE)throw new Error("invalid_file_size");
   const bytes=new Uint8Array(await file.arrayBuffer()),ext=imageType(bytes,file.type);
   if(!ext)throw new Error("invalid_image_type");
   uploaded=`${row.position_id}/${crypto.randomUUID()}.${ext}`;
   const {error}=await db.storage.from(BUCKET).upload(uploaded,bytes,{contentType:file.type,upsert:false,cacheControl:"300"});
   if(error)throw new Error("upload_failed");
  }
  if(!link&&!uploaded&&!row.image_path)throw new Error("invalid_empty_chart");
  const {data,error}=await db.rpc("position_chart_save",{
   p_position_id:row.position_id,p_event_id:row.event_id,p_partial_id:row.partial_close_id,
   p_chart_url:link||null,p_image_path:uploaded,p_expected_updated_at:get("expected_updated_at")||null,p_actor:user.id
  });
  if(error)throw new Error(error.code==="40001"?"chart_conflict":"save_failed");
  committed=true;
  return json(req,{ok:true,attachment_id:data.id,updated_at:data.updated_at,
   message:"График сохранён. В кабинете появится после обновления истории; публичные карточки обновляются по расписанию."});
 }catch(e){
  if(uploaded&&!committed)await db.storage.from(BUCKET).remove([uploaded]);
  return fail(req,e);
 }
});
