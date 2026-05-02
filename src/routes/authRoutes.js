const express = require('express');
const router = express.Router();
const {
  register,
  verifyEmail,
  login,
  googleAuth,
  forgotPassword,
  resetPassword,
} = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');

// Públicas
router.post('/register', register);
router.get('/verify-email/:token', verifyEmail);
router.post('/login', login);
router.post('/google', googleAuth);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

// Protegidas (ejemplo)
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const pool = require('../config/db');
    const result = await pool.query(
      'SELECT id, name, email, avatar_url, created_at, last_login FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

module.exports = router;