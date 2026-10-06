const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { getMyAudit } = require('../controllers/audit.controller');

router.get('/', authMiddleware, getMyAudit);

module.exports = router;
