// Shared deterministic audit. No model calls; never modifies trading records.
export const CUTOFF = '2026-09-01T00:00:00+03:00';
export const MAX_IMAGE = 8 * 1024 * 1024;
const EXITS = new Set(['closed','partial_closed','stop_hit','target_1_hit','target_2_hit','target_3_hit','partial_stop_1_hit','partial_stop_2_hit','partial_stop_3_hit']);
export const LABELS = {closed:'Полное закрытие',partial_closed:'Частичное закрытие',stop_hit:'Стоп',target_1_hit:'Цель 1',target_2_hit:'Цель 2',target_3_hit:'Цель 3',partial_stop_1_hit:'Частичный стоп 1',partial_stop_2_hit:'Частичный стоп 2',partial_stop_3_hit:'Частичный стоп 3'};
const ts = v => Date.parse(v) || 0;
const equalPrice = (a,b) => a!=null && b!=null && Math.abs(Number(a)-Number(b))<=Math.max(1e-8,Math.abs(Number(b))*1e-9);
export function normalizeLink(value) {
  try {
    const u=new URL(String(value||'').trim());
    if(u.protocol!=='https:'||u.username||u.password||u.port)return '';
    if(['tradingview.com','www.tradingview.com'].includes(u.hostname)&&/^\/x\/[a-zA-Z0-9]+\/?$/.test(u.pathname))return u.origin+u.pathname;
    if(u.hostname==='s3.tradingview.com'&&/^\/snapshots\/[a-z0-9]\/[a-zA-Z0-9]+\.png$/.test(u.pathname))return u.origin+u.pathname;
  } catch {}
  return '';
}
export function imageType(bytes, mime) {
  const b=bytes, ascii=(i,n)=>String.fromCharCode(...b.slice(i,i+n));
  if(mime==='image/png'&&[137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v))return 'png';
  if(mime==='image/jpeg'&&b[0]===255&&b[1]===216&&b[2]===255)return 'jpg';
  if(mime==='image/webp'&&ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP')return 'webp';
  return null;
}
export const mediaUrl=(base,id)=>`${base}/functions/v1/position-chart-media?id=${encodeURIComponent(id)}`;
export const publicMediaAllowed=p=>p?.status==='closed'&&!!p.archived_to_sheet_at&&!!(p.publish_to_ru||p.publish_to_en)&&!p.merged_into;

export function closureRows(data) {
  const result=[];
  for(const p of data.positions||[]){
    if(ts(p.opened_at)<ts(CUTOFF)||p.merged_into||p.status==='cancelled')continue;
    const events=(data.events||[]).filter(e=>e.position_id===p.id&&EXITS.has(e.event_type)).sort((a,b)=>ts(a.triggered_at)-ts(b.triggered_at)||a.id-b.id);
    const pcs=(data.partials||[]).filter(c=>c.position_id===p.id);
    const matches=new Map(),used=new Set();
    for(const e of events){
      const id=e.payload?.partial_close_id;
      const pc=pcs.find(c=>id!=null&&String(c.id)===String(id));
      if(pc&&!used.has(pc)){matches.set(e,pc);used.add(pc);}
    }
    for(const e of events){
      if(matches.has(e))continue;
      const final=['closed','stop_hit'].includes(e.event_type), price=e.triggered_price??(final?p.exit_price:null);
      const candidates=pcs.filter(c=>{
        if(used.has(c)||!ts(c.closed_at)||Math.abs(ts(c.closed_at)-ts(e.triggered_at))>60000)return false;
        const type=String(c.comment_en||c.comment_ru||'').match(/\b(target_[123]_hit|partial_stop_[123]_hit|stop_hit)\b/i)?.[1];
        if(type&&type.toLowerCase()!==e.event_type)return false;
        return equalPrice(c.exit_price,price)||(final&&Math.abs(ts(p.closed_at)-ts(e.triggered_at))<=60000&&equalPrice(c.exit_price,p.exit_price));
      });
      if(candidates.length===1){matches.set(e,candidates[0]);used.add(candidates[0]);}
    }
    const add=(e,c)=>{
      const a=(data.attachments||[]).find(a=>(e&&a.event_id===e.id)||(c&&a.partial_close_id===c.id));
      const link=a?.chart_url||e?.chart_url||c?.chart_url||'';
      const published=!!(e&&(e.message_id_ru||e.message_id_en||e.email_sent_at));
      const hasChart=!!(a?.image_path||normalizeLink(link));
      result.push({
        key:e?`event:${e.id}`:`partial:${c.id}`,position_id:p.id,ticker:p.ticker,asset_class:p.asset_class,direction:p.direction,
        opened_at:p.opened_at,position_status:p.status,event_id:e?.id??null,partial_close_id:c?.id??null,
        event_type:e?.event_type||(Number(c.remaining_after)===0?'closed':'partial_closed'),
        occurred_at:e?.triggered_at||c.closed_at,exit_price:c?.exit_price??e?.triggered_price??p.exit_price,
        pct_closed:c?.pct_closed??null,chart_url:link,attachment_id:a?.id??null,
        image_path:a?.image_path??null,attachment_updated_at:a?.updated_at??null,
        chart_added_at:a?.updated_at||e?.chart_added_at||null,
        message_id_ru:e?.message_id_ru??null,message_id_en:e?.message_id_en??null,
        published,has_chart:hasChart,needs_chart:published&&!hasChart,
      });
    };
    for(const e of events)add(e,matches.get(e));
    for(const c of pcs)if(!used.has(c))add(null,c);
  }
  return result.sort((a,b)=>ts(b.occurred_at)-ts(a.occurred_at)||b.position_id-a.position_id);
}
export function moscowDay(now=new Date()){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
export function isReminderSlot(now=new Date()){
  const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',hour:'numeric',minute:'numeric',hourCycle:'h23'}).formatToParts(now);
  return Number(p.find(p=>p.type==='hour').value)===21&&Number(p.find(p=>p.type==='minute').value)<15;
}
const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
export function buildReminder(rows,day){
  const missing=rows.filter(r=>r.needs_chart);
  if(!missing.length)return null;
  const today=missing.filter(r=>moscowDay(new Date(r.occurred_at))===day).length;
  const lines=missing.slice(0,15).map(r=>{
    const date=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit'}).format(new Date(r.occurred_at));
    return `• ${esc(r.ticker)} #${r.position_id}: ${LABELS[r.event_type]||'Закрытие'}${r.pct_closed!=null?` ${r.pct_closed}%`:''}, ${date}`;
  });
  return {text:[`<b>BelFed: нужны графики закрытий</b>`,`Без графика: ${missing.length}. Из них сегодня: ${today}.`,`Позиции, открытые с 01.09.2026.`,...lines,missing.length>15?`Ещё ${missing.length-15} в админке.`:'',`Добавьте ссылку TradingView или изображение к соответствующему закрытию.`].filter(Boolean).join('\n'),
    reply_markup:{inline_keyboard:[[{text:'Добавить недостающие графики',url:'https://belfed.ru/admin-positions.html?tab=charts&missing=1'}]]}};
}
