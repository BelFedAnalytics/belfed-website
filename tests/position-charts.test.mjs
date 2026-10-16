import test from 'node:test';
import assert from 'node:assert/strict';
import { closureRows, normalizeLink, imageType, buildReminder, isReminderSlot, mediaUrl, publicMediaAllowed } from '../supabase/functions/_shared/position-charts.mjs';

const p = {id:1,ticker:'BTC',direction:'long',asset_class:'crypto',opened_at:'2026-09-01T00:00:00+03:00',closed_at:'2026-10-02T10:00:00Z',status:'closed',exit_price:110,publish_to_ru:true,archived_to_sheet_at:'2026-10-02'};
const ev = (id,type,at,price,more={}) => ({id,position_id:1,event_type:type,triggered_at:at,triggered_price:price,message_id_ru:id,payload:{},...more});
const pc = (id,at,price,pct=25) => ({id,position_id:1,closed_at:at,exit_price:price,pct_closed:pct});
test('all published full and partial exits, including partials on open positions',()=>{
  const rows=closureRows({positions:[{...p,status:'partially_closed'}],events:[ev(1,'target_1_hit','2026-09-20T10:00:00Z',105)],partials:[pc(2,'2026-09-20T10:00:02Z',105)]});
  assert.equal(rows.length,1); assert.equal(rows[0].pct_closed,25); assert.equal(rows[0].needs_chart,true);
});
test('cutoff uses opening timestamp in Moscow, not date of closing',()=>{
  const rows=closureRows({positions:[{...p,opened_at:'2026-08-31T20:59:59Z'}],events:[ev(1,'closed',p.closed_at,110)],partials:[]});
  assert.equal(rows.length,0);
});
test('explicit IDs precede unique price/time fallback and terminal close is not doubled',()=>{
  const at=p.closed_at;
  const rows=closureRows({positions:[p],events:[ev(1,'partial_closed',at,110),ev(2,'closed',at,110,{payload:{partial_close_id:2}})],partials:[pc(2,at,110,50),pc(3,at,110,25)]});
  assert.equal(rows.length,2); assert.equal(rows.find(r=>r.event_id===2).partial_close_id,2);
  assert.equal(rows.find(r=>r.event_id===1).partial_close_id,3);
});
test('silent ledger records are visible but not counted as missing closing signals',()=>{
  const rows=closureRows({positions:[p],events:[],partials:[pc(2,p.closed_at,110)]});
  assert.equal(rows.length,1); assert.equal(rows[0].needs_chart,false); assert.equal(rows[0].published,false);
});
test('event with email delivery but no Telegram ID is still a closing signal',()=>{
  const rows=closureRows({positions:[p],events:[ev(1,'closed',p.closed_at,110,{message_id_ru:null,email_sent_at:p.closed_at})],partials:[]});
  assert.equal(rows[0].needs_chart,true);
});
test('cancelled/merged/non-closure events do not enter the list',()=>{
  assert.equal(closureRows({positions:[{...p,status:'cancelled'}],events:[ev(1,'closed',p.closed_at,110)],partials:[]}).length,0);
  assert.equal(closureRows({positions:[p],events:[ev(1,'stop_moved',p.closed_at,110)],partials:[]}).length,0);
});
test('uploaded attachment or saved valid chart clears gap without modifying input',()=>{
  const input={positions:[p],events:[ev(1,'closed',p.closed_at,110)],partials:[pc(2,p.closed_at,110)],attachments:[{id:'abc',event_id:1,partial_close_id:2,image_path:'a.png'}]};
  const before=JSON.stringify(input), rows=closureRows(input);
  assert.equal(rows.length,1);assert.equal(rows[0].needs_chart,false);assert.equal(JSON.stringify(input),before);
});
test('only supported HTTPS snapshot links count, not arbitrary pages or spoofed domains',()=>{
  assert.ok(normalizeLink('https://www.tradingview.com/x/AbC123/'));
  for(const u of ['https://tradingview.com.evil/x/ABC','http://tradingview.com/x/ABC','javascript:x','https://example.com/page','https://tradingview.com@evil/x/ABC'])assert.equal(normalizeLink(u),'');
});
test('PNG/JPEG/WebP magic bytes checked; reject SVG or mismatched type',()=>{
  assert.equal(imageType(Uint8Array.from([137,80,78,71,13,10,26,10]),'image/png'),'png');
  assert.equal(imageType(new TextEncoder().encode('<svg>'),'image/png'),null);
  assert.equal(imageType(Uint8Array.from([255,216,255,224]),'image/png'),null);
});
test('reminder silent on empty gaps, capped, escaped and links to exact admin event',()=>{
  assert.equal(buildReminder([],'2026-10-16'),null);
  const rows=Array.from({length:30},(_,i)=>({key:'event:'+i,ticker:'<BTC>',position_id:1,occurred_at:p.closed_at,event_type:'stop_hit',needs_chart:true,pct_closed:25}));
  const msg=buildReminder(rows,'2026-10-16');
  assert.ok(msg.text.length<4000);assert.ok(msg.text.includes('&lt;BTC&gt;'));assert.ok(msg.text.includes('30'));
  assert.match(msg.reply_markup.inline_keyboard[0][0].url,/tab=charts/);
});
test('21:00 Moscow schedule, not midnight, and public image gating',()=>{
  assert.equal(isReminderSlot(new Date('2026-10-16T18:00:00Z')),true);
  assert.equal(isReminderSlot(new Date('2026-10-16T17:59:00Z')),false);
  assert.equal(publicMediaAllowed(p),true);
  assert.equal(publicMediaAllowed({...p,status:'partially_closed'}),false);
  assert.equal(publicMediaAllowed({...p,publish_to_ru:false,publish_to_en:false}),false);
  assert.match(mediaUrl('https://test.supabase.co','abcd'),/position-chart-media\?id=abcd$/);
});
