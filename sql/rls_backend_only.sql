-- ─────────────────────────────────────────────────────────────
-- BlockSign · Proteger tablas que solo usa el backend
-- Ejecutar una vez en Supabase → SQL Editor.
-- El backend se conecta directo a PostgreSQL (DATABASE_URL, usuario postgres),
-- que ignora RLS, así que nada deja de funcionar. Lo que se bloquea es el acceso
-- por la API REST pública de Supabase con la anon key.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE IF EXISTS public.audit_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_keys       ENABLE ROW LEVEL SECURITY;  -- llaves privadas cifradas
ALTER TABLE IF EXISTS public.teams           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.team_members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.document_shares ENABLE ROW LEVEL SECURITY;

-- Comprobar qué tablas de public tienen RLS:
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY 1;
