const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const keys = require('../services/keys.service');
const { logAudit } = require('../services/audit.service');

// GET /api/keys/me → clave pública del usuario (se genera si aún no tiene)
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const k = await keys.getOrCreateUserKeys(req.user.id);
    if (k.created) {
      logAudit({ userId: req.user.id, action: 'keys.generate', description: 'Se generó su par de claves ECDSA P-256', resource: k.fingerprint.slice(0, 16), result: 'permitido', requestId: req.id });
    }
    return res.json({
      algorithm: k.algorithm,
      publicKey: k.public_key_pem,
      fingerprint: k.fingerprint,
      createdAt: k.created_at,
    });
  } catch (err) {
    console.error('ERROR KEYS ME:', err.message);
    return res.status(500).json({ error: 'No se pudieron consultar tus claves' });
  }
});

module.exports = router;
