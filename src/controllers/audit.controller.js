const pool = require('../config/db');

// GET /api/audit?limit=50&action=document&result=denegado
// Devuelve los eventos del usuario de la sesión (por id o por su correo, para
// incluir intentos de inicio de sesión fallidos con su cuenta).
const getMyAudit = async (req, res) => {
  try {
    const u = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    const email = u.rows[0]?.email?.toLowerCase() || '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const params = [String(req.user.id), email];
    let where = '(user_id = $1 OR (user_id IS NULL AND actor_email = $2))';
    if (req.query.action) {
      params.push(`${String(req.query.action).replace(/[^a-z_.]/gi, '')}%`);
      where += ` AND action LIKE $${params.length}`;
    }
    if (['permitido', 'denegado', 'error'].includes(req.query.result)) {
      params.push(req.query.result);
      where += ` AND result = $${params.length}`;
    }

    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT id, created_at, action, description, resource, result, status_code, ip, user_agent, request_id, method, path, detail
           FROM audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE result = 'denegado')::int AS denied,
                COUNT(*) FILTER (WHERE result = 'error')::int AS errors,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last7,
                MAX(created_at) FILTER (WHERE action IN ('auth.login','auth.google') AND result = 'permitido') AS last_login,
                COUNT(DISTINCT ip)::int AS ips
           FROM audit_logs WHERE (user_id = $1 OR (user_id IS NULL AND actor_email = $2))`,
        [String(req.user.id), email]
      ),
    ]);

    return res.json({ events: rows.rows, summary: summary.rows[0] });
  } catch (err) {
    console.error('ERROR AUDIT:', err.message);
    return res.status(500).json({ error: 'No se pudo consultar la auditoría' });
  }
};

module.exports = { getMyAudit };
