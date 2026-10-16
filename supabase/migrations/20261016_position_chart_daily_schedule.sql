-- Enable only after the endpoints and owner destination are approved.
-- 18:00 UTC = 21:00 Europe/Moscow. No AI/Computer scheduled run is involved.
select cron.schedule('position-chart-reminder-daily','0 18 * * *',$cron$
 select net.http_post(
  url:='https://obujqvqqmyfcfflhqvud.supabase.co/functions/v1/position-chart-reminder',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',
   (select decrypted_secret from vault.decrypted_secrets where name='belfed_cron_secret')),
  body:='{}'::jsonb,timeout_milliseconds:=60000);
$cron$);
