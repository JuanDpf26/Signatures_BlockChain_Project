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
  const r = await pool.query('SELECT role, suspended FROM users WHERE id::text = $1', [key]);
  const value = r.rows[0] ? { role: r.rows[0].role || 'user', suspended: !!r.rows[0].suspended, exists: true } : { exists: false };
  cache.set(key, { at: Date.now(), value });
  return value;
};

const forget = (userId) => cache.delete(String(userId));

module.exports = { initAccount, accountState, forget };
