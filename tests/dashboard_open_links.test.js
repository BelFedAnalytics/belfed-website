#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260824_028_dashboard_open_position_links.sql'),
  'utf8'
);
const executableMigration = migration.replace(/^--.*$/gm, '');
let failures = 0;

function ok(condition, message) {
  if (condition) console.log('  ok   - ' + message);
  else { console.error('  FAIL - ' + message); failures++; }
}

function extractFunction(name) {
  const marker = 'function ' + name + '(';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(name + ' not found');
  let depth = 0;
  let end = -1;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const context = { TG_OPEN_CHAT: '3773738299', TG_OPEN_TOPIC: '4' };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end) + '\nthis.fn=' + name + ';', context);
  return context.fn;
}

console.log('RU dashboard open-position links');
ok(/<table id="openTable">[\s\S]*?data-col="entryDate">Дата открытия<\/th>[\s\S]*?<th>Telegram<\/th>/.test(html),
  'таблица открытых позиций показывает дату открытия и Telegram');
ok(/tgUrl:\(r\[12\]\|\|''\)\.trim\(\)/.test(html),
  'ссылка Telegram из Google Sheet остаётся резервным источником');
ok(/rpc\('get_open_position_links'\)/.test(html),
  'метаданные открытых позиций загружаются через ограниченный RPC');
ok(/await enrichOpenTelegramLinks\(allTrades\)/.test(html),
  'позиции обогащаются до первой отрисовки');
ok(/<td>'\+t\.entryDate\+'<\/td><td>'\+telegramLink\(t\.tgUrl\)/.test(html),
  'строка позиции выводит дату и затем ссылку на сообщение открытия');
ok(/renderClosedWeekRows[\s\S]*?tvLink\(t\.tvUrl\)/.test(html),
  'у закрытых сделок сохраняется ссылка на график TradingView');

const buildTelegramUrl = extractFunction('buildTelegramUrl');
ok(buildTelegramUrl(1860) === 'https://t.me/c/3773738299/4/1860',
  'RU message ID ведёт в RU-тему для участников');
ok(buildTelegramUrl(null) === '', 'при отсутствии message ID ссылка не выдумывается');

ok(/SECURITY DEFINER/i.test(migration), 'RPC выполняется как SECURITY DEFINER');
ok(/message_id_en[\s\S]*message_id_ru/i.test(migration), 'RPC возвращает только нужные языковые message ID');
ok(/GRANT EXECUTE[\s\S]*TO anon, authenticated/i.test(migration),
  'RPC доступен обоим вариантам входа в дэшборд');
ok(!/comment_(ru|en)|payload|telegram_id|user_id/i.test(executableMigration),
  'RPC не раскрывает комментарии, payload или пользовательские данные');

if (failures) process.exit(1);
console.log('\nВсе RU dashboard-link проверки пройдены.');
