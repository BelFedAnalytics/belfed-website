(function(){
 'use strict';
 const labels={closed:'Полное закрытие',partial_closed:'Частичное закрытие',stop_hit:'Стоп',target_1_hit:'Цель 1',target_2_hit:'Цель 2',target_3_hit:'Цель 3',partial_stop_1_hit:'Частичный стоп 1',partial_stop_2_hit:'Частичный стоп 2',partial_stop_3_hit:'Частичный стоп 3'};
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=s=>s?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(s)):'—';
 const num=n=>n==null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:8,useGrouping:false}).format(n);
 let root,client,rows=[],selected=null,busy=false,visible=50,imageURL=null,focusBefore;
 const q=s=>root.querySelector(s);
 async function api(body){
  const {data,error}=await client.functions.invoke('position-chart-admin',{body});
  if(error){let text='Не удалось выполнить запрос. Повторите попытку.';try{text=(await error.context.json()).error||text;}catch{}throw Error(text);}
  if(data.error)throw Error(data.error);return data;
 }
 function status(text,bad=false){q('[data-status]').textContent=text;q('[data-status]').classList.toggle('pc-error',bad);}
 function render(){
  const search=q('[data-search]').value.trim().toUpperCase(),filter=q('[data-filter]').value;
  const list=rows.filter(r=>(!search||`${r.ticker} #${r.position_id}`.toUpperCase().includes(search))&&(filter==='all'||filter==='missing'&&r.needs_chart||filter==='complete'&&r.has_chart||filter==='ledger'&&!r.published));
  q('[data-missing]').textContent=rows.filter(r=>r.needs_chart).length;q('[data-complete]').textContent=rows.filter(r=>r.has_chart).length;q('[data-total]').textContent=rows.length;
  q('[data-list]').innerHTML=list.length?list.slice(0,visible).map(r=>`<article class="pc-row">
   <div class="pc-instrument"><strong>${esc(r.ticker)}</strong><span>#${r.position_id} · ${esc(r.direction?.toUpperCase())}</span><small>Вход ${esc(date(r.opened_at))}</small></div>
   <div><span class="pc-label">Закрытие</span><strong>${esc(labels[r.event_type]||'Закрытие')}</strong><span>${esc(date(r.occurred_at))} МСК</span></div>
   <div><span class="pc-label">Доля / цена</span><strong>${r.pct_closed==null?'Доля не записана':esc(num(r.pct_closed))+'%'}</strong><span>по ${esc(num(r.exit_price))}</span></div>
   <div><span class="pc-chip ${r.needs_chart?'pc-chip-missing':r.has_chart?'pc-chip-ready':''}">${r.needs_chart?'Нужен график':r.has_chart?'График добавлен':'Без сигнала'}</span>${r.has_chart?`<small>${r.has_image?'Изображение':''}${r.has_image&&r.chart_url?' + ':''}${r.chart_url?'Ссылка':''}</small>`:''}</div>
   <button type="button" class="pc-button ${r.needs_chart?'pc-primary':''}" data-edit="${esc(r.key)}">${r.has_chart?'Просмотреть / изменить':'Добавить график'}</button></article>`).join(''):'<div class="pc-empty">Нет закрытий по выбранному фильтру.</div>';
  q('[data-count]').textContent=`Показано ${Math.min(list.length,visible)} из ${list.length}`;q('[data-more]').hidden=list.length<=visible;
 }
 async function load(){
  status('Загружаем закрытия…');q('[data-refresh]').disabled=true;
  try{rows=(await api({action:'list'})).rows;render();status('Данные обновлены. Учитываются позиции, открытые с 01.09.2026.');}
  catch(e){status(e.message,true);}finally{q('[data-refresh]').disabled=false;}
 }
 function clearImage(){if(imageURL){URL.revokeObjectURL(imageURL);imageURL=null;}}
 function close(){if(busy)return;q('dialog').close();clearImage();selected=null;focusBefore?.focus();}
 async function open(key){
  selected=rows.find(r=>r.key===key);if(!selected)return;
  focusBefore=document.activeElement;clearImage();
  q('[data-title]').textContent=`${selected.ticker} · ${labels[selected.event_type]||'Закрытие'}`;
  q('[data-meta]').textContent=`Позиция #${selected.position_id} · ${date(selected.occurred_at)} МСК · ${selected.pct_closed==null?'доля не записана':num(selected.pct_closed)+'%'} по ${num(selected.exit_price)}`;
  q('[name=chart_url]').value=selected.chart_url||'';q('[name=image]').value='';q('[data-preview]').hidden=true;q('[data-form-status]').textContent='';
  q('dialog').showModal();q('[name=chart_url]').focus();
  if(selected.has_image)try{const d=await api({action:'preview',key});if(selected?.key===key&&d.row.preview_url){q('[data-preview]').src=d.row.preview_url;q('[data-preview]').hidden=false;}}catch{q('[data-form-status]').textContent='Предпросмотр недоступен. Существующее изображение сохранено.';}
 }
 function preview(){
  clearImage();const f=q('[name=image]').files[0];if(!f)return;
  if(f.size>8388608||!['image/png','image/jpeg','image/webp'].includes(f.type)){q('[data-form-status]').textContent='Выберите PNG, JPG или WebP до 8 МБ.';q('[name=image]').value='';return;}
  imageURL=URL.createObjectURL(f);q('[data-preview]').src=imageURL;q('[data-preview]').hidden=false;q('[data-form-status]').textContent='';
 }
 async function raster(file){
  const b=await createImageBitmap(file);
  if(b.width*b.height>32000000){b.close();throw Error('Максимум 32 мегапикселя.');}
  const scale=Math.min(1,2560/Math.max(b.width,b.height)),c=document.createElement('canvas');
  c.width=Math.round(b.width*scale);c.height=Math.round(b.height*scale);c.getContext('2d').drawImage(b,0,0,c.width,c.height);b.close();
  const blob=await new Promise(resolve=>c.toBlob(resolve,'image/webp',0.94));
  if(!blob||blob.size>8388608)throw Error('Не удалось подготовить изображение до 8 МБ.');
  return new File([blob],'chart.webp',{type:'image/webp'});
 }
 async function save(e){
  e.preventDefault();if(busy||!selected)return;
  const f=q('[name=image]').files[0],url=q('[name=chart_url]').value.trim();
  if(!url&&!f&&!selected.has_image){q('[data-form-status]').textContent='Добавьте ссылку или изображение.';return;}
  busy=true;q('[data-save]').disabled=true;q('[data-form-status]').textContent='Сохраняем…';
  try{
   const body=new FormData();body.append('action','save');body.append('key',selected.key);body.append('chart_url',url);body.append('expected_updated_at',selected.attachment_updated_at||'');
   if(f)body.append('image',await raster(f));
   const d=await api(body);busy=false;close();await load();status(d.message);
  }catch(e){q('[data-form-status]').textContent=e.message==='chart_conflict'?'График уже изменён в другой вкладке. Закройте окно и обновите список.':e.message==='invalid_chart_url'?'Нужна ссылка на снимок TradingView вида https://www.tradingview.com/x/…/':e.message;}
  finally{busy=false;q('[data-save]').disabled=false;}
 }
 window.BelfedPositionCharts={mount(options){
  client=options.client;root=options.element;if(root.dataset.mounted)return;root.dataset.mounted='1';
  root.innerHTML=`<section class="pc-audit"><div class="pc-heading"><div><h2>Закрытия и графики</h2><p>Полные и частичные выходы · позиции с 1 сентября 2026</p></div><button type="button" class="pc-button" data-refresh>Обновить</button></div>
   <div class="pc-stats"><div><strong data-missing>—</strong><span>сигналов без графика</span></div><div><strong data-complete>—</strong><span>с графиком</span></div><div><strong data-total>—</strong><span>закрытий в журнале</span></div></div>
   <div class="pc-filters"><div><label for="pc-search">Поиск</label><input id="pc-search" data-search placeholder="Тикер или # позиции" type="search"></div><div><label for="pc-filter">Показать</label><select id="pc-filter" data-filter><option value="missing">Сигналы без графика</option><option value="all">Все закрытия</option><option value="complete">С графиками</option><option value="ledger">Без опубликованного сигнала</option></select></div></div>
   <p class="pc-note">Напоминание владельцу: ежедневно в 21:00 МСК, только если есть пропуски. График не меняет цену, долю или R сделки.</p>
   <div class="pc-status" role="status" aria-live="polite" data-status></div><div data-list></div><div class="pc-footer"><span data-count></span><button type="button" class="pc-button" data-more hidden>Показать ещё</button></div></section>
   <dialog class="pc-dialog" aria-labelledby="pc-title"><form><div class="pc-dialog-heading"><h3 id="pc-title" data-title></h3><button class="pc-close" type="button" data-close aria-label="Закрыть окно">×</button></div><p data-meta class="pc-note"></p>
   <label for="pc-url">Ссылка на снимок TradingView</label><input id="pc-url" name="chart_url" type="url" placeholder="https://www.tradingview.com/x/…/" autocomplete="off">
   <label for="pc-image">Изображение графика</label><input id="pc-image" name="image" type="file" accept="image/png,image/jpeg,image/webp">
   <p class="pc-note">PNG, JPG, WebP до 8 МБ. Можно добавить ссылку, изображение или оба. Новый файл заменит изображение этого этапа.</p>
   <img class="pc-preview" data-preview hidden alt="Предпросмотр графика">
   <p class="pc-note">В кабинете: после обновления истории. На публичных сайтах: после полного закрытия позиции и пересборки карточек. Время добавления сохраняется отдельно от времени сделки. Сообщения и письма повторно не отправляются.</p>
   <div role="status" aria-live="polite" class="pc-form-status" data-form-status></div><div class="pc-dialog-actions"><button class="pc-button" data-cancel type="button">Отмена</button><button class="pc-button pc-primary" data-save type="submit">Сохранить график</button></div></form></dialog>`;
  root.addEventListener('click',e=>{const b=e.target.closest('[data-edit]');if(b)open(b.dataset.edit);});
  q('[data-refresh]').onclick=load;q('[data-search]').oninput=q('[data-filter]').onchange=()=>{visible=50;render();};q('[data-more]').onclick=()=>{visible+=50;render();};
  q('[data-close]').onclick=q('[data-cancel]').onclick=close;q('dialog').addEventListener('cancel',e=>{e.preventDefault();close();});
  q('[name=image]').onchange=preview;q('form').onsubmit=save;
  load().then(()=>{const k=new URL(location.href).searchParams.get('closure');if(k)open(k);});
 },refresh:load};
})();
