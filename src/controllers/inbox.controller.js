const crypto = require('crypto');
const pool = require('../config/db');
const { getUser } = require('../services/collab.service');
const { sendShareResponseEmail, sendDocumentEmail } = require('../services/email.service');
const storage = require('../services/storage.service');
const { publicCosign } = require('./cosign.controller');

const BOXES = ['received', 'sent', 'archived', 'flagged', 'deleted'];
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

const UUID_RE = /^[0-9a-f-]{36}$/i;

const DOC_FIELDS = `d.title AS doc_title, d.file_hash, d.status AS doc_status,
  d.metadata->>'extension' AS doc_ext, d.metadata->>'size_mb' AS doc_size_mb`;

/** GET /api/inbox?box=received|sent|archived|flagged|deleted&q= */
const listInbox = async (req, res) => {
  try {
    const me = await getUser(req.user.id);
    if (!me) return res.status(401).json({ error: 'Sesión inválida' });
    const box = BOXES.includes(req.query.box) ? req.query.box : 'received';
    const q = String(req.query.q || '').trim();
    const params = box === 'sent' ? [String(me.id)] : [String(me.id), String(me.email || '').toLowerCase()];
    let search = '';
    if (q) {
      params.push(`%${q}%`);
      search = ` AND (d.title ILIKE $${params.length} OR s.subject ILIKE $${params.length} OR s.message ILIKE $${params.length})`;
    }

    if (box === 'sent') {
      const r = await pool.query(
        `SELECT s.batch_id AS id, s.batch_id, MIN(s.created_at) AS created_at, MAX(s.subject) AS subject,
                MAX(s.message) AS message, MAX(s.kind) AS kind, s.document_id, ${DOC_FIELDS},
                BOOL_OR(s.attached) AS attached,
                json_agg(json_build_object('email', s.recipient_email, 'name', ru.name, 'status', s.status,
                         'response', s.response, 'read_at', s.read_at, 'responded_at', s.responded_at,
                         'team', t.name) ORDER BY s.recipient_email) AS recipients
           FROM document_shares s
           JOIN documents d ON d.id::text = s.document_id
           LEFT JOIN users ru ON ru.id::text = s.recipient_id
           LEFT JOIN teams t ON t.id = s.team_id
          WHERE s.sender_id = $1 AND s.archived_by_sender = FALSE AND s.deleted_by_sender = FALSE ${search}
          GROUP BY s.batch_id, s.document_id, d.title, d.file_hash, d.status, d.metadata
          ORDER BY MIN(s.created_at) DESC LIMIT 100`,
        params
      );
      return res.json({ box, items: r.rows });
    }

    const where = {
      received: 's.archived_by_recipient = FALSE AND s.deleted_by_recipient = FALSE',
      archived: 's.archived_by_recipient = TRUE AND s.deleted_by_recipient = FALSE',
      flagged: 's.flagged = TRUE AND s.deleted_by_recipient = FALSE',
      deleted: 's.deleted_by_recipient = TRUE',
    }[box];
    const r = await pool.query(
      `SELECT s.id, s.batch_id, s.created_at, s.subject, s.message, s.kind, s.status, s.response, s.read_at,
              s.responded_at, s.attached, s.flagged, s.parent_id, s.document_id, ${DOC_FIELDS},
              u.name AS sender_name, u.email AS sender_email, t.name AS team_name, t.color AS team_color
         FROM document_shares s
         JOIN documents d ON d.id::text = s.document_id
         LEFT JOIN users u ON u.id::text = s.sender_id
         LEFT JOIN teams t ON t.id = s.team_id
        WHERE (s.recipient_id = $1 OR lower(s.recipient_email) = $2)
          AND ${where} ${search}
        ORDER BY s.created_at DESC LIMIT 100`,
      params
    );
    return res.json({ box, items: r.rows });
  } catch (err) {
    console.error('ERROR INBOX:', err.message);
    return res.status(500).json({ error: 'No se pudo cargar la bandeja' });
  }
};

