const pool = require('../config/db');
const crypto = require('crypto');
const {
  verifySignatureOnBlockchain,
  revokeSignatureOnBlockchain,
  isReady,
  isAlreadyRegistered,
  sendSignatureTx,
  getTxStatus,
  getNetworkInfo,
  chainErrorMessage,
} = require('../services/blockchain.service');


// ────────────────────────────────────────────────
// FIRMAR DOCUMENTO (asíncrono, para que la app muestre el proceso)
//
//  1. Valida documento, firma del usuario y hash.
//  2. Envía la transacción a Sepolia y responde 202 con el txHash.
//  3. En segundo plano espera la confirmación del bloque y marca el
//     documento como firmado (metadata.blockchain_status = confirmed).
//  La app consulta GET /api/signing/:id/status para pintar cada paso.
// ────────────────────────────────────────────────
const ACTIVE_STATES = ['sending', 'confirming'];

// Un "sending" sin transacción durante más de 2 min significa que el envío se cortó
const isStaleSending = (meta) =>
  meta.blockchain_status === 'sending' &&
  !meta.blockchain_tx &&
  Date.now() - new Date(meta.sign_started_at || 0).getTime() > 2 * 60 * 1000;

const mergeMeta = (docId, patch) =>
  pool.query(
    `UPDATE documents SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(patch), docId]
  );

/** Marca el documento como firmado. Es idempotente: si ya estaba confirmado no hace nada. */
const finalizeSignature = async (docId, txInfo) => {
  const docRes = await pool.query('SELECT id, metadata FROM documents WHERE id = $1', [docId]);
  const doc = docRes.rows[0];
  if (!doc) return false;
  const meta = doc.metadata || {};
  if (meta.blockchain_status === 'confirmed') return false;

  const upd = await pool.query(
    `UPDATE documents
       SET status = 'signed',
           blockchain_tx = $1,
           metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
     WHERE id = $3 AND COALESCE(metadata->>'blockchain_status', '') <> 'confirmed'
     RETURNING id`,
    [
      txInfo.txHash,
      JSON.stringify({
        blockchain_status: 'confirmed',
        blockchain_registered: true,
        blockchain_tx: txInfo.txHash,
        blockchain_block: txInfo.blockNumber ?? null,
        blockchain_gas_used: txInfo.gasUsed ?? null,
        blockchain_fee_eth: txInfo.feeEth ?? null,
        blockchain_explorer: txInfo.explorerUrl ?? null,
        blockchain_confirmed_at: txInfo.minedAt || new Date().toISOString(),
        signed_at: txInfo.minedAt || new Date().toISOString(),
        blockchain_error: null,
      }),
      docId,
    ]
  );
  if (upd.rowCount === 0) return false;

  await pool.query(
    `INSERT INTO signatures (document_id, signer_id, signature_hash, public_key, blockchain_tx, is_valid, signed_at)
     VALUES ($1, $2, $3, $4, $5, true, NOW())`,
    [docId, meta.signer_id, meta.signature_hash, meta.signer_email, txInfo.txHash]
  );
  console.log(`✅ [Blockchain] Documento ${docId} confirmado en el bloque ${txInfo.blockNumber}`);
  return true;
};

const failSignature = async (docId, message) => {
  await mergeMeta(docId, {
    blockchain_status: 'failed',
    blockchain_error: message,
    blockchain_failed_at: new Date().toISOString(),
  });
  console.error(`❌ [Blockchain] Firma del documento ${docId} falló: ${message}`);
};

const signDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const docResult = await pool.query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [id, userId]);
    if (docResult.rows.length === 0) return res.status(404).json({ error: 'Documento no encontrado' });

    const doc = docResult.rows[0];
    const meta = doc.metadata || {};

    if (doc.status === 'signed' || doc.status === 'verified') {
      return res.status(400).json({ error: 'El documento ya fue firmado' });
    }
    if (ACTIVE_STATES.includes(meta.blockchain_status) && !isStaleSending(meta)) {
      return res.status(202).json({
        message: 'La firma de este documento ya está en proceso',
        status: meta.blockchain_status,
        txHash: meta.blockchain_tx || null,
      });
    }
    if (meta.revoked) {
      return res.status(400).json({
        error: 'La firma de este documento fue revocada en blockchain. Sube una nueva versión del archivo para firmarlo de nuevo.',
      });
    }

    const documentHash = doc.file_hash;
    if (!documentHash) return res.status(400).json({ error: 'El documento no tiene hash calculado' });

    const userResult = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];

    const sigResult = await pool.query('SELECT signature_url FROM user_signatures WHERE user_id = $1', [userId]);
    if (sigResult.rows.length === 0) {
      return res.status(400).json({ error: 'No tienes firma registrada. Ve a tu perfil y crea tu firma primero.' });
    }

    if (!isReady()) {
      return res.status(503).json({
        error: 'La conexión con blockchain no está configurada en el servidor (BLOCKCHAIN_RPC_URL, BLOCKCHAIN_PRIVATE_KEY, BLOCKCHAIN_CONTRACT_ADDRESS).',
      });
    }

    if (await isAlreadyRegistered(documentHash)) {
      return res.status(409).json({
        error: 'Un archivo con este mismo contenido ya está registrado en blockchain. Puedes comprobarlo en Verificar.',
        documentHash,
      });
    }

    const signatureHash = crypto
      .createHash('sha256')
      .update(`${documentHash}:${userId}:${Date.now()}`)
      .digest('hex');

    await mergeMeta(doc.id, {
      blockchain_status: 'sending',
      blockchain_error: null,
      sign_started_at: new Date().toISOString(),
      signer_id: userId,
      signer_email: user.email,
      signer_name: user.name,
      signature_hash: signatureHash,
      signature_image_url: sigResult.rows[0].signature_url,
    });

    let sent;
    try {
      sent = await sendSignatureTx({
        documentHash,
        signatureHash,
        signerEmail: user.email,
        documentTitle: doc.title,
      });
    } catch (err) {
      await failSignature(doc.id, err.message);
      return res.status(err.alreadyRegistered ? 409 : 502).json({ error: err.message });
    }

    await mergeMeta(doc.id, {
      blockchain_status: 'confirming',
      blockchain_tx: sent.txHash,
      blockchain_explorer: sent.explorerUrl,
      blockchain_sent_at: new Date().toISOString(),
    });

    // Confirmación en segundo plano
    sent.tx
      .wait(1)
      .then(async (receipt) => {
        if (receipt && receipt.status === 1) {
          await finalizeSignature(doc.id, await getTxStatus(sent.txHash));
        } else {
          await failSignature(doc.id, 'La transacción fue revertida por el contrato');
        }
      })
      .catch((err) => failSignature(doc.id, chainErrorMessage(err)).catch(() => {}));

    return res.status(202).json({
      message: 'Transacción enviada a Sepolia. Esperando confirmación del bloque…',
      status: 'confirming',
      documentHash,
      signatureHash,
      txHash: sent.txHash,
      explorerUrl: sent.explorerUrl,
      from: sent.from,
    });
  } catch (err) {
    console.error('ERROR SIGN DOCUMENT:', err);
    return res.status(500).json({ error: 'Error al firmar documento' });
  }
};

// ────────────────────────────────────────────────
// ESTADO DE LA FIRMA (la app lo consulta cada 2–3 s)
// ────────────────────────────────────────────────
const getSigningStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const docRes = await pool.query(
      'SELECT id, title, status, file_hash, blockchain_tx, metadata FROM documents WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (docRes.rows.length === 0) return res.status(404).json({ error: 'Documento no encontrado' });

    let doc = docRes.rows[0];
    let meta = doc.metadata || {};
    let state = meta.blockchain_status || (doc.status === 'signed' || doc.status === 'verified' ? 'confirmed' : 'idle');
    const txHash = meta.blockchain_tx || doc.blockchain_tx || null;

    if (isStaleSending(meta)) {
      await failSignature(doc.id, 'El envío de la transacción se interrumpió. Intenta firmar de nuevo.');
      state = 'failed';
      meta = { ...meta, blockchain_error: 'El envío de la transacción se interrumpió. Intenta firmar de nuevo.' };
    }

    let tx = null;
    if (txHash) {
      tx = await getTxStatus(txHash);
      // Auto-reparación: si el servidor se reinició mientras esperaba el bloque
      if (state === 'confirming' && tx.state === 'confirmed') {
        await finalizeSignature(doc.id, tx);
        state = 'confirmed';
      } else if (state === 'confirming' && tx.state === 'failed') {
        await failSignature(doc.id, 'La transacción fue revertida por el contrato');
        state = 'failed';
      }
      if (state !== meta.blockchain_status) {
        const again = await pool.query('SELECT status, metadata FROM documents WHERE id = $1', [doc.id]);
        doc = { ...doc, ...again.rows[0] };
        meta = doc.metadata || {};
      }
    }

    return res.json({
      state,
      documentStatus: doc.status,
      title: doc.title,
      documentHash: doc.file_hash,
      signatureHash: meta.signature_hash || null,
      signer: meta.signer_email || null,
      startedAt: meta.sign_started_at || null,
      sentAt: meta.blockchain_sent_at || null,
      confirmedAt: meta.blockchain_confirmed_at || null,
      error: meta.blockchain_error || null,
      txHash,
      tx,
    });
  } catch (err) {
    console.error('ERROR SIGNING STATUS:', err);
    return res.status(500).json({ error: 'Error al consultar el estado de la firma' });
  }
};

// ────────────────────────────────────────────────
// VERIFICACIÓN DETALLADA (pasos + veredicto)
// verdict: authentic | revoked | pending | not_registered
// ────────────────────────────────────────────────
const buildVerification = async (hash) => {
  const steps = [];
  const fmtOk = /^[0-9a-fA-F]{64}$/.test(hash || '');
  steps.push({ key: 'hash', label: 'Huella SHA-256', ok: fmtOk, detail: fmtOk ? hash.toLowerCase() : 'Formato inválido' });
  if (!fmtOk) return { verdict: 'invalid', steps };

  const h = hash.toLowerCase();
  const docRes = await pool.query(
    `SELECT d.id, d.title, d.status, d.created_at, d.blockchain_tx, d.metadata, u.name AS owner_name
       FROM documents d LEFT JOIN users u ON u.id = d.user_id
      WHERE d.file_hash = $1
      ORDER BY d.created_at DESC LIMIT 1`,
    [h]
  );
  const doc = docRes.rows[0] || null;
  const meta = doc?.metadata || {};
  steps.push({
    key: 'database',
    label: 'Registro en BlockSign',
    ok: !!doc,
    detail: doc ? `Encontrado: ${doc.title}` : 'No hay ningún documento con esta huella en BlockSign',
  });

  const chain = await verifySignatureOnBlockchain(h);
  const networkError = chain.error && !/no encontrado/i.test(chain.error) ? chain.error : null;
  steps.push({
    key: 'blockchain',
    label: 'Consulta al contrato en Sepolia',
    ok: !!chain.onChain,
    detail: chain.onChain
      ? `Registrado el ${chain.signedAt}`
      : networkError || 'La huella no está registrada en el contrato',
  });

  let tx = null;
  const txHash = meta.blockchain_tx || doc?.blockchain_tx;
  if (txHash) {
    tx = await getTxStatus(txHash);
    steps.push({
      key: 'transaction',
      label: 'Transacción en bloque',
      ok: tx.state === 'confirmed',
      detail:
        tx.state === 'confirmed'
          ? `Bloque #${tx.blockNumber} · ${tx.confirmations} confirmaciones`
          : tx.state === 'pending'
          ? 'Transacción pendiente de minar'
          : 'No se pudo leer la transacción',
    });
  }

  if (chain.onChain) {
    steps.push({
      key: 'signature',
      label: 'Estado de la firma',
      ok: !!chain.isValid,
      detail: chain.isValid ? 'Firma vigente' : 'La firma fue revocada por su emisor',
    });
  }

  let verdict = 'not_registered';
  if (chain.onChain) verdict = chain.isValid ? 'authentic' : 'revoked';
  else if (ACTIVE_STATES.includes(meta.blockchain_status)) verdict = 'pending';
  else if (networkError) verdict = 'unavailable';

  return {
    verdict,
    verified: verdict === 'authentic',
    hash: h,
    steps,
    document: doc
      ? {
          id: doc.id,
          title: doc.title,
          status: doc.status,
          uploadedAt: doc.created_at,
          signerName: meta.signer_name || doc.owner_name || null,
        }
      : null,
    blockchain: chain.onChain
      ? {
          signerEmail: chain.signerEmail,
          signerWallet: chain.signer,
          documentTitle: chain.documentTitle,
          signatureHash: chain.signatureHash,
          signedAt: chain.signedAt,
          isValid: chain.isValid,
          contractAddress: process.env.BLOCKCHAIN_CONTRACT_ADDRESS,
          contractUrl: chain.explorerUrl,
        }
      : null,
    transaction: tx,
    checkedAt: new Date().toISOString(),
    message: {
      authentic: 'Documento auténtico: su huella está registrada en blockchain y la firma está vigente.',
      revoked: 'El documento fue registrado, pero su firma fue revocada.',
      pending: 'La firma está en proceso: la transacción aún no se confirma.',
      unavailable: 'No se pudo consultar la blockchain en este momento. Inténtalo de nuevo.',
      not_registered: 'No hay ninguna firma registrada para este archivo. Si fue modificado, aunque sea un byte, la huella cambia.',
    }[verdict],
  };
};

