-- Возвращаем EXECUTE для authenticated на admin-RPC, которые вызывает фронт
-- из admin-панели. Все они SECURITY DEFINER и внутри проверяют is_admin() —
-- non-admin вызов получит exception.
--
-- Контекст: миграция 20260603_004 отозвала EXECUTE со всех SECURITY DEFINER
-- public-функций, и я вернул только roster_*. Но admin-панель вызывает ещё
-- 5 функций для подписчиков — их и восстанавливаем.
--
-- Симптом: "permission denied for function admin_list_subscribers"
-- при открытии раздела подписчиков в admin-панели.

GRANT EXECUTE ON FUNCTION public.admin_list_subscribers(text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_subscriber_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_extend_subscription(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_access(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_notes(uuid, text) TO authenticated;
