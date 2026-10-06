const { runAgent, explainGroqError } = require('../services/agent.service');
const pool = require('../config/db');

// POST /api/agent/chat  { messages: [{role, content}], context?: { documentId, documentTitle } }
const chatWithAgent = async (req, res) => {
  try {
    const u = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.user.id]);
    if (!u.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const started = Date.now();
    const result = await runAgent({ user: u.rows[0], messages: req.body?.messages, context: req.body?.context });
    console.log(`🤖 [agente] ${result.steps.length} herramienta(s) · ${Date.now() - started} ms · ${result.model}`);
    return res.json(result);
  } catch (err) {
    console.error('❌ [agente]', err.message);
    const status = err?.status === 429 ? 429 : 500;
    return res.status(status).json({ error: explainGroqError(err) });
  }
};

module.exports = { chatWithAgent };
