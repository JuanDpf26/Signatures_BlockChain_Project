/**
 * Las cuentas de superusuario (rol admin) solo administran la plataforma:
 * no suben, firman ni comparten documentos. Este filtro se monta delante de
 * las rutas del aplicativo y responde 403 si la sesión es de un superusuario.
 * Las peticiones sin sesión siguen de largo (las rutas públicas no cambian).
 */
const jwt = require('jsonwebtoken');
const { accountState } = require('../services/account.service');

module.exports = async (req, res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return next();
  let decoded;
  try {
    decoded = jwt.verify(h.slice(7), process.env.JWT_SECRET);
  } catch (_) {
    return next(); // el authMiddleware de la ruta da el error correcto
  }
  try {
    const st = await accountState(decoded.id);
    if (st.role === 'admin') {
      return res.status(403).json({
        error: 'Las cuentas de administración no usan las funciones de documentos. Ingresa con una cuenta de usuario.',
        code: 'admin_account',
      });
    }
  } catch (_) {
    // sin base de datos no se decide aquí
  }
  next();
};
