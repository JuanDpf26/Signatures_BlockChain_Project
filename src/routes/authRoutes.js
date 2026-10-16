const express = require('express');
const router = express.Router();
const {
  register,
  verifyEmail,
  resendVerification,
  login,
  googleAuth,
  forgotPassword,
  resetPassword,
} = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');

// Públicas
router.post('/register', register);
router.get('/verify-email/:token', verifyEmail);
router.post('/resend-verification', resendVerification);
router.post('/login', login);
router.post('/google', googleAuth);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

// Protegidas (ejemplo)
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const pool = require('../config/db');
    const result = await pool.query(
      'SELECT id, name, email, avatar_url, created_at, last_login, role, email_reminders FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

// Latido de presencia: la app lo envía cada 45 s mientras está abierta
const SECTION_MAX = 60;
const PLATFORMS = ['web', 'android', 'ios', 'windows', 'macos', 'linux'];
router.post('/heartbeat', authMiddleware, async (req, res) => {
  const { touchPresence } = require('../services/account.service');
  const { clientIp } = require('../services/audit.service');
  const section = typeof req.body?.section === 'string' ? req.body.section.trim().slice(0, SECTION_MAX) : null;
  const platform = PLATFORMS.includes(req.body?.platform) ? req.body.platform : null;
  await touchPresence(req.user.id, { ip: clientIp(req), userAgent: req.headers['user-agent'], section, platform });
  res.json({ ok: true, role: req.user.role || 'user' });
});

// Al cerrar sesión deja de aparecer como conectado
router.post('/logout', authMiddleware, async (req, res) => {
  const { clearPresence } = require('../services/account.service');
  await clearPresence(req.user.id);
  res.json({ ok: true });
});

router.get('/reset-password-redirect/:token', (req, res) => {
  const { token } = req.params;
  const flutterUrl = (process.env.APP_BASE_URL || 'http://localhost:8080').trim().replace(/\/+$/, '');
  res.redirect(`${flutterUrl}/#/reset-password?token=${encodeURIComponent(token)}`);
});

module.exports = router;
