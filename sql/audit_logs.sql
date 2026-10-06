-- Tabla de auditoría de BlockSign.
-- El servidor la crea solo al arrancar; este archivo queda como referencia
-- (o para crearla a mano en el SQL Editor de Supabase).
CREATE TABLE IF NOT EXISTS audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id      TEXT,
  actor_email  TEXT,
  action       TEXT NOT NULL,          -- p. ej. auth.login, document.upload, signing.sign
  description  TEXT,
  resource     TEXT,                   -- id del documento o huella abreviada
  result       TEXT NOT NULL,          -- permitido | denegado | error
  status_code  INTEGER,
  ip           TEXT,
  user_agent   TEXT,
  request_id   TEXT,                   -- también va en la cabecera X-Request-Id
  method       TEXT,
  path         TEXT,
  detail       JSONB                   -- datos extra (nunca contraseñas ni tokens)
);
CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_email   ON audit_logs (actor_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);
