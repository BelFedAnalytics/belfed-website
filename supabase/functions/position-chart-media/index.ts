import {db,BUCKET,authenticate,json,cors,fail} from "../_shared/position-charts-http.ts";
import {publicMediaAllowed} from "../_shared/position-charts.mjs";
const uuid=(s:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors(req)});
 try {
  if(req.method==="POST"){
   await authenticate(req);
   const {ids}=await req.json();
   if(!Array.isArray(ids)||ids.length>100||ids.some(x=>typeof x!=="string"||!uuid(x)))throw new Error("invalid_ids");
   const {data:assets,error}=await db.from("position_chart_attachments").select("id,image_path").in("id",ids);
   if(error)throw new Error("media_unavailable");
   const urls:Record<string,string>={};
   for(const a of assets||[]){
    if(!a.image_path)continue;
    const {data,error}=await db.storage.from(BUCKET).createSignedUrl(a.image_path,3600);
    if(error)throw new Error("media_unavailable");
    urls[a.id]=data.signedUrl;
   }
   return json(req,{urls});
  }
  if(req.method!=="GET")return json(req,{error:"method_not_allowed"},405);
  const id=new URL(req.url).searchParams.get("id")||"";
  if(!uuid(id))return json(req,{error:"not_found"},404);
  const {data:a,error}=await db.from("position_chart_attachments").select("image_path,position_id").eq("id",id).maybeSingle();
  if(error||!a?.image_path)return json(req,{error:"not_found"},404);
  const {data:p,error:pe}=await db.from("active_positions").select("status,archived_to_sheet_at,publish_to_ru,publish_to_en,merged_into").eq("id",a.position_id).single();
  if(pe||!publicMediaAllowed(p))return json(req,{error:"not_found"},404);
  const {data:file,error:fe}=await db.storage.from(BUCKET).download(a.image_path);
  if(fe||!file)throw new Error("media_unavailable");
  return new Response(file,{headers:{...cors(req),"Content-Type":file.type,
   "Cache-Control":"public,max-age=300","X-Content-Type-Options":"nosniff",
   "Content-Security-Policy":"default-src 'none'; sandbox"}});
 }catch(e){return fail(req,e);}
});
