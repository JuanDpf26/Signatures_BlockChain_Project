// ────────────────────────────────────────────────
// COLABORACIÓN: equipos y bandeja de entrada
// Tablas: teams, team_members y document_shares.
// Los ids de usuario y documento se guardan como TEXT para no depender
// del tipo exacto de las tablas users/documents.
// ────────────────────────────────────────────────
const pool = require('../config/db');

let ready = false;

const initCollab = async () => {
  try {
    await pool.query(`

      CREATE TABLE IF NOT EXISTS teams (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name         TEXT NOT NULL,
        description  TEXT,
        color        TEXT,
        owner_id     TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS team_members (
        team_id   UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id   TEXT NOT NULL,
        role      TEXT NOT NULL DEFAULT 'member',   -- owner | admin | member
        added_by  TEXT,
        added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (team_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);

      CREATE TABLE IF NOT EXISTS document_shares (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id               UUID NOT NULL,
        document_id            TEXT NOT NULL,
        sender_id              TEXT NOT NULL,
        recipient_id           TEXT,
        recipient_email        TEXT NOT NULL,
        team_id                UUID REFERENCES teams(id) ON DELETE SET NULL,
        subject                TEXT,
        message                TEXT,
        kind                   TEXT NOT NULL DEFAULT 'info',   -- info | review
        status                 TEXT NOT NULL DEFAULT 'sent',   -- sent | read | approved | rejected
        response               TEXT,
        attached               BOOLEAN NOT NULL DEFAULT FALSE,
        archived_by_recipient  BOOLEAN NOT NULL DEFAULT FALSE,
        archived_by_sender     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        read_at                TIMESTAMPTZ,
        responded_at           TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_shares_recipient ON document_shares (recipient_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_shares_rcpt_email ON document_shares (lower(recipient_email), created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_shares_sender ON document_shares (sender_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_shares_batch ON document_shares (batch_id);
    `);
    ready = true;
    console.log('👥 [Colaboración] Tablas de equipos y bandeja listas');
  } catch (err) {
    console.error('❌ [Colaboración] No se pudieron crear las tablas:', err.message);
  }
};

const isReady = () => ready;

/** Usuario actual (id, nombre, correo) */
const getUser = async (id) => {
  const r = await pool.query('SELECT id, name, email FROM users WHERE id::text = $1', [String(id)]);
  return r.rows[0] || null;
};

/** Rol del usuario en un equipo (o null si no pertenece) */
const roleIn = async (teamId, userId) => {
  const r = await pool.query('SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, String(userId)]);
  return r.rows[0]?.role || null;
};

module.exports = { initCollab, isReady, getUser, roleIn };
