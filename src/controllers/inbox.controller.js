const pool = require('../config/db');
const { getUser } = require('../services/collab.service');
const { sendShareResponseEmail } = require('../services/email.service');

const UUID_RE = /^[0-9a-f-]{36}$/i;

const DOC_FIELDS = `d.title AS doc_title, d.file_hash, d.status AS doc_status,
  d.metadata->>'extension' AS doc_ext, d.metadata->>'size_mb' AS doc_size_mb`;

/** GET /api/inbox?box=received|sent|archived&q= */
const listInbox = async (req, res) => {
  try {
    const me = await getUser(req.user.id);
    if (!me) return res.status(401).json({ error: 'Sesión inválida' });
    const box = ['received', 'sent', 'archived'].includes(req.query.box) ? req.query.box : 'received';
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
          WHERE s.sender_id = $1 AND s.archived_by_sender = FALSE ${search}
          GROUP BY s.batch_id, s.document_id, d.title, d.file_hash, d.status, d.metadata
          ORDER BY MIN(s.created_at) DESC LIMIT 100`,
        params
      );
      return res.json({ box, items: r.rows });
    }

    const archived = box === 'archived';
    const r = await pool.query(
      `SELECT s.id, s.batch_id, s.created_at, s.subject, s.message, s.kind, s.status, s.response, s.read_at,
              s.responded_at, s.attached, s.document_id, ${DOC_FIELDS},
              u.name AS sender_name, u.email AS sender_email, t.name AS team_name, t.color AS team_color
         FROM document_shares s
         JOIN documents d ON d.id::text = s.document_id
         LEFT JOIN users u ON u.id::text = s.sender_id
         LEFT JOIN teams t ON t.id = s.team_id
        WHERE (s.recipient_id = $1 OR lower(s.recipient_email) = $2)
          AND s.archived_by_recipient = ${archived ? 'TRUE' : 'FALSE'} ${search}
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
    if (!me) return res.json({ unread: 0, pending_reviews: 0 });
    const r = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS unread,
              COUNT(*) FILTER (WHERE kind = 'review' AND status IN ('sent','read'))::int AS pending_reviews
         FROM document_shares
        WHERE (recipient_id = $1 OR lower(recipient_email) = $2) AND archived_by_recipient = FALSE`,
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
      file_url: doc.file_url,
      file_hash: doc.file_hash,
      status: doc.status,
      owner_name: doc.owner_name,
      extension: m.extension || null,
      size_mb: m.size_mb || null,
      pages: m.pages || null,
      category: (m.category_source === 'manual' ? m.category : m.ai_category || m.category) || 'Documento',
      description: m.user_description || m.ai_description || null,
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

module.exports = { listInbox, inboxSummary, getInboxItem, respond, archive };
