const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const {
  signDocument,
  verifyDocument,
  verifyDocumentPublic,
  revokeSignature,
  getSigningStatus,
  getNetwork,
} = require('../controllers/signing.controller');
const cosign = require('../controllers/cosign.controller');

// Ruta pública — sin autenticación (verificar por hash)
router.get('/network', getNetwork);

// Rutas protegidas
router.use(authMiddleware);
// Verificación por huella: solo usuarios con sesión (antes era pública)
router.get('/hash/:hash', verifyDocumentPublic);
router.post('/receipt', require('../controllers/signing.controller').verificationReceipt);
router.post('/:id/sign', signDocument);
router.get('/:id/status', getSigningStatus);
router.get('/:id/verify', verifyDocument);
router.delete('/:id/revoke', revokeSignature);
// Varios firmantes
router.post('/:id/request', cosign.requestSignatures);
router.post('/:id/request/cancel', cosign.cancelRequest);
router.post('/:id/request/register', cosign.retryRegister);
router.post('/:id/cosign', cosign.cosignDocument);

module.exports = router;