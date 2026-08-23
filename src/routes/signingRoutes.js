const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const {
  signDocument,
  verifyDocument,
  verifyDocumentPublic,
  revokeSignature,
} = require('../controllers/signing.controller');

// Ruta pública — sin autenticación (verificar por hash)
router.get('/public/:hash', verifyDocumentPublic);

// Rutas protegidas
router.use(authMiddleware);
router.post('/:id/sign', signDocument);
router.get('/:id/verify', verifyDocument);
router.delete('/:id/revoke', revokeSignature);

module.exports = router;