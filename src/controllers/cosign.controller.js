/**
 * FIRMA CON VARIOS FIRMANTES
 *
 * El dueño del documento pide la firma de varias personas en un orden.
 * Cada una firma, en su turno, con su propia llave ECDSA (queda guardada la
 * firma, su huella y la huella de su llave pública). Cuando firma la última,
 * se calcula una huella combinada de todas las firmas, en orden, y esa es la
 * que se registra en el contrato de Sepolia junto con los correos de todos.
 *
 * Todo el estado vive en documents.metadata.cosign:
 *   { status: collecting | completed | rejected | cancelled,
 *     created_at, created_by, message,
 *     signers: [{ position, user_id, email, name, status: waiting|pending|signed|rejected,
 *                 notified_at, signed_at, signature_hash, signature_value,
 *                 key_fingerprint, comment, share_id }] }
 */
const crypto = require('crypto');
const pool = require('../config/db');
const keys = require('../services/keys.service');
const storage = require('../services/storage.service');
const { logAudit } = require('../services/audit.service');
const { sendDocumentEmail, sendShareResponseEmail } = require('../services/email.service');
const signing = require('./signing.controller');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SIGNERS = 10;

const getUser = async (id) =>
  (await pool.query('SELECT id, name, email FROM users WHERE id::text = $1', [String(id)])).rows[0] || null;

const loadDoc = async (id) => (await pool.query('SELECT * FROM documents WHERE id::text = $1', [String(id)])).rows[0] || null;

