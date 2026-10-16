// ────────────────────────────────────────────────
// NOTIFICACIONES (centro de avisos de la campana)
// Se arman a partir de lo que pasa en la app (envíos, revisiones, firmas,
// análisis, equipos). Cada aviso tiene una clave estable; en
// notification_state se guarda si el usuario lo leyó o lo archivó.
// ────────────────────────────────────────────────
const pool = require('../config/db');

const DAYS = 45; // ventana de avisos

/** Todos los avisos del usuario, del más reciente al más antiguo */
const buildAll = async (userId) => {
  const me = String(userId);
  const since = `NOW() - INTERVAL '${DAYS} days'`;
  const [received, responses, docs, teams] = await Promise.all([
    // Documentos que me compartieron o me pidieron revisar
    pool.query(
      `SELECT s.id, s.kind, s.subject, s.created_at, d.title, u.name AS sender, u.email AS sender_email, t.name AS team
         FROM document_shares s
         JOIN documents d ON d.id::text = s.document_id
         LEFT JOIN users u ON u.id::text = s.sender_id
         LEFT JOIN teams t ON t.id = s.team_id
        WHERE s.recipient_id = $1 AND s.created_at > ${since}
          AND NOT COALESCE(s.deleted_by_recipient, FALSE)
        ORDER BY s.created_at DESC LIMIT 60`,
      [me]
    ),
    // Respuestas a mis solicitudes de revisión
    pool.query(
      `SELECT s.id, s.kind, s.status, s.responded_at, s.response, d.title, s.recipient_email, u.name AS reviewer
         FROM document_shares s
         JOIN documents d ON d.id::text = s.document_id
         LEFT JOIN users u ON u.id::text = s.recipient_id
        WHERE s.sender_id = $1 AND s.status IN ('approved','rejected') AND s.responded_at > ${since}
        ORDER BY s.responded_at DESC LIMIT 60`,
      [me]
    ),
    // Mis documentos: firmas confirmadas y análisis con error
    pool.query(
      `SELECT id, title, status, metadata FROM documents
        WHERE user_id::text = $1 AND (updated_at > ${since} OR created_at > ${since})
        ORDER BY created_at DESC LIMIT 80`,
      [me]
    ).catch(() =>
      pool.query(
        `SELECT id, title, status, metadata FROM documents WHERE user_id::text = $1 ORDER BY created_at DESC LIMIT 80`,
        [me]
      )
    ),
    // Equipos a los que me agregaron
    pool.query(
      `SELECT m.team_id, m.added_at, t.name, u.name AS by_name
         FROM team_members m JOIN teams t ON t.id = m.team_id
         LEFT JOIN users u ON u.id::text = m.added_by
        WHERE m.user_id = $1 AND m.role <> 'owner' AND m.added_by IS DISTINCT FROM m.user_id AND m.added_at > ${since}`,
      [me]
    ),
  ]);

  const out = [];
  for (const r of received.rows) {
    const who = r.sender || r.sender_email || 'Alguien';
    out.push({
      key: `share:${r.id}`,
      type: r.kind === 'review' ? 'review' : r.kind === 'sign' ? 'sign' : 'share',
      text:
        r.kind === 'sign'
          ? `**${who}** te pidió firmar **${r.title}**`
          : r.kind === 'review'
          ? `**${who}** te pidió revisar **${r.title}**${r.team ? ` (equipo ${r.team})` : ''}`
          : `**${who}** te compartió **${r.title}**${r.team ? ` con el equipo ${r.team}` : ''}`,
      date: r.created_at,
      link: { section: 'inbox' },
    });
  }
  for (const r of responses.rows) {
    const ok = r.status === 'approved';
    out.push({
      key: `resp:${r.id}`,
      type: ok ? 'approved' : 'rejected',
      text: `**${r.reviewer || r.recipient_email}** ${r.kind === 'sign' ? (ok ? 'firmó' : 'no quiso firmar') : ok ? 'aprobó' : 'rechazó'} **${r.title}**${r.response ? `: “${String(r.response).slice(0, 90)}”` : ''}`,
      date: r.responded_at,
      link: { section: 'inbox' },
    });
  }
  const cutoff = Date.now() - DAYS * 86400000;
  for (const d of docs.rows) {
    const m = d.metadata || {};
    const signedAt = m.blockchain_confirmed_at || m.signed_at;
    if (['signed', 'verified'].includes(d.status) && signedAt && new Date(signedAt).getTime() > cutoff) {
      out.push({
        key: `signed:${d.id}`,
        type: 'signed',
        text: `**${d.title}** quedó firmado y registrado en blockchain${m.blockchain_block ? ` (bloque ${m.blockchain_block})` : ''}`,
        date: signedAt,
        link: { section: 'documents', title: d.title },
      });
    }
    if (m.ai_error_at && (!m.ai_analyzed_at || m.ai_error_at > m.ai_analyzed_at) && new Date(m.ai_error_at).getTime() > cutoff) {
      out.push({
        key: `aierr:${d.id}:${m.ai_error_at}`,
        type: 'error',
        text: `No se pudo analizar **${d.title}**. Vuelve a intentarlo desde su detalle`,
        date: m.ai_error_at,
        link: { section: 'documents', title: d.title },
      });
    }
    if (m.blockchain_status === 'failed' && m.blockchain_failed_at && new Date(m.blockchain_failed_at).getTime() > cutoff) {
      out.push({
        key: `signfail:${d.id}:${m.blockchain_failed_at}`,
        type: 'error',
        text: `La firma de **${d.title}** no se pudo registrar. Puedes intentarlo de nuevo`,
        date: m.blockchain_failed_at,
        link: { section: 'documents', title: d.title },
      });
    }
  }
  for (const t of teams.rows) {
    out.push({
      key: `team:${t.team_id}`,
      type: 'team',
      text: `**${t.by_name || 'Alguien'}** te agregó al equipo **${t.name}**`,
      date: t.added_at,
      link: { section: 'teams' },
    });
  }
  out.sort((a, b) => new Date(b.date) - new Date(a.date));
  return out;
};

