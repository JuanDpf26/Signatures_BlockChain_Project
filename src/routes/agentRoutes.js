const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const rateLimit = require('express-rate-limit');
const { chatWithAgent } = require('../controllers/agent.controller');

// Cada mensaje consume cuota de Groq: máximo 20 por minuto por usuario/IP
const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Vas muy rápido 🙂 Espera un momento antes de enviar otro mensaje.' },
});

router.post('/chat', authMiddleware, agentLimiter, chatWithAgent);

module.exports = router;
