// ────────────────────────────────────────────────
// AUDITORÍA
// Registra quién hizo qué, cuándo, desde qué IP y con qué resultado.
// Nunca se guardan contraseñas, tokens ni el contenido de los documentos.
// ────────────────────────────────────────────────
const crypto = require('crypto');
const pool = require('../config/db');

let ready = false;

/** Crea la tabla si no existe (se llama al arrancar el servidor) */
const initAudit = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id           BIGSERIAL PRIMARY KEY,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_id      TEXT,
        actor_email  TEXT,
        action       TEXT NOT NULL,
        description  TEXT,
        resource     TEXT,
        result       TEXT NOT NULL,
        status_code  INTEGER,
        ip           TEXT,
        user_agent   TEXT,
        request_id   TEXT,
        method       TEXT,
        path         TEXT,
        detail       JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_logs (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_email   ON audit_logs (actor_email, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);
      ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
    `);
    ready = true;
    console.log('🧾 [Auditoría] Tabla audit_logs lista');
  } catch (err) {
    console.error('❌ [Auditoría] No se pudo crear la tabla audit_logs:', err.message);
  }
};

const clientIp = (req) => {
  const fwd = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  const ip = fwd || req.ip || req.socket?.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
};

/** Guarda un evento. Nunca lanza error: la auditoría no debe tumbar la operación. */
const logAudit = async (entry) => {
  if (!ready) return;
  const {
    userId = null, actorEmail = null, action, description = null, resource = null,
    result = 'permitido', statusCode = null, ip = null, userAgent = null,
    requestId = null, method = null, path = null, detail = null,
  } = entry;
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, actor_email, action, description, resource, result, status_code,
                               ip, user_agent, request_id, method, path, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        userId ? String(userId) : null, actorEmail, action, description, resource, result, statusCode,
        ip, userAgent ? String(userAgent).slice(0, 300) : null, requestId, method, path,
        detail ? JSON.stringify(detail) : null,
      ]
    );
  } catch (err) {
    console.error('❌ [Auditoría] No se pudo registrar el evento:', err.message);
  }
};

// ── Qué acción corresponde a cada ruta ───────────────────────────────
const UUID = '([0-9a-fA-F-]{36})';
const RULES = [
  ['POST', /^\/api\/auth\/register$/, 'auth.register', 'Registro de cuenta'],
  ['GET', /^\/api\/auth\/verify-email\//, 'auth.verify_email', 'Verificación de correo'],
  ['POST', /^\/api\/auth\/resend-verification$/, 'auth.resend_verification', 'Reenvío de verificación'],
  ['POST', /^\/api\/auth\/login$/, 'auth.login', 'Inicio de sesión'],
  ['POST', /^\/api\/auth\/google$/, 'auth.google', 'Inicio de sesión con Google'],
  ['POST', /^\/api\/auth\/forgot-password$/, 'auth.forgot_password', 'Solicitud de recuperación de contraseña'],
  ['POST', /^\/api\/auth\/reset-password$/, 'auth.reset_password', 'Cambio de contraseña por enlace'],
  ['POST', /^\/api\/documents\/upload$/, 'document.upload', 'Subió un documento'],
  ['POST', new RegExp(`^/api/documents/${UUID}/reanalyze$`), 'document.reanalyze', 'Solicitó análisis con IA'],
  ['PATCH', new RegExp(`^/api/documents/${UUID}$`), 'document.update', 'Editó los datos de un documento'],
  ['POST', new RegExp(`^/api/documents/${UUID}/send$`), 'document.send', 'Envió un documento (correo y bandeja)'],
  ['POST', new RegExp(`^/api/inbox/${UUID}/respond$`), 'inbox.respond', 'Respondió una solicitud de revisión'],
  ['POST', new RegExp(`^/api/inbox/${UUID}/archive$`), 'inbox.archive', 'Archivó un mensaje de la bandeja'],
  ['POST', /^\/api\/teams$/, 'team.create', 'Creó un equipo'],
  ['PATCH', new RegExp(`^/api/teams/${UUID}$`), 'team.update', 'Editó un equipo'],
  ['DELETE', new RegExp(`^/api/teams/${UUID}$`), 'team.delete', 'Eliminó un equipo'],
  ['POST', new RegExp(`^/api/teams/${UUID}/members$`), 'team.add_member', 'Agregó un miembro a un equipo'],
  ['PATCH', new RegExp(`^/api/teams/${UUID}/members/[^/]+$`), 'team.member_role', 'Cambió el rol de un miembro'],
  ['DELETE', new RegExp(`^/api/teams/${UUID}/members/[^/]+$`), 'team.remove_member', 'Retiró a un miembro o salió de un equipo'],
  ['PUT', new RegExp(`^/api/documents/${UUID}/file$`), 'document.replace_file', 'Reemplazó el archivo de un documento (nueva versión)'],
  ['DELETE', new RegExp(`^/api/documents/${UUID}$`), 'document.delete', 'Eliminó un documento'],
  ['PATCH', /^\/api\/profile\/?$/, 'profile.update', 'Actualizó su perfil'],
  ['POST', /^\/api\/profile\/avatar$/, 'profile.avatar', 'Cambió su foto de perfil'],
  ['POST', /^\/api\/profile\/signature$/, 'profile.signature_save', 'Guardó su firma manuscrita'],
  ['DELETE', /^\/api\/profile\/signature$/, 'profile.signature_delete', 'Eliminó su firma manuscrita'],
  ['PATCH', /^\/api\/profile\/password$/, 'profile.password', 'Cambió su contraseña'],
  ['DELETE', /^\/api\/profile\/?$/, 'profile.delete_account', 'Eliminó su cuenta'],
  ['POST', /^\/api\/signatures\/?$/, 'profile.signature_save', 'Guardó su firma manuscrita'],
  ['DELETE', /^\/api\/signatures\/?$/, 'profile.signature_delete', 'Eliminó su firma manuscrita'],
  ['POST', new RegExp(`^/api/signing/${UUID}/sign$`), 'signing.sign', 'Firmó un documento (transacción enviada)'],
  ['DELETE', new RegExp(`^/api/signing/${UUID}/revoke$`), 'signing.revoke', 'Revocó una firma'],
  ['GET', new RegExp(`^/api/signing/${UUID}/verify$`), 'signing.verify', 'Verificó un documento propio'],
  ['GET', /^\/api\/signing\/public\/[0-9a-fA-F]+$/, 'signing.public_verify', 'Verificación pública por huella'],
  ['POST', /^\/api\/agent\/chat$/, 'agent.chat', 'Consultó al asistente Sign IA'],
];

const resultOf = (status) => (status < 400 ? 'permitido' : status === 401 || status === 403 ? 'denegado' : 'error');

/**
 * Middleware: asigna un ID a cada petición y, al terminar, registra las
 * acciones importantes con su resultado.
 */
const auditMiddleware = (req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);

  // Guardamos la respuesta JSON para leer, por ejemplo, el id del documento subido
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    res.locals.body = body;
    return originalJson(body);
  };

  res.on('finish', () => {
    const path = req.originalUrl.split('?')[0];
    const rule = RULES.find(([m, re]) => m === req.method && re.test(path));
    // También se registran los tokens rechazados en cualquier ruta protegida
    const denied = res.statusCode === 401 && path.startsWith('/api/') && !rule;
    if (!rule && !denied) return;

    const body = res.locals.body || {};
    const uuid = path.match(/[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}/);
    let resource = uuid ? uuid[0] : null;
    if (!resource && body.document?.id) resource = body.document.id;
    if (rule && rule[2] === 'signing.public_verify') resource = path.split('/').pop().slice(0, 16) + '…';

    let result = resultOf(res.statusCode);
    // La verificación de correo responde con redirección: el resultado va en la URL
    if (rule && rule[2] === 'auth.verify_email') {
      result = /success=true/.test(res.getHeader('Location') || '') ? 'permitido' : 'error';
    }

    const email = (req.body && typeof req.body.email === 'string') ? req.body.email.trim().toLowerCase() : null;
    const userId = req.user?.id || body.user?.id || null;

    logAudit({
      userId,
      actorEmail: email || body.user?.email || null,
      action: rule ? rule[2] : 'auth.token_rejected',
      description: rule ? rule[3] : 'Token rechazado o vencido',
      resource,
      result,
      statusCode: res.statusCode,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      requestId: req.id,
      method: req.method,
      path,
      detail: res.statusCode >= 400 && body.error
        ? { error: String(body.error).slice(0, 200) }
        : (res.locals.auditDetail || null),
    });
  });

  next();
};

module.exports = { initAudit, logAudit, auditMiddleware, clientIp };