const withState = async (userId, items) => {
  if (!items.length) return [];
  const st = await pool.query('SELECT key, read_at, archived FROM notification_state WHERE user_id = $1 AND key = ANY($2::text[])', [
    String(userId),
    items.map((i) => i.key),
  ]);
  const map = new Map(st.rows.map((r) => [r.key, r]));
  return items.map((i) => ({ ...i, read: !!map.get(i.key)?.read_at, archived: !!map.get(i.key)?.archived }));
};

/** GET /api/notifications?box=inbox|archive */
const list = async (req, res) => {
  try {
    const box = req.query.box === 'archive' ? 'archive' : 'inbox';
    const all = await withState(req.user.id, await buildAll(req.user.id));
    const items = all.filter((n) => (box === 'archive' ? n.archived : !n.archived)).slice(0, 50);
    return res.json({ box, items, unread: all.filter((n) => !n.archived && !n.read).length });
  } catch (err) {
    console.error('ERROR NOTIFICATIONS:', err.message);
    return res.status(500).json({ error: 'No se pudieron cargar las notificaciones' });
  }
};

/** GET /api/notifications/summary → { unread } */
const summary = async (req, res) => {
  try {
    const all = await withState(req.user.id, await buildAll(req.user.id));
    return res.json({ unread: all.filter((n) => !n.archived && !n.read).length });
  } catch (err) {
    return res.json({ unread: 0 });
  }
};

/** Claves a marcar: las indicadas o todas las de la bandeja */
const targetKeys = async (req) => {
  if (Array.isArray(req.body?.keys) && req.body.keys.length) return req.body.keys.map(String).slice(0, 200);
  if (req.body?.all) {
    const all = await withState(req.user.id, await buildAll(req.user.id));
    const fromArchive = req.body?.box === 'archive';
    return all.filter((n) => n.archived === fromArchive).map((n) => n.key);
  }
  return [];
};

/** POST /api/notifications/read { keys?: [], all?: bool, read?: bool } */
const markRead = async (req, res) => {
  try {
    const keys = await targetKeys(req);
    const read = req.body?.read !== false;
    for (const k of keys) {
      await pool.query(
        `INSERT INTO notification_state (user_id, key, read_at) VALUES ($1, $2, ${read ? 'NOW()' : 'NULL'})
         ON CONFLICT (user_id, key) DO UPDATE SET read_at = ${read ? 'COALESCE(notification_state.read_at, NOW())' : 'NULL'}`,
        [String(req.user.id), k]
      );
    }
    return res.json({ updated: keys.length });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo actualizar' });
  }
};

/** POST /api/notifications/archive { keys?: [], all?: bool, archived?: bool } */
const archive = async (req, res) => {
  try {
    const keys = await targetKeys(req);
    const archived = req.body?.archived !== false;
    for (const k of keys) {
      await pool.query(
        `INSERT INTO notification_state (user_id, key, read_at, archived) VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (user_id, key) DO UPDATE SET archived = $3, read_at = COALESCE(notification_state.read_at, NOW())`,
        [String(req.user.id), k, archived]
      );
    }
    return res.json({ updated: keys.length });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo archivar' });
  }
};

module.exports = { list, summary, markRead, archive };