// Verificación de un documento propio (desde la lista)
const verifyDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const docRes = id.includes('-')
      ? await pool.query('SELECT id, file_hash, status FROM documents WHERE id = $1', [id])
      : await pool.query('SELECT id, file_hash, status FROM documents WHERE file_hash = $1', [id]);
    if (docRes.rows.length === 0) return res.status(404).json({ error: 'Documento no encontrado' });
    const doc = docRes.rows[0];
    if (!doc.file_hash) return res.status(400).json({ error: 'El documento no tiene hash calculado' });

    const result = await buildVerification(doc.file_hash);
    if (result.verdict === 'authentic' && doc.status === 'signed') {
      await pool.query("UPDATE documents SET status = 'verified', updated_at = NOW() WHERE id = $1", [doc.id]);
    }
    return res.json(result);
  } catch (err) {
    console.error('ERROR VERIFY DOCUMENT:', err);
    return res.status(500).json({ error: 'Error al verificar documento' });
  }
};

// Verificación pública por hash (no requiere sesión, el archivo nunca se sube)
const verifyDocumentPublic = async (req, res) => {
  try {
    const { hash } = req.params;
    if (!/^[0-9a-fA-F]{64}$/.test(hash || '')) {
      return res.status(400).json({ error: 'Hash inválido. Debe ser un SHA-256 de 64 caracteres hexadecimales.' });
    }
    return res.json(await buildVerification(hash));
  } catch (err) {
    console.error('ERROR PUBLIC VERIFY:', err);
    return res.status(500).json({ error: 'Error al verificar' });
  }
};

