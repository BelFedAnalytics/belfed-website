const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const context={console,URL,setTimeout,window:{},location:{hostname:'belfed.ru'},document:{documentElement:{getAttribute:()=> 'ru'},readyState:'loading',addEventListener(){}}};
vm.createContext(context);vm.runInContext(fs.readFileSync('member-trade-history.js','utf8'),context);
const api=context.window.__BFD_MTH__,image='https://obujqvqqmyfcfflhqvud.supabase.co/storage/v1/object/sign/position-close-charts/1/a.webp?token=test';
const p={id:1,ticker:'BTC',direction:'long',status:'closed',result_rr:1,opened_at:'2026-09-01',closed_at:'2026-10-01',
events:[{event_type:'closed',triggered_at:'2026-10-01',chart_image_url:image,message_id_ru:2}],partial_closes:[]};
assert.ok(api.renderCard(p).includes('src="'+image+'"'));
const ledger={...p,events:[],partial_closes:[{id:1,closed_at:'2026-10-01',pct_closed:25,exit_price:100,comment_en:'Auto target_1_hit',chart_image_url:image}]};
assert.ok(api.renderCard(ledger).includes('src="'+image+'"'));
for(const file of ['dashboard.html','ru/trades.html','ru/equities.html']){
 const csp=fs.readFileSync(file,'utf8').match(/img-src ([^;]+)/)[1];
 assert.ok(csp.includes('https://obujqvqqmyfcfflhqvud.supabase.co'),file+' must allow chart images from our private media service');
}
console.log('Member cards display authenticated uploaded charts, including ledger-only exits');