const saveCosign = (docId, cosign) =>
  pool.query(
    `UPDATE documents SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{cosign}', $1::jsonb), updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(cosign), docId]
  );

/** Lo que ve la app: sin las firmas completas (solo su huella) */
const publicCosign = (c) =>
  c && {
    status: c.status,
    created_at: c.created_at,
    completed_at: c.completed_at || null,
    message: c.message || null,
    combined_hash: c.combined_hash || null,
    signers: (c.signers || []).map((s) => ({
      position: s.position,
      user_id: s.user_id,
      email: s.email,
      name: s.name,
      status: s.status,
      signed_at: s.signed_at || null,
      signature_hash: s.signature_hash || null,
      key_fingerprint: s.key_fingerprint || null,
      comment: s.comment || null,
    })),
  };

/** Huella combinada: SHA-256 de las huellas de cada firma, en orden */
const combinedHash = (signers) =>
  crypto
    .createHash('sha256')
    .update(signers.map((s) => `${s.position}:${s.email}:${s.signature_hash}`).join('|'))
    .digest('hex');

/** Avisa (bandeja + correo) a quien le toca firmar. Si es el dueño, lo verá en el detalle. */
const notifyTurn = async (doc, cosign, signer, owner) => {
  signer.status = 'pending';
  signer.notified_at = new Date().toISOString();
  if (String(signer.user_id) === String(doc.user_id)) return;
  const subject = `Firma requerida: ${doc.title}`;
  const r = await pool.query(
    `INSERT INTO document_shares (batch_id, document_id, sender_id, recipient_id, recipient_email, subject, message, kind, attached)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'sign',FALSE) RETURNING id`,
    [crypto.randomUUID(), String(doc.id), String(owner.id), String(signer.user_id), signer.email, subject, cosign.message || null]
  );
  signer.share_id = r.rows[0].id;
  const m = doc.metadata || {};
  sendDocumentEmail({
    to: signer.email,
    sender: { name: owner.name, email: owner.email },
    subject,
    message: cosign.message || null,
    kind: 'sign',
    inApp: true,
    doc: {
      title: doc.title,
      hash: doc.file_hash,
      signed: false,
      fileUrl: await storage.signedUrl(doc.file_url, { ttl: storage.EMAIL_TTL }),
      ...(m.extension ? {} : {}),
    },
  }).catch((e) => console.warn('[firmantes] correo de turno:', e.message));
};

// ────────────────────────────────────────────────
// POST /api/signing/:id/request  { signers: [correos en orden], message? }
// ────────────────────────────────────────────────
const requestSignatures = async (req, res) => {
  try {
    const doc = await loadDoc(req.params.id);
    if (!doc || String(doc.user_id) !== String(req.user.id)) return res.status(404).json({ error: 'Documento no encontrado' });
    const meta = doc.metadata || {};
    if (['signed', 'verified'].includes(doc.status)) return res.status(400).json({ error: 'El documento ya está firmado' });
    if (['sending', 'confirming'].includes(meta.blockchain_status)) return res.status(409).json({ error: 'La firma de este documento ya está en proceso' });
    if (meta.cosign?.status === 'collecting') return res.status(409).json({ error: 'Ya hay una solicitud de firmas en curso. Cancélala para hacer una nueva.' });

    const raw = Array.isArray(req.body?.signers) ? req.body.signers : [];
    const emails = [];
    for (const e of raw.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)) if (!emails.includes(e)) emails.push(e);
    if (emails.length < 2) return res.status(400).json({ error: 'Agrega al menos dos firmantes (puedes incluirte)' });
    if (emails.length > MAX_SIGNERS) return res.status(400).json({ error: `Máximo ${MAX_SIGNERS} firmantes` });
    const bad = emails.filter((e) => !EMAIL_RE.test(e));
    if (bad.length) return res.status(400).json({ error: `Correo no válido: ${bad.join(', ')}` });

    const found = await pool.query('SELECT id, name, email FROM users WHERE lower(email) = ANY($1)', [emails]);
    const byEmail = Object.fromEntries(found.rows.map((u) => [u.email.toLowerCase(), u]));
    const missing = emails.filter((e) => !byEmail[e]);
    if (missing.length) {
      return res.status(400).json({
        error: `Estas personas no tienen cuenta en DocBlockSign: ${missing.join(', ')}. Cada firmante necesita su cuenta para firmar con su propia llave.`,
        missing,
      });
    }

    const owner = await getUser(req.user.id);
    const cosign = {
      status: 'collecting',
      created_at: new Date().toISOString(),
      created_by: String(owner.id),
      message: String(req.body?.message || '').trim().slice(0, 1000) || null,
      signers: emails.map((e, i) => ({
        position: i + 1,
        user_id: String(byEmail[e].id),
        email: byEmail[e].email.toLowerCase(),
        name: byEmail[e].name || null,
        status: 'waiting',
      })),
    };
    await notifyTurn(doc, cosign, cosign.signers[0], owner);
    await saveCosign(doc.id, cosign);
    res.locals.auditDetail = { signers: emails.length };
    logAudit({
      userId: owner.id,
      actorEmail: owner.email,
      action: 'cosign.request',
      description: `Pidió la firma de ${emails.length} personas`,
      resource: doc.id,
      result: 'permitido',
      detail: { signers: emails },
    });
    return res.status(201).json({ message: 'Solicitud de firmas creada', cosign: publicCosign(cosign) });
  } catch (err) {
    console.error('ERROR COSIGN REQUEST:', err);
    return res.status(500).json({ error: 'No se pudo crear la solicitud de firmas' });
  }
};

/** Registra en blockchain la huella combinada (al final, o al reintentar) */
const registerCombined = async (doc, cosign) => {
  const hash = cosign.combined_hash || combinedHash(cosign.signers);
  cosign.combined_hash = hash;
  await saveCosign(doc.id, cosign);
  const last = cosign.signers[cosign.signers.length - 1];
  return signing.registerOnChain(doc, {
    signatureHash: hash,
    signerEmail: cosign.signers.map((s) => s.email).join('; '),
    metaPatch: {
      signer_id: last.user_id,
      signer_email: cosign.signers.map((s) => s.email).join(', '),
      signer_name: cosign.signers.map((s) => s.name || s.email).join(', '),
      signature_hash: hash,
      signature_algorithm: `${keys.ALGORITHM} · ${cosign.signers.length} firmantes`,
      signature_created_at: new Date().toISOString(),
      multi_signer: true,
    },
  });
};

// ────────────────────────────────────────────────
// POST /api/signing/:id/cosign  { decision: 'sign' | 'reject', comment? }
// La persona a la que le toca firma (o rechaza) con su propia llave.
// ────────────────────────────────────────────────
const cosignDocument = async (req, res) => {
  try {
    const doc = await loadDoc(req.params.id);
    const cosign = doc?.metadata?.cosign;
    if (!doc || !cosign) return res.status(404).json({ error: 'No hay una solicitud de firmas para este documento' });
    if (cosign.status !== 'collecting') return res.status(409).json({ error: 'Esta solicitud de firmas ya terminó' });

    const me = await getUser(req.user.id);
    const current = cosign.signers.find((s) => s.status === 'pending');
    const mine = cosign.signers.find((s) => String(s.user_id) === String(me.id));
    if (!mine) return res.status(403).json({ error: 'No estás entre los firmantes de este documento' });
    if (mine.status === 'signed') return res.status(409).json({ error: 'Ya firmaste este documento' });
    if (!current || current.position !== mine.position) {
      return res.status(409).json({ error: `Todavía no es tu turno. Falta que firme ${current?.name || current?.email || 'otra persona'}.` });
    }

    const decision = req.body?.decision === 'reject' ? 'reject' : req.body?.decision === 'sign' ? 'sign' : null;
    if (!decision) return res.status(400).json({ error: 'Elige firmar o rechazar' });
    const comment = String(req.body?.comment || '').trim().slice(0, 1000);
    const owner = await getUser(doc.user_id);
    const now = new Date().toISOString();

    if (decision === 'reject') {
      if (!comment) return res.status(400).json({ error: 'Cuéntale al dueño del documento por qué no lo firmas' });
      mine.status = 'rejected';
      mine.comment = comment;
      mine.rejected_at = now;
      cosign.status = 'rejected';
      cosign.completed_at = now;
      await saveCosign(doc.id, cosign);
      if (mine.share_id) {
        await pool.query("UPDATE document_shares SET status = 'rejected', response = $1, responded_at = NOW(), read_at = COALESCE(read_at, NOW()) WHERE id = $2", [comment, mine.share_id]);
      }
      if (owner && String(owner.id) !== String(me.id)) {
        sendShareResponseEmail({ to: owner.email, senderName: owner.name, reviewer: { name: me.name, email: me.email }, title: doc.title, decision: 'rejected', comment })
          .catch((e) => console.warn('[firmantes] correo de rechazo:', e.message));
      }
      logAudit({ userId: me.id, actorEmail: me.email, action: 'cosign.reject', description: 'Rechazó firmar el documento', resource: doc.id, result: 'permitido' });
      return res.json({ message: 'Rechazaste la firma. Le avisamos al dueño del documento.', cosign: publicCosign(cosign) });
    }

    // Firma manuscrita guardada (igual que en la firma individual)
    const sig = await pool.query('SELECT signature_url FROM user_signatures WHERE user_id = $1', [me.id]).catch(() => ({ rows: [] }));
    if (!sig.rows.length) return res.status(400).json({ error: 'No tienes firma registrada. Ve a Configuración → Firma manuscrita y créala primero.' });

    const userKey = await keys.getOrCreateUserKeys(me.id);
    const payload = keys.buildPayload({ documentHash: doc.file_hash, signerEmail: me.email, signedAt: now });
    const value = await keys.signWithUserKey(me.id, payload);
    Object.assign(mine, {
      status: 'signed',
      signed_at: now,
      signature_value: value,
      signature_payload: payload,
      signature_hash: keys.signatureDigest(value),
      key_fingerprint: userKey.fingerprint,
      signature_image_url: sig.rows[0].signature_url,
      comment: comment || null,
    });
    if (mine.share_id) {
      await pool.query("UPDATE document_shares SET status = 'approved', response = $1, responded_at = NOW(), read_at = COALESCE(read_at, NOW()) WHERE id = $2", [comment || null, mine.share_id]);
    }
    logAudit({ userId: me.id, actorEmail: me.email, action: 'cosign.sign', description: `Firmó (${mine.position} de ${cosign.signers.length})`, resource: doc.id, result: 'permitido', detail: { signature_hash: mine.signature_hash.slice(0, 16) } });

    const next = cosign.signers.find((s) => s.status === 'waiting');
    if (next) {
      await notifyTurn(doc, cosign, next, owner);
      await saveCosign(doc.id, cosign);
      return res.json({ message: `Firmaste. Ahora le toca a ${next.name || next.email}.`, cosign: publicCosign(cosign) });
    }

    // Último firmante: se registra todo en blockchain
    cosign.status = 'completed';
    cosign.completed_at = now;
    await saveCosign(doc.id, cosign);
    let chain = null;
    try {
      chain = await registerCombined(await loadDoc(doc.id), cosign);
    } catch (e) {
      // Queda guardado: el dueño puede reintentar el registro
      return res.json({
        message: 'Todos firmaron. El registro en blockchain falló; el dueño puede reintentarlo desde el documento.',
        chainError: e.message,
        cosign: publicCosign(cosign),
      });
    }
    return res.json({
      message: 'Todos firmaron. Registrando en blockchain…',
      txHash: chain.txHash,
      explorerUrl: chain.explorerUrl,
      cosign: publicCosign(cosign),
    });
  } catch (err) {
    console.error('ERROR COSIGN:', err);
    return res.status(500).json({ error: 'No se pudo registrar tu firma' });
  }
};

// POST /api/signing/:id/request/cancel  (solo el dueño, mientras se recogen firmas)
const cancelRequest = async (req, res) => {
  try {
    const doc = await loadDoc(req.params.id);
    if (!doc || String(doc.user_id) !== String(req.user.id)) return res.status(404).json({ error: 'Documento no encontrado' });
    const cosign = doc.metadata?.cosign;
    if (!cosign || cosign.status !== 'collecting') return res.status(409).json({ error: 'No hay una solicitud de firmas en curso' });
    cosign.status = 'cancelled';
    cosign.completed_at = new Date().toISOString();
    for (const s of cosign.signers) if (s.status === 'pending' || s.status === 'waiting') s.status = 'cancelled';
    await saveCosign(doc.id, cosign);
    const shareIds = cosign.signers.map((s) => s.share_id).filter(Boolean);
    if (shareIds.length) {
      await pool.query("UPDATE document_shares SET status = 'cancelled' WHERE id::text = ANY($1) AND status IN ('sent','read')", [shareIds.map(String)]);
    }
    logAudit({ userId: req.user.id, action: 'cosign.cancel', description: 'Canceló la solicitud de firmas', resource: doc.id, result: 'permitido' });
    return res.json({ message: 'Solicitud de firmas cancelada', cosign: publicCosign(cosign) });
  } catch (err) {
    console.error('ERROR COSIGN CANCEL:', err);
    return res.status(500).json({ error: 'No se pudo cancelar la solicitud' });
  }
};

// POST /api/signing/:id/request/register  (reintento del registro en blockchain)
const retryRegister = async (req, res) => {
  try {
    const doc = await loadDoc(req.params.id);
    if (!doc || String(doc.user_id) !== String(req.user.id)) return res.status(404).json({ error: 'Documento no encontrado' });
    const cosign = doc.metadata?.cosign;
    if (!cosign || cosign.status !== 'completed') return res.status(409).json({ error: 'Aún faltan firmas' });
    if (['signed', 'verified'].includes(doc.status)) return res.status(409).json({ error: 'El documento ya está registrado' });
    if (['sending', 'confirming'].includes(doc.metadata?.blockchain_status)) return res.status(202).json({ message: 'El registro ya está en proceso' });
    const chain = await registerCombined(doc, cosign);
    return res.status(202).json({ message: 'Registrando en blockchain…', txHash: chain.txHash, explorerUrl: chain.explorerUrl });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'No se pudo registrar en blockchain' });
  }
};

module.exports = { requestSignatures, cosignDocument, cancelRequest, retryRegister, publicCosign, combinedHash };
