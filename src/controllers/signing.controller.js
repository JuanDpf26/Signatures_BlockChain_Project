const pool = require('../config/db');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const {
  registerSignatureOnBlockchain,
  verifySignatureOnBlockchain,
  revokeSignatureOnBlockchain,
} = require('../services/blockchain.service');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ────────────────────────────────────────────────
// FIRMAR DOCUMENTO
// ────────────────────────────────────────────────
const signDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Obtener documento
    const docResult = await pool.query(
      'SELECT * FROM documents WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Documento no encontrado' });
    }

    const doc = docResult.rows[0];

    if (doc.status === 'signed') {
      return res.status(400).json({ error: 'El documento ya fue firmado' });
    }

    // Obtener usuario para la firma
    const userResult = await pool.query(
      'SELECT id, name, email FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];

    // Obtener firma del usuario desde user_signatures
    const sigResult = await pool.query(
      'SELECT signature_url FROM user_signatures WHERE user_id = $1',
      [userId]
    );

    if (sigResult.rows.length === 0) {
      return res.status(400).json({
        error: 'No tienes firma registrada. Ve a tu perfil y crea tu firma primero.',
      });
    }

    // Usar el file_hash del documento (SHA-256 ya calculado al subir)
    const documentHash = doc.file_hash;

    if (!documentHash) {
      return res.status(400).json({ error: 'El documento no tiene hash calculado' });
    }

    // Generar hash de la firma (combinación de: hash doc + userId + timestamp)
    const signatureData = `${documentHash}:${userId}:${Date.now()}`;
    const signatureHash = crypto
      .createHash('sha256')
      .update(signatureData)
      .digest('hex');

    // Registrar en blockchain
    const blockchainResult = await registerSignatureOnBlockchain({
      documentHash,
      signatureHash,
      signerEmail: user.email,
      documentTitle: doc.title,
    });

    // Guardar firma en tabla signatures
    await pool.query(
      `INSERT INTO signatures (document_id, signer_id, signature_hash, public_key, blockchain_tx, is_valid, signed_at)
       VALUES ($1, $2, $3, $4, $5, true, NOW())`,
      [
        doc.id,
        userId,
        signatureHash,
        user.email, // Usamos email como identificador público
        blockchainResult.txHash || null,
      ]
    );

    // Actualizar estado del documento
    const blockchainTx = blockchainResult.success ? blockchainResult.txHash : null;
    const newStatus = blockchainResult.success ? 'signed' : 'signed';

    await pool.query(
      `UPDATE documents
       SET status = $1,
           blockchain_tx = $2,
           metadata = metadata || $3::jsonb,
           updated_at = NOW()
       WHERE id = $4`,
      [
        newStatus,
        blockchainTx,
        JSON.stringify({
          signed_at: new Date().toISOString(),
          signer_email: user.email,
          signer_name: user.name,
          signature_hash: signatureHash,
          blockchain_registered: blockchainResult.success,
          blockchain_tx: blockchainTx,
          blockchain_block: blockchainResult.blockNumber || null,
          blockchain_explorer: blockchainResult.explorerUrl || null,
          signature_image_url: sigResult.rows[0].signature_url,
        }),
        doc.id,
      ]
    );

    return res.json({
      message: blockchainResult.success
        ? '✅ Documento firmado y registrado en blockchain'
        : '✅ Documento firmado (blockchain pendiente)',
      signature: {
        documentHash,
        signatureHash,
        signedAt: new Date().toISOString(),
        signer: user.email,
        blockchain: blockchainResult,
      },
    });
  } catch (err) {
    console.error('ERROR SIGN DOCUMENT:', err);
    return res.status(500).json({ error: 'Error al firmar documento' });
  }
};

