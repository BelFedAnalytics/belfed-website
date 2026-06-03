-- Fix: вчерашняя миграция 20260603_004 отозвала EXECUTE с authenticated
-- на helper-функциях is_admin() и _is_admin(). Эти функции вызываются
-- из RLS политик 11 таблиц (включая storage.objects для charts),
-- поэтому INSERT/UPDATE/DELETE/SELECT с RLS падали для admin-пользователей.
--
-- Симптом: "new row violates row-level security policy" при попытке
-- загрузить chart-картинку в asset analysis.
--
-- Возвращаем EXECUTE для authenticated. Сами функции остаются SECURITY DEFINER,
-- внутри они и так делают проверку profiles.is_admin, так что поверхность атаки нулевая —
-- non-admin вызовы возвращают false.

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public._is_admin() TO authenticated;
