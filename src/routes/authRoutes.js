const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/register', authController.register);
router.post('/login', authController.login);

// ruta protegida
router.get('/profile', authMiddleware, (req, res) => {
  res.json({
    msg: 'Acceso permitido',
    user: req.user
  });
});

module.exports = router;