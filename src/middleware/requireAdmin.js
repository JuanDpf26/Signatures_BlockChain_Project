const { accountState } = require('../services/account.service');

/** Solo administradores del sistema (rol asignado en la base de datos, nunca desde la app) */
module.exports = async (req, res, next) => {
  try {
    const st = await accountState(req.user.id);
    if (st.role !== 'admin') return res.status(403).json({ error: 'Solo los administradores pueden ver esta sección' });
    next();
  } catch (_) {
    return res.status(500).json({ error: 'No se pudo comprobar el rol' });
  }
};
