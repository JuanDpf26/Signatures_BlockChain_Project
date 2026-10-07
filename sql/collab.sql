-- ─────────────────────────────────────────────────────────────
-- BlockSign · Bandeja de entrada y equipos
-- Ejecutar en Supabase → SQL Editor (el backend también lo crea al arrancar).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.teams (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  color        TEXT,
  owner_id     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.team_members (
  team_id   UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  added_by  TEXT,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON public.team_members (user_id);

CREATE TABLE IF NOT EXISTS public.document_shares (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id               UUID NOT NULL,
  document_id            TEXT NOT NULL,
  sender_id              TEXT NOT NULL,
  recipient_id           TEXT,
  recipient_email        TEXT NOT NULL,
  team_id                UUID REFERENCES public.teams(id) ON DELETE SET NULL,
  subject                TEXT,
  message                TEXT,
  kind                   TEXT NOT NULL DEFAULT 'info' CHECK (kind IN ('info','review')),
  status                 TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','read','approved','rejected')),
  response               TEXT,
  attached               BOOLEAN NOT NULL DEFAULT FALSE,
  archived_by_recipient  BOOLEAN NOT NULL DEFAULT FALSE,
  archived_by_sender     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at                TIMESTAMPTZ,
  responded_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_shares_recipient  ON public.document_shares (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_rcpt_email ON public.document_shares (lower(recipient_email), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_sender     ON public.document_shares (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_batch      ON public.document_shares (batch_id);

-- Solo el backend (conexión directa con DATABASE_URL) usa estas tablas.
-- Con RLS activo y sin políticas, la API pública de Supabase (anon / authenticated)
-- no puede leerlas ni modificarlas.
ALTER TABLE public.teams           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_shares ENABLE ROW LEVEL SECURITY;
