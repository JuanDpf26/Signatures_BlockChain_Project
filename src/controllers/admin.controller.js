/**
 * PANEL DE ADMINISTRACIÓN
 *
 * El administrador gestiona la plataforma, no el contenido: ve cifras,
 * cuentas, la auditoría de todos y el estado de los servicios, pero nunca
 * el archivo ni el análisis de un documento ajeno, ni las llaves de firma.
 * El rol se asigna en la base de datos (UPDATE users SET role = 'admin').
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { logAudit } = require('../services/audit.service');
const { forget, clearPresence } = require('../services/account.service');

const n = (v) => Number(v) || 0;

// GET /api/admin/overview
const overview = async (req, res) => {
  try {
    const [users, docs, shares, cosign, daily, byMonth, failed] = await Promise.all([
      // Usuarios finales; los superusuarios se cuentan aparte
      pool.query(`SELECT COUNT(*) FILTER (WHERE role <> 'admin') total,
                         COUNT(*) FILTER (WHERE role <> 'admin' AND is_email_verified) verified,
                         COUNT(*) FILTER (WHERE role <> 'admin' AND COALESCE(suspended,false)) suspended,
                         COUNT(*) FILTER (WHERE role <> 'admin' AND created_at > NOW() - INTERVAL '7 days') new_7d,
                         COUNT(*) FILTER (WHERE role <> 'admin' AND last_login > NOW() - INTERVAL '7 days') active_7d,
                         COUNT(*) FILTER (WHERE role = 'admin') admins
                    FROM users`),
      pool.query(`SELECT COUNT(*) total,
                         COUNT(*) FILTER (WHERE status = 'pending') pending,
                         COUNT(*) FILTER (WHERE status = 'signed') signed,
                         COUNT(*) FILTER (WHERE status = 'verified') verified,
                         COUNT(*) FILTER (WHERE metadata->>'revoked' = 'true') revoked,
                         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') new_7d
                    FROM documents`),
      pool.query(`SELECT COUNT(*) total,
                         COUNT(*) FILTER (WHERE kind IN ('review','sign') AND status IN ('sent','read')) pending
                    FROM document_shares`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE metadata->'cosign'->>'status' = 'collecting') collecting,
                         COUNT(*) FILTER (WHERE metadata->'cosign'->>'status' = 'completed') completed
                    FROM documents`),
      pool.query(`SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'America/Bogota'), 'YYYY-MM-DD') AS day,
                         COUNT(*) FILTER (WHERE action LIKE 'document.upload%') uploads,
                         COUNT(*) FILTER (WHERE action LIKE 'signing.confirmed%' OR action = 'cosign.sign') signatures,
                         COUNT(*) FILTER (WHERE action LIKE 'auth.login%' OR action = 'auth.google') logins
                    FROM audit_logs
                   WHERE created_at > NOW() - INTERVAL '14 days'
                   GROUP BY 1 ORDER BY 1`),
      pool.query(`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, COUNT(*) docs
                    FROM documents WHERE created_at > NOW() - INTERVAL '6 months' GROUP BY 1 ORDER BY 1`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE result = 'denegado') denied, COUNT(*) FILTER (WHERE result = 'error') errors
                    FROM audit_logs WHERE created_at > NOW() - INTERVAL '7 days'`),
    ]);
    const u = users.rows[0];
    const d = docs.rows[0];
    return res.json({
      users: { total: n(u.total), verified: n(u.verified), suspended: n(u.suspended), new7d: n(u.new_7d), active7d: n(u.active_7d), admins: n(u.admins) },
      documents: { total: n(d.total), pending: n(d.pending), signed: n(d.signed), verified: n(d.verified), revoked: n(d.revoked), new7d: n(d.new_7d) },
      requests: { total: n(shares.rows[0].total), pending: n(shares.rows[0].pending), cosignCollecting: n(cosign.rows[0].collecting), cosignCompleted: n(cosign.rows[0].completed) },
      security7d: { denied: n(failed.rows[0].denied), errors: n(failed.rows[0].errors) },
      daily: daily.rows.map((r) => ({ day: r.day, uploads: n(r.uploads), signatures: n(r.signatures), logins: n(r.logins) })),
      monthly: byMonth.rows.map((r) => ({ month: r.month, docs: n(r.docs) })),
    });
  } catch (err) {
    console.error('ERROR ADMIN OVERVIEW:', err);
    return res.status(500).json({ error: 'No se pudo cargar el resumen' });
  }
};

// GET /api/admin/users?q=&page=&filter=all|unverified|suspended|admins
const listUsers = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = 20;
    const where = [];
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(lower(u.email) LIKE $${params.length} OR lower(u.name) LIKE $${params.length})`);
    }
    const f = String(req.query.filter || 'all');
    if (f === 'unverified') where.push('NOT u.is_email_verified');
    if (f === 'suspended') where.push('COALESCE(u.suspended, false)');
    // Superusuarios solo en su filtro; el resto de la lista son usuarios finales
    where.push(f === 'admins' ? "u.role = 'admin'" : "u.role <> 'admin'");
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = n((await pool.query(`SELECT COUNT(*) FROM users u ${w}`, params)).rows[0].count);
    params.push(limit, (page - 1) * limit);
    const r = await pool.query(
      `SELECT u.id, u.name, u.email, u.is_email_verified, u.google_id IS NOT NULL AS google, u.role,
              COALESCE(u.suspended, false) AS suspended, u.created_at, u.last_login,
              (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id) AS documents,
              (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id AND d.status IN ('signed','verified')) AS signed,
              (SELECT EXTRACT(EPOCH FROM (NOW() - p.last_seen))::int FROM user_presence p WHERE p.user_id = u.id) AS seen_ago
         FROM users u ${w}
        ORDER BY u.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return res.json({
      users: r.rows.map((x) => ({ ...x, documents: n(x.documents), signed: n(x.signed), online: x.seen_ago != null && n(x.seen_ago) <= ONLINE_SECONDS })),
      pagination: { total, page, pages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    console.error('ERROR ADMIN USERS:', err);
    return res.status(500).json({ error: 'No se pudo cargar la lista de usuarios' });
  }
};

// POST /api/admin/users/:id/suspend { suspended: bool, reason? }
const setSuspended = async (req, res) => {
  try {
    const id = String(req.params.id);
    if (id === String(req.user.id)) return res.status(400).json({ error: 'No puedes suspender tu propia cuenta' });
    const suspended = req.body?.suspended !== false;
    const target = (await pool.query('SELECT id, email, role FROM users WHERE id::text = $1', [id])).rows[0];
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.role === 'admin') return res.status(400).json({ error: 'No se puede suspender a otro administrador desde la app' });
    await pool.query('UPDATE users SET suspended = $1, suspended_at = CASE WHEN $1 THEN NOW() ELSE NULL END WHERE id = $2', [suspended, target.id]);
    forget(target.id); // la suspensión aplica en la siguiente petición
    if (suspended) clearPresence(target.id);
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    res.locals.auditDetail = { target: target.email, suspended, reason: reason || null };
    logAudit({
      userId: req.user.id,
      action: suspended ? 'admin.suspend' : 'admin.reactivate',
      description: `${suspended ? 'Suspendió' : 'Reactivó'} la cuenta ${target.email}`,
      resource: String(target.id),
      result: 'permitido',
      detail: { reason: reason || null },
    });
    return res.json({ message: suspended ? `Cuenta de ${target.email} suspendida` : `Cuenta de ${target.email} reactivada`, suspended });
  } catch (err) {
    console.error('ERROR ADMIN SUSPEND:', err);
    return res.status(500).json({ error: 'No se pudo actualizar la cuenta' });
  }
};

// POST /api/admin/users/:id/resend-verification
const resendVerification = async (req, res) => {
  try {
    const u = (await pool.query('SELECT id, name, email, is_email_verified FROM users WHERE id::text = $1', [String(req.params.id)])).rows[0];
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (u.is_email_verified) return res.status(409).json({ error: 'Esa cuenta ya verificó su correo' });
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      "UPDATE users SET email_verification_token = $1, email_verification_expires = NOW() + INTERVAL '24 hours' WHERE id = $2",
      [token, u.id]
    );
    await require('../services/email.service').sendVerificationEmail(u.email, u.name, token);
    logAudit({ userId: req.user.id, action: 'admin.resend_verification', description: `Reenvió la verificación a ${u.email}`, resource: String(u.id), result: 'permitido' });
    return res.json({ message: `Correo de verificación reenviado a ${u.email}` });
  } catch (err) {
    console.error('ERROR ADMIN RESEND:', err);
    return res.status(502).json({ error: 'No se pudo reenviar el correo' });
  }
};

// GET /api/admin/audit?result=&action=&q=&page=
const audit = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = 50;
    const where = [];
    const params = [];
    if (['permitido', 'denegado', 'error'].includes(req.query.result)) {
      params.push(req.query.result);
      where.push(`a.result = $${params.length}`);
    }
    if (req.query.action) {
      params.push(`${String(req.query.action).replace(/[^a-z_.]/gi, '')}%`);
      where.push(`a.action LIKE $${params.length}`);
    }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim().toLowerCase().slice(0, 80)}%`);
      where.push(`(lower(COALESCE(a.actor_email, u.email, '')) LIKE $${params.length} OR a.ip LIKE $${params.length} OR lower(COALESCE(a.description, '')) LIKE $${params.length})`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = n((await pool.query(`SELECT COUNT(*) FROM audit_logs a LEFT JOIN users u ON u.id::text = a.user_id ${w}`, params)).rows[0].count);
    params.push(limit, (page - 1) * limit);
    const r = await pool.query(
      `SELECT a.id, a.created_at, a.action, a.description, a.result, a.status_code, a.ip, a.method, a.path, a.resource,
              COALESCE(a.actor_email, u.email) AS email, u.name
         FROM audit_logs a LEFT JOIN users u ON u.id::text = a.user_id
         ${w}
        ORDER BY a.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return res.json({ events: r.rows, pagination: { total, page, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (err) {
    console.error('ERROR ADMIN AUDIT:', err);
    return res.status(500).json({ error: 'No se pudo cargar la auditoría' });
  }
};

// GET /api/admin/health → estado de cada servicio externo
const health = async (req, res) => {
  const out = {};
  const t = async (key, fn) => {
    const start = Date.now();
    try {
      const r = await fn();
      out[key] = { ok: r.ok !== false, ms: Date.now() - start, ...r };
    } catch (e) {
      out[key] = { ok: false, ms: Date.now() - start, detail: e.message };
    }
  };
  await Promise.all([
    t('database', async () => {
      await pool.query('SELECT 1');
      return { detail: 'Responde' };
    }),
    t('blockchain', async () => {
      const info = await require('../services/blockchain.service').getNetworkInfo();
      if (!info.connected) return { ok: false, detail: info.error || 'Sin conexión' };
      const bal = Number(info.balanceEth || 0);
      return {
        ok: true,
        warn: bal < 0.02,
        detail: `Bloque #${info.latestBlock} · saldo ${bal.toFixed(4).replace('.', ',')} SepoliaETH${bal < 0.02 ? ' (bajo)' : ''}`,
        balanceEth: bal,
        wallet: info.wallet,
        contractUrl: info.contractUrl,
        totalDocuments: info.totalDocuments,
      };
    }),
    t('storage', async () => {
      const { data, error } = await require('../config/supabase').storage.getBucket('documents');
      if (error) return { ok: false, detail: error.message };
      return { detail: data.public ? 'Archivos PÚBLICOS: deberían ser privados' : 'Archivos privados', warn: !!data.public };
    }),
    t('email', async () => {
      const ok = await require('../services/email.service').verifyEmailTransport();
      return { ok, detail: ok ? 'Configurado' : 'Revisa las variables del correo' };
    }),
    t('ai', async () => ({
      ok: !!String(process.env.GROQ_API_KEY || '').trim(),
      detail: String(process.env.GROQ_API_KEY || '').trim() ? 'Llave configurada' : 'Falta GROQ_API_KEY',
    })),
    t('reminders', async () => ({
      ok: String(process.env.REMINDERS_ENABLED || '').toLowerCase() !== 'false',
      detail: String(process.env.REMINDERS_ENABLED || '').toLowerCase() === 'false' ? 'Desactivados' : 'Activos cada hora',
    })),
  ]);
  out.server = { ok: true, detail: `Activo hace ${Math.round(process.uptime() / 60)} min · Node ${process.version}` };
  return res.json(out);
};

// POST /api/admin/reminders/run → envía ya los recordatorios pendientes (no espera a la próxima hora)
const runRemindersNow = async (req, res) => {
  const sent = await require('../services/reminder.service').runReminders();
  logAudit({ userId: req.user.id, action: 'admin.reminders', description: `Ejecutó los recordatorios (${sent} enviados)`, result: 'permitido' });
  return res.json({ message: sent ? `${sent} recordatorios enviados` : 'No hay recordatorios pendientes por enviar', sent });
};

// ─────────────────────────────────────────
// EN VIVO
// ─────────────────────────────────────────
const ONLINE_SECONDS = 120; // la app envía un latido cada 45 s
const PRESENCE_SQL = `
  SELECT p.user_id AS id, u.name, u.email, u.role, u.avatar_url,
         p.section, p.platform, p.ip, p.first_seen, p.last_seen,
         EXTRACT(EPOCH FROM (NOW() - p.last_seen))::int AS seconds_ago,
         EXTRACT(EPOCH FROM (p.last_seen - p.first_seen))::int AS session_seconds
    FROM user_presence p JOIN users u ON u.id = p.user_id`;

// GET /api/admin/live
const live = async (req, res) => {
  try {
    const [people, events, today] = await Promise.all([
      pool.query(`${PRESENCE_SQL} WHERE p.last_seen > NOW() - INTERVAL '15 minutes' ORDER BY p.last_seen DESC LIMIT 100`),
      pool.query(
        `SELECT a.id, a.created_at, a.action, a.description, a.result, a.ip,
                COALESCE(a.actor_email, u.email) AS email, u.name
           FROM audit_logs a LEFT JOIN users u ON u.id::text = a.user_id::text
          WHERE a.action <> 'auth.token_rejected'
          ORDER BY a.created_at DESC LIMIT 20`
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE action IN ('auth.login','auth.google') AND result = 'permitido') logins,
                COUNT(DISTINCT user_id) FILTER (WHERE result = 'permitido') people,
                COUNT(*) FILTER (WHERE result = 'denegado' AND action NOT IN ('auth.token_rejected', 'auth.logout')) denied
           FROM audit_logs
          WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'`
      ),
    ]);
    const rows = people.rows.map((r) => ({ ...r, online: n(r.seconds_ago) <= ONLINE_SECONDS, seconds_ago: n(r.seconds_ago), session_seconds: n(r.session_seconds) }));
    const online = rows.filter((r) => r.online);
    return res.json({
      online: online.length,
      onlineUsers: online.filter((r) => r.role !== 'admin').length,
      onlineAdmins: online.filter((r) => r.role === 'admin').length,
      recent: rows.length,
      today: { logins: n(today.rows[0].logins), people: n(today.rows[0].people), denied: n(today.rows[0].denied) },
      people: rows,
      events: events.rows,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error('ERROR ADMIN LIVE:', err);
    return res.status(500).json({ error: 'No se pudo cargar la actividad en vivo' });
  }
};

// GET /api/admin/users/:id — ficha de la cuenta (sin contenido de documentos)
const userDetail = async (req, res) => {
  try {
    const id = String(req.params.id);
    const u = (await pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.avatar_url, u.is_email_verified, u.google_id IS NOT NULL AS google,
              COALESCE(u.suspended, false) AS suspended, u.suspended_at, u.created_at, u.last_login,
              COALESCE(u.email_reminders, true) AS email_reminders,
              (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id) AS documents,
              (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id AND d.status IN ('signed','verified')) AS signed,
              (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id AND d.status = 'pending') AS pending
         FROM users u WHERE u.id::text = $1`, [id])).rows[0];
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const [presence, activity, stats] = await Promise.all([
      pool.query(`${PRESENCE_SQL} WHERE p.user_id::text = $1`, [id]),
      pool.query(
        `SELECT id, created_at, action, description, result, ip FROM audit_logs
          WHERE user_id::text = $1 ORDER BY created_at DESC LIMIT 25`, [id]),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE action IN ('auth.login','auth.google') AND result = 'permitido' AND created_at > NOW() - INTERVAL '30 days') logins30,
                COUNT(*) FILTER (WHERE result = 'denegado' AND created_at > NOW() - INTERVAL '30 days') denied30,
                COUNT(DISTINCT ip) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') ips30
           FROM audit_logs WHERE user_id::text = $1`, [id]),
    ]);
    const p = presence.rows[0];
    return res.json({
      user: { ...u, documents: n(u.documents), signed: n(u.signed), pending: n(u.pending) },
      presence: p ? { ...p, seconds_ago: n(p.seconds_ago), session_seconds: n(p.session_seconds), online: n(p.seconds_ago) <= ONLINE_SECONDS } : null,
      stats: { logins30: n(stats.rows[0].logins30), denied30: n(stats.rows[0].denied30), ips30: n(stats.rows[0].ips30) },
      activity: activity.rows,
    });
  } catch (err) {
    console.error('ERROR ADMIN USER DETAIL:', err);
    return res.status(500).json({ error: 'No se pudo cargar la cuenta' });
  }
};

// POST /api/admin/users/:id/logout — cierra todas las sesiones abiertas de esa cuenta
const forceLogout = async (req, res) => {
  try {
    const id = String(req.params.id);
    if (id === String(req.user.id)) return res.status(400).json({ error: 'Para cerrar tu propia sesión usa "Cerrar sesión"' });
    const t = (await pool.query('SELECT id, email, role FROM users WHERE id::text = $1', [id])).rows[0];
    if (!t) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (t.role === 'admin') return res.status(400).json({ error: 'No se puede cerrar la sesión de otro superusuario desde la app' });
    await pool.query('UPDATE users SET session_version = COALESCE(session_version, 0) + 1 WHERE id = $1', [t.id]);
    forget(t.id);
    await clearPresence(t.id);
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    logAudit({
      userId: req.user.id,
      action: 'admin.force_logout',
      description: `Cerró las sesiones de ${t.email}`,
      resource: String(t.id),
      result: 'permitido',
      detail: { reason: reason || null },
    });
    return res.json({ message: `Se cerraron las sesiones de ${t.email}. Tendrá que volver a ingresar.` });
  } catch (err) {
    console.error('ERROR ADMIN FORCE LOGOUT:', err);
    return res.status(500).json({ error: 'No se pudo cerrar la sesión' });
  }
};

module.exports = { overview, listUsers, setSuspended, resendVerification, audit, health, runRemindersNow, live, userDetail, forceLogout };
