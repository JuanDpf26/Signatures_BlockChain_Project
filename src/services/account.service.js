/**
 * Datos de cuenta que se agregaron después: rol (administrador), suspensión
 * y preferencia de recordatorios. También las columnas de recordatorios en
 * la bandeja. Se crean al arrancar si no existen.
 */
const pool = require('../config/db');

const initAccount = async () => {
  try {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_reminders BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE document_shares ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE document_shares ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE TABLE IF NOT EXISTS user_presence (
        user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        section    TEXT,
        platform   TEXT,
        ip         TEXT,
        user_agent TEXT
      );
    `);
    console.log('👤 [Cuentas] Rol, suspensión y recordatorios listos');
  } catch (err) {
    console.error('❌ [Cuentas] No se pudieron preparar las columnas:', err.message);
  }
};

// Estado de la cuenta en memoria por 30 s: evita una consulta por cada petición
const cache = new Map();
const TTL = 30 * 1000;

const accountState = async (userId) => {
  const key = String(userId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const r = await pool.query('SELECT role, suspended, COALESCE(session_version, 0) AS sv, COALESCE(must_change_password, false) AS mcp FROM users WHERE id::text = $1', [key]);
  const value = r.rows[0]
    ? { role: r.rows[0].role || 'user', suspended: !!r.rows[0].suspended, sessionVersion: Number(r.rows[0].sv) || 0, mustChangePassword: !!r.rows[0].mcp, exists: true }
    : { exists: false };
  cache.set(key, { at: Date.now(), value });
  return value;
};

const forget = (userId) => cache.delete(String(userId));

// ── Presencia: quién tiene la app abierta ahora mismo ────────────────
// Cada petición con sesión marca "visto" (máximo una escritura cada 30 s por
// persona). La app además envía un latido cada 45 s con la sección abierta.
// Si alguien no da señales en más de 5 minutos, su siguiente visita abre
// una nueva conexión (first_seen vuelve a empezar).
const lastWrite = new Map();
const WRITE_EVERY = 30 * 1000;

const touchPresence = async (userId, { ip = null, userAgent = null, section, platform } = {}) => {
  const key = String(userId);
  const beat = section !== undefined || platform !== undefined;
  if (!beat && Date.now() - (lastWrite.get(key) || 0) < WRITE_EVERY) return;
  lastWrite.set(key, Date.now());
  try {
    await pool.query(
      `INSERT INTO user_presence (user_id, first_seen, last_seen, section, platform, ip, user_agent)
       VALUES ($1::uuid, NOW(), NOW(), $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         first_seen = CASE WHEN user_presence.last_seen < NOW() - INTERVAL '5 minutes' THEN NOW() ELSE user_presence.first_seen END,
         last_seen  = NOW(),
         section    = COALESCE(EXCLUDED.section, user_presence.section),
         platform   = COALESCE(EXCLUDED.platform, user_presence.platform),
         ip         = COALESCE(EXCLUDED.ip, user_presence.ip),
         user_agent = COALESCE(EXCLUDED.user_agent, user_presence.user_agent)`,
      [key, section ?? null, platform ?? null, ip, userAgent ? String(userAgent).slice(0, 300) : null]
    );
  } catch (_) {
    // la presencia es informativa: si falla no se interrumpe nada
  }
};

const clearPresence = async (userId) => {
  lastWrite.delete(String(userId));
  await pool.query('DELETE FROM user_presence WHERE user_id::text = $1', [String(userId)]).catch(() => {});
};

module.exports = { initAccount, accountState, forget, touchPresence, clearPresence };
