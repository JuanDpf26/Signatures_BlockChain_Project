const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const c = require('../controllers/admin.controller');

router.use(authMiddleware, requireAdmin);
router.get('/overview', c.overview);
router.get('/users', c.listUsers);
router.post('/users/:id/suspend', c.setSuspended);
router.post('/users/:id/resend-verification', c.resendVerification);
router.get('/audit', c.audit);
router.get('/health', c.health);
router.post('/reminders/run', c.runRemindersNow);

module.exports = router;