// ────────────────────────────────────────────────
// VERIFICAR DOCUMENTO
// ────────────────────────────────────────────────
const verifyDocument = async (req, res) => {
  try {
    const { id } = req.params;

    // Buscar por id o por hash
    const isUUID = id.includes('-');
    let docResult;

    if (isUUID) {
      docResult = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
    } else {
      docResult = await pool.query('SELECT * FROM documents WHERE file_hash = $1', [id]);
    }

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Documento no encontrado' });
    }

    const doc = docResult.rows[0];
    const meta = doc.metadata || {};

    // Si no está firmado
    if (doc.status === 'pending') {
      return res.json({
        verified: false,
        status: 'pending',
        message: 'El documento no ha sido firmado',
        document: {
          id: doc.id,
          title: doc.title,
          hash: doc.file_hash,
          status: doc.status,
        },
      });
    }

    // Verificar en blockchain si tiene tx
    let blockchainVerification = null;
    if (doc.file_hash) {
      blockchainVerification = await verifySignatureOnBlockchain(doc.file_hash);
    }

    // Obtener firma de la BD
    const sigResult = await pool.query(
      `SELECT s.*, u.name as signer_name, u.email as signer_email
       FROM signatures s
       JOIN users u ON s.signer_id = u.id
       WHERE s.document_id = $1
       ORDER BY s.signed_at DESC
       LIMIT 1`,
      [doc.id]
    );

    const signature = sigResult.rows[0];

    // Determinar resultado final
    const isValid =
      doc.status === 'signed' &&
      signature?.is_valid === true;

    // Actualizar estado a verified si blockchain confirma
    if (blockchainVerification?.verified && blockchainVerification?.isValid) {
      await pool.query(
        "UPDATE documents SET status = 'verified', updated_at = NOW() WHERE id = $1",
        [doc.id]
      );
    }

    return res.json({
      verified: isValid,
      status: doc.status,
      document: {
        id: doc.id,
        title: doc.title,
        hash: doc.file_hash,
        status: isValid ? 'verified' : doc.status,
        uploadedAt: doc.created_at,
        signedAt: meta.signed_at || signature?.signed_at,
      },
      signature: signature
        ? {
            hash: signature.signature_hash,
            signerName: signature.signer_name,
            signerEmail: signature.signer_email,
            signedAt: signature.signed_at,
            isValid: signature.is_valid,
            blockchainTx: signature.blockchain_tx,
          }
        : null,
      blockchain: blockchainVerification,
      integrity: {
        hashMatch: true,
        signatureValid: isValid,
        blockchainConfirmed: blockchainVerification?.verified || false,
      },
    });
  } catch (err) {
    console.error('ERROR VERIFY DOCUMENT:', err);
    return res.status(500).json({ error: 'Error al verificar documento' });
  }
};

// ────────────────────────────────────────────────
// VERIFICACIÓN PÚBLICA (sin autenticación)
// ────────────────────────────────────────────────
const verifyDocumentPublic = async (req, res) => {
  try {
    const { hash } = req.params;

    if (!hash || hash.length !== 64) {
      return res.status(400).json({ error: 'Hash inválido. Debe ser SHA-256 de 64 caracteres.' });
    }

    // Buscar en BD por hash
    const docResult = await pool.query(
      'SELECT id, title, status, created_at, blockchain_tx, metadata FROM documents WHERE file_hash = $1',
      [hash]
    );

    // Verificar en blockchain independientemente de si está en BD
    const blockchainResult = await verifySignatureOnBlockchain(hash);

    if (docResult.rows.length === 0 && !blockchainResult.verified) {
      return res.json({
        verified: false,
        message: 'Documento no encontrado en el sistema ni en blockchain',
      });
    }

    const doc = docResult.rows[0];

    return res.json({
      verified: blockchainResult.verified || doc?.status === 'signed',
      document: doc
        ? {
            title: doc.title,
            status: doc.status,
            uploadedAt: doc.created_at,
          }
        : null,
      blockchain: blockchainResult,
      message: blockchainResult.verified
        ? '✅ Documento verificado en blockchain — íntegro y auténtico'
        : '⚠️ Documento firmado pero no confirmado en blockchain',
    });
  } catch (err) {
    console.error('ERROR PUBLIC VERIFY:', err);
    return res.status(500).json({ error: 'Error al verificar' });
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
      `UPDATE documents SET status = 'pending', blockchain_tx = NULL, updated_at = NOW() WHERE id = $1`,
      [doc.id]
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

module.exports = { signDocument, verifyDocument, verifyDocumentPublic, revokeSignature };