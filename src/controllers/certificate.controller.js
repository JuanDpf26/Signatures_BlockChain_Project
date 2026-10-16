/**
 * GET /api/documents/:id/signed-pdf
 * Copia del documento con sello, QR y certificado de firma.
 * Pueden pedirla el dueño y las personas a quienes se les compartió.
 * ?inline=1 devuelve el PDF directo (sirve para pruebas y descargas).
 */
const pool = require('../config/db');
const storage = require('../services/storage.service');
const keys = require('../services/keys.service');
const { buildSignedPdf } = require('../services/certificate.service');
const { logAudit } = require('../services/audit.service');

const frontend = () => (process.env.APP_BASE_URL || 'http://localhost:8080').trim().replace(/\/+$/, '');

const canSee = async (doc, userId) => {
  if (String(doc.user_id) === String(userId)) return true;
  const r = await pool.query('SELECT 1 FROM document_shares WHERE document_id = $1 AND recipient_id = $2 LIMIT 1', [String(doc.id), String(userId)]);
  return r.rows.length > 0;
};

const tryDownload = async (url, bucket) => {
  if (!url) return null;
  try {
    return await storage.download(url, { bucket });
  } catch (_) {
    return null;
  }
};

const signedPdf = async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM documents WHERE id::text = $1', [String(req.params.id)]);
    const doc = r.rows[0];
    if (!doc || !(await canSee(doc, req.user.id))) return res.status(404).json({ error: 'Documento no encontrado' });
    const m = doc.metadata || {};
    if (!['signed', 'verified'].includes(doc.status) || m.blockchain_status !== 'confirmed') {
      return res.status(409).json({ error: 'El PDF firmado está disponible cuando la firma queda confirmada en blockchain' });
    }
    const tx = m.blockchain_tx || doc.blockchain_tx || '';
    const inline = String(req.query.inline || '') === '1';

    // Ya generado para esta misma transacción
    if (!inline && m.certificate?.tx === tx && m.certificate?.path) {
      try {
        const { data } = await require('../config/supabase').storage.from('documents').createSignedUrl(m.certificate.path, storage.HOUR);
        if (data?.signedUrl) return res.json({ url: data.signedUrl, fileName: m.certificate.fileName, stamped: m.certificate.stamped });
      } catch (_) {}
    }

    // Firmantes: varios (cosign) o uno solo
    let signers;
    if (m.cosign?.status === 'completed') {
      signers = await Promise.all(
        m.cosign.signers.map(async (s) => ({
          name: s.name,
          email: s.email,
          signedAt: s.signed_at,
          signatureHash: s.signature_hash,
          keyFingerprint: s.key_fingerprint,
          image: await tryDownload(s.signature_image_url, 'signatures'),
        }))
      );
    } else {
      signers = [{
        name: m.signer_name,
        email: m.signer_email,
        signedAt: m.signature_created_at || m.signed_at,
        signatureHash: m.signature_hash,
        keyFingerprint: m.signer_key_fingerprint,
        image: await tryDownload(m.signature_image_url, 'signatures'),
      }];
    }

    const isPdf = (m.extension || '').toLowerCase() === 'pdf' || m.mime_type === 'application/pdf';
    const original = isPdf ? await tryDownload(doc.file_url, 'documents') : null;
    const { bytes, stamped } = await buildSignedPdf({
      original,
      doc: { title: doc.title, file_hash: doc.file_hash, extension: m.extension },
      chain: {
        txHash: tx,
        blockNumber: m.blockchain_block,
        signedAt: m.signed_at || m.blockchain_confirmed_at,
        explorerUrl: m.blockchain_explorer,
        combinedHash: m.cosign?.status === 'completed' ? m.cosign.combined_hash : null,
      },
      signers,
      verifyUrl: `${frontend()}/#/verify?hash=${encodeURIComponent(doc.file_hash)}`,
    });

    const base = doc.title.replace(/\.(pdf|docx?|)$/i, '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'documento';
    const fileName = `${base} (firmado).pdf`;
    logAudit({ userId: req.user.id, action: 'document.signed_pdf', description: 'Descargó el PDF firmado', resource: doc.id, result: 'permitido', detail: { stamped } });

    if (inline) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      return res.send(bytes);
    }
    const path = `certificados/${doc.id}/${tx.replace(/^0x/, '').slice(0, 16) || 'firma'}.pdf`;
    const url = await storage.uploadAndSign(path, bytes);
    await pool.query(
      `UPDATE documents SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{certificate}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify({ path, tx, fileName, stamped, created_at: new Date().toISOString() }), doc.id]
    );
    return res.json({ url, fileName, stamped });
  } catch (err) {
    console.error('ERROR SIGNED PDF:', err);
    return res.status(500).json({ error: 'No se pudo generar el PDF firmado' });
  }
};

module.exports = { signedPdf };
