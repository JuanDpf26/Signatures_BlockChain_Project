const jwt = require('jsonwebtoken');
const { accountState, touchPresence } = require('../services/account.service');
const { clientIp } = require('../services/audit.service');

module.exports = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado: token no proporcionado' });
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesión expirada. Inicia sesión nuevamente.' });
    }
    return res.status(401).json({ error: 'Token inválido' });
  }
  req.user = decoded; // { id, iat, exp }

  // Cuenta suspendida o eliminada: la sesión deja de servir de inmediato
  try {
    const st = await accountState(decoded.id);
    if (!st.exists) return res.status(401).json({ error: 'La cuenta ya no existe.' });
    if (st.suspended) {
      return res.status(403).json({ error: 'Tu cuenta está suspendida. Escribe al administrador de DocBlockSign.', code: 'suspended' });
    }
    // Un administrador cerró esta sesión: los tokens anteriores dejan de servir
    if ((Number(decoded.sv) || 0) !== (st.sessionVersion || 0)) {
      return res.status(401).json({ error: 'Un administrador cerró tu sesión. Vuelve a iniciar sesión.', code: 'session_revoked' });
    }
    req.user.role = st.role;
    touchPresence(decoded.id, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
  } catch (_) {
    // Si la base de datos no responde no se bloquea a nadie: la ruta fallará por su cuenta
  }
  next();
};