/** GET /api/inbox/summary → no leídos y revisiones pendientes */
const inboxSummary = async (req, res) => {
  try {
    const me = await getUser(req.user.id);
    if (!me) return res.json({ unread: 0, pending_reviews: 0, flagged: 0 });
    const r = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'sent' AND archived_by_recipient = FALSE)::int AS unread,
              COUNT(*) FILTER (WHERE kind IN ('review','sign') AND status IN ('sent','read') AND archived_by_recipient = FALSE)::int AS pending_reviews,
              COUNT(*) FILTER (WHERE flagged)::int AS flagged
         FROM document_shares
        WHERE (recipient_id = $1 OR lower(recipient_email) = $2) AND deleted_by_recipient = FALSE`,
      [String(me.id), String(me.email || '').toLowerCase()]
    );
    return res.json(r.rows[0]);
  } catch (err) {
    return res.json({ unread: 0, pending_reviews: 0 });
  }
};

/** Busca un envío visible para el usuario: como destinatario (por id) o remitente (por batch) */
const findShare = async (id, me) => {
  const asRecipient = await pool.query(
    `SELECT s.*, u.name AS sender_name, u.email AS sender_email, t.name AS team_name
       FROM document_shares s
       LEFT JOIN users u ON u.id::text = s.sender_id
       LEFT JOIN teams t ON t.id = s.team_id
      WHERE s.id = $1 AND (s.recipient_id = $2 OR lower(s.recipient_email) = $3)`,
    [id, String(me.id), String(me.email || '').toLowerCase()]
  );
  if (asRecipient.rows.length) return { share: asRecipient.rows[0], role: 'recipient' };
  const asSender = await pool.query(
    `SELECT s.*, ru.name AS recipient_name, t.name AS team_name
       FROM document_shares s
       LEFT JOIN users ru ON ru.id::text = s.recipient_id
       LEFT JOIN teams t ON t.id = s.team_id
      WHERE (s.batch_id = $1 OR s.id = $1) AND s.sender_id = $2
      ORDER BY s.recipient_email`,
    [id, String(me.id)]
  );
  if (asSender.rows.length) return { share: asSender.rows[0], recipients: asSender.rows, role: 'sender' };
  return null;
};

/** GET /api/inbox/:id → detalle (marca como leído si eres destinatario) */
const getInboxItem = async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Mensaje no encontrado' });
    const me = await getUser(req.user.id);
    const found = me && (await findShare(id, me));
    if (!found) return res.status(404).json({ error: 'Mensaje no encontrado' });
    const { share, role } = found;

    if (role === 'recipient' && share.status === 'sent') {
      await pool.query("UPDATE document_shares SET status = 'read', read_at = NOW() WHERE id = $1", [share.id]);
      share.status = 'read';
      share.read_at = new Date().toISOString();
    }
    const d = await pool.query(
      `SELECT d.id, d.title, d.file_url, d.file_hash, d.status, d.created_at, d.blockchain_tx, d.metadata, u.name AS owner_name
         FROM documents d LEFT JOIN users u ON u.id::text = d.user_id::text WHERE d.id::text = $1`,
      [share.document_id]
    );
    const doc = d.rows[0];
    const m = doc?.metadata || {};
    const document = doc && {
      id: doc.id,
      title: doc.title,
      file_url: await storage.signedUrl(doc.file_url),
      file_hash: doc.file_hash,
      status: doc.status,
      owner_name: doc.owner_name,
      extension: m.extension || null,
      size_mb: m.size_mb || null,
      pages: m.pages || null,
      category: (m.category_source === 'manual' ? m.category : m.ai_category || m.category) || 'Documento',
      description: m.user_description || m.ai_description || null,
      cosign: publicCosign(m.cosign) || null,
      blockchain_tx: m.blockchain_tx || doc.blockchain_tx || null,
      blockchain_block: m.blockchain_block || null,
      blockchain_explorer: m.blockchain_explorer || null,
      signed_at: m.signed_at || null,
    };
    return res.json({
      role,
      share,
      recipients: found.recipients?.map((r) => ({
        email: r.recipient_email, name: r.recipient_name, status: r.status, response: r.response,
        read_at: r.read_at, responded_at: r.responded_at, team: r.team_name,
      })),
      document,
    });
  } catch (err) {
    console.error('ERROR INBOX ITEM:', err.message);
    return res.status(500).json({ error: 'No se pudo abrir el mensaje' });
  }
};

/** POST /api/inbox/:id/respond {decision: approved|rejected, comment} */
const respond = async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Mensaje no encontrado' });
    const me = await getUser(req.user.id);
    const found = me && (await findShare(id, me));
    if (!found || found.role !== 'recipient') return res.status(404).json({ error: 'Mensaje no encontrado' });
    const { share } = found;
    if (share.kind !== 'review') return res.status(400).json({ error: 'Este documento se envió solo para conocimiento' });
    if (['approved', 'rejected'].includes(share.status)) return res.status(409).json({ error: 'Ya respondiste esta solicitud' });
    const decision = req.body?.decision === 'rejected' ? 'rejected' : req.body?.decision === 'approved' ? 'approved' : null;
    if (!decision) return res.status(400).json({ error: 'Elige aprobar o rechazar' });
    const comment = String(req.body?.comment || '').trim().slice(0, 1000);
    if (decision === 'rejected' && !comment) return res.status(400).json({ error: 'Cuéntale a quien lo envió por qué lo rechazas' });

    const r = await pool.query(
      `UPDATE document_shares SET status = $1, response = $2, responded_at = NOW(), read_at = COALESCE(read_at, NOW())
        WHERE id = $3 RETURNING *`,
      [decision, comment || null, share.id]
    );
    res.locals.auditDetail = { decision };

    // Aviso por correo a quien lo envió (si falla, la respuesta igual queda guardada)
    const [sender, doc] = await Promise.all([
      getUser(share.sender_id),
      pool.query('SELECT title FROM documents WHERE id::text = $1', [share.document_id]),
    ]);
    if (sender?.email) {
      sendShareResponseEmail({
        to: sender.email,
        senderName: sender.name,
        reviewer: { name: me.name, email: me.email },
        title: doc.rows[0]?.title || 'el documento',
        decision,
        comment,
      }).catch((e) => console.warn('[bandeja] No se pudo avisar al remitente:', e.message));
    }
    return res.json({ message: decision === 'approved' ? 'Aprobaste el documento' : 'Rechazaste el documento', share: r.rows[0] });
  } catch (err) {
    console.error('ERROR RESPOND:', err.message);
    return res.status(500).json({ error: 'No se pudo guardar tu respuesta' });
  }
};

/** POST /api/inbox/:id/archive {archived: true|false} */
const archive = async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Mensaje no encontrado' });
    const me = await getUser(req.user.id);
    const found = me && (await findShare(id, me));
    if (!found) return res.status(404).json({ error: 'Mensaje no encontrado' });
    const value = req.body?.archived !== false;
    if (found.role === 'recipient') {
      await pool.query('UPDATE document_shares SET archived_by_recipient = $1 WHERE id = $2', [value, found.share.id]);
    } else {
      await pool.query('UPDATE document_shares SET archived_by_sender = $1 WHERE batch_id = $2 AND sender_id = $3', [value, found.share.batch_id, String(me.id)]);
    }
    return res.json({ message: value ? 'Archivado' : 'Movido a la bandeja' });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo archivar' });
  }
};

/** Encuentra el envío o responde 404; solo para el usuario con sesión */
const load = async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: 'Mensaje no encontrado' });
    return null;
  }
  const me = await getUser(req.user.id);
  const found = me && (await findShare(id, me));
  if (!found) {
    res.status(404).json({ error: 'Mensaje no encontrado' });
    return null;
  }
  return { me, ...found };
};

/** POST /api/inbox/:id/read {read: true|false} → leído / no leído */
const markRead = async (req, res) => {
  try {
    const f = await load(req, res);
    if (!f) return;
    if (f.role !== 'recipient') return res.json({ message: 'Sin cambios' });
    const read = req.body?.read !== false;
    if (read) {
      await pool.query("UPDATE document_shares SET status = 'read', read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND status = 'sent'", [f.share.id]);
    } else {
      await pool.query("UPDATE document_shares SET status = 'sent', read_at = NULL WHERE id = $1 AND status = 'read'", [f.share.id]);
    }
    return res.json({ message: read ? 'Marcado como leído' : 'Marcado como no leído' });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo actualizar el mensaje' });
  }
};

/** POST /api/inbox/:id/flag {flagged: true|false} → marcar para seguimiento */
const flag = async (req, res) => {
  try {
    const f = await load(req, res);
    if (!f) return;
    if (f.role !== 'recipient') return res.status(400).json({ error: 'Solo puedes marcar los mensajes que recibiste' });
    const value = req.body?.flagged !== false;
    await pool.query('UPDATE document_shares SET flagged = $1 WHERE id = $2', [value, f.share.id]);
    return res.json({ message: value ? 'Marcado para seguimiento' : 'Marca quitada', flagged: value });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo marcar el mensaje' });
  }
};

/** POST /api/inbox/:id/delete {deleted: true|false} → Eliminados (o restaurar) */
const remove = async (req, res) => {
  try {
    const f = await load(req, res);
    if (!f) return;
    const value = req.body?.deleted !== false;
    if (f.role === 'recipient') {
      await pool.query('UPDATE document_shares SET deleted_by_recipient = $1, flagged = CASE WHEN $1 THEN FALSE ELSE flagged END WHERE id = $2', [value, f.share.id]);
    } else {
      await pool.query('UPDATE document_shares SET deleted_by_sender = $1 WHERE batch_id = $2 AND sender_id = $3', [value, f.share.batch_id, String(f.me.id)]);
    }
    return res.json({ message: value ? 'Movido a Eliminados' : 'Restaurado' });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo eliminar el mensaje' });
  }
};

/** Datos del documento para el correo */
const docForEmail = async (documentId) => {
  const r = await pool.query('SELECT id, title, file_url, file_hash, status, blockchain_tx, metadata FROM documents WHERE id::text = $1', [documentId]);
  const d = r.rows[0];
  if (!d) return null;
  const m = d.metadata || {};
  return {
    row: d,
    info: {
      title: d.title,
      hash: d.file_hash,
      signed: ['signed', 'verified'].includes(d.status),
      txHash: m.blockchain_tx || d.blockchain_tx || null,
      blockNumber: m.blockchain_block ?? null,
      explorerUrl: m.blockchain_explorer || null,
      signedAt: m.signed_at || null,
      fileUrl: await storage.signedUrl(d.file_url, { ttl: storage.EMAIL_TTL }),
    },
  };
};

/** Crea los envíos (uno por destinatario) y manda los correos con el enlace del documento */
const deliver = async ({ me, documentId, targets, subject, message, parentId }) => {
  const doc = await docForEmail(documentId);
  if (!doc) throw Object.assign(new Error('El documento ya no existe'), { status: 404 });
  const emails = [...new Set(targets.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].filter(
    (e) => e !== String(me.email || '').toLowerCase()
  );
  if (!emails.length) throw Object.assign(new Error('No hay a quién enviarlo'), { status: 400 });
  const reg = await pool.query('SELECT id, name, email FROM users WHERE lower(email) = ANY($1)', [emails]);
  const byEmail = Object.fromEntries(reg.rows.map((u) => [u.email.toLowerCase(), u]));
  const sender = { name: me.name, email: me.email };

  const inApp = emails.filter((e) => byEmail[e]);
  const outside = emails.filter((e) => !byEmail[e]);
  for (const [g, isIn] of [[inApp, true], [outside, false]]) {
    if (!g.length) continue;
    await sendDocumentEmail({
      to: g.length === 1 ? g[0] : sender.email,
      bcc: g.length === 1 ? undefined : g.join(', '),
      sender, subject, message, attachment: null, kind: 'info', inApp: isIn, doc: doc.info,
    });
  }
  const batch = crypto.randomUUID();
  for (const e of emails) {
    await pool.query(
      `INSERT INTO document_shares (batch_id, document_id, sender_id, recipient_id, recipient_email, subject, message, kind, attached, parent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'info',FALSE,$8)`,
      [batch, String(documentId), String(me.id), byEmail[e] ? String(byEmail[e].id) : null, e, subject || null, message || null, parentId || null]
    );
  }
  return emails;
};

const subjectOf = async (share) => {
  if (share.subject) return share.subject;
  const d = await pool.query('SELECT title FROM documents WHERE id::text = $1', [share.document_id]);
  return d.rows[0]?.title || 'Documento';
};

/** POST /api/inbox/:id/reply {message} → responde a quien lo envió (o a todos, si lo enviaste tú) */
const reply = async (req, res) => {
  try {
    const f = await load(req, res);
    if (!f) return;
    const message = String(req.body?.message || '').trim().slice(0, 2000);
    if (!message) return res.status(400).json({ error: 'Escribe tu respuesta' });
    let targets;
    if (f.role === 'recipient') {
      const s = await getUser(f.share.sender_id);
      targets = s?.email ? [s.email] : [];
    } else {
      targets = (f.recipients || []).map((r) => r.recipient_email);
    }
    const base = await subjectOf(f.share);
    const subject = /^re:/i.test(base) ? base : `RE: ${base}`;
    const sent = await deliver({ me: f.me, documentId: f.share.document_id, targets, subject, message, parentId: f.share.id });
    if (f.role === 'recipient' && f.share.status === 'sent') {
      await pool.query("UPDATE document_shares SET status = 'read', read_at = NOW() WHERE id = $1", [f.share.id]);
    }
    return res.json({ message: `Respuesta enviada a ${sent.join(', ')}`, sent_to: sent });
  } catch (err) {
    console.error('ERROR REPLY:', err.message);
    return res.status(err.status || 502).json({ error: err.status ? err.message : `No se pudo enviar la respuesta: ${err.message}` });
  }
};

/** POST /api/inbox/:id/forward {recipients: [...], message} → reenvía el documento a otras personas */
const forward = async (req, res) => {
  try {
    const f = await load(req, res);
    if (!f) return;
    const b = req.body || {};
    const raw = Array.isArray(b.recipients) ? b.recipients : String(b.recipients || '').split(/[,;\s]+/);
    const emails = [...new Set(raw.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
    if (!emails.length) return res.status(400).json({ error: 'Escribe al menos un correo' });
    if (emails.length > 5) return res.status(400).json({ error: 'Puedes reenviar a máximo 5 correos a la vez' });
    const bad = emails.filter((e) => !EMAIL_RE.test(e) || e.length > 120);
    if (bad.length) return res.status(400).json({ error: `Correo no válido: ${bad.join(', ')}` });
    const message = String(b.message || '').trim().slice(0, 2000);
    const base = await subjectOf(f.share);
    const subject = /^rv:/i.test(base) ? base : `RV: ${base}`;
    const sent = await deliver({ me: f.me, documentId: f.share.document_id, targets: emails, subject, message, parentId: f.share.id });
    return res.json({ message: `Reenviado a ${sent.join(', ')}`, sent_to: sent });
  } catch (err) {
    console.error('ERROR FORWARD:', err.message);
    return res.status(err.status || 502).json({ error: err.status ? err.message : `No se pudo reenviar: ${err.message}` });
  }
};

/** POST /api/inbox/:id/remind → quien envió una revisión o firma recuerda a quienes no han respondido */
const remind = async (req, res) => {
  try {
    const f = await load(req, res);
    if (!f) return;
    if (f.role !== 'sender') return res.status(403).json({ error: 'Solo quien envió la solicitud puede enviar recordatorios' });
    if (!['review', 'sign'].includes(f.share.kind)) return res.status(400).json({ error: 'Solo se recuerdan revisiones o firmas pendientes' });
    const { SHARE_SQL, remindShare } = require('../services/reminder.service');
    const rows = (await pool.query(
      `${SHARE_SQL} WHERE s.batch_id = $1 AND s.kind IN ('review','sign') AND s.status IN ('sent','read')`,
      [f.share.batch_id]
    )).rows;
    if (!rows.length) return res.status(409).json({ error: 'Todos ya respondieron' });
    const ready = rows.filter((r) => !r.last_reminded_at || Date.now() - new Date(r.last_reminded_at).getTime() > 24 * 3600000);
    if (!ready.length) return res.status(429).json({ error: 'Ya enviaste un recordatorio en las últimas 24 horas' });
    for (const r of ready) await remindShare(r, { manual: true });
    return res.json({ message: `Recordatorio enviado a ${ready.length} ${ready.length === 1 ? 'persona' : 'personas'}`, sent: ready.length });
  } catch (err) {
    console.error('ERROR REMIND:', err.message);
    return res.status(502).json({ error: 'No se pudo enviar el recordatorio' });
  }
};

module.exports = { listInbox, inboxSummary, getInboxItem, respond, archive, markRead, flag, remove, reply, forward, remind };