// Información de la red (pública)
const getNetwork = async (_req, res) => {
  try {
    return res.json(await getNetworkInfo());
  } catch (err) {
    return res.status(500).json({ connected: false, error: err.message });
  }
};

// ────────────────────────────────────────────────
// REVOCAR FIRMA
// ────────────────────────────────────────────────
const revokeSignature = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const docResult = await pool.query(
      'SELECT * FROM documents WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Documento no encontrado' });
    }

    const doc = docResult.rows[0];

    if (doc.status !== 'signed' && doc.status !== 'verified') {
      return res.status(400).json({ error: 'El documento no tiene firma activa' });
    }

    // Revocar en blockchain
    const blockchainResult = await revokeSignatureOnBlockchain(doc.file_hash);

    // Actualizar en BD
    await pool.query(
      `UPDATE documents
         SET status = 'pending',
             blockchain_tx = NULL,
             metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
             updated_at = NOW()
       WHERE id = $1`,
      [doc.id, JSON.stringify({
        revoked: blockchainResult?.success !== false,
        revoked_at: new Date().toISOString(),
        blockchain_status: 'revoked',
        revoke_tx: blockchainResult?.txHash || null,
      })]
    );

    await pool.query(
      'UPDATE signatures SET is_valid = false WHERE document_id = $1',
      [doc.id]
    );

    return res.json({
      message: 'Firma revocada exitosamente',
      blockchain: blockchainResult,
    });
  } catch (err) {
    console.error('ERROR REVOKE:', err);
    return res.status(500).json({ error: 'Error al revocar firma' });
  }
};

module.exports = {
  signDocument,
  getSigningStatus,
  verifyDocument,
  verifyDocumentPublic,
  getNetwork,
  revokeSignature,
};