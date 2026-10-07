const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { getMyAudit, createExportLink, exportAudit } = require('../controllers/audit.controller');

router.get('/', authMiddleware, getMyAudit);
router.post('/export-link', authMiddleware, createExportLink);
// Sin encabezado de sesión: el enlace lleva un token firmado que vence en 2 minutos
router.get('/export', exportAudit);

module.exports = router;
