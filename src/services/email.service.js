const nodemailer = require('nodemailer');

// ────────────────────────────────────────────────
// CONFIGURACIÓN — envío con Gmail
// ────────────────────────────────────────────────
// Variables de entorno (.env):
//   EMAIL_USER           → tu cuenta de Gmail  (también acepta GMAIL_USER)
//   EMAIL_PASS           → contraseña de aplicación de 16 caracteres (también acepta GMAIL_APP_PASSWORD)
//   APP_BASE_URL         → URL del frontend  (ej: http://localhost:8080)
//   APP_BASE_URL_BACKEND → URL del backend   (ej: http://localhost:3000)

// La configuración se lee al momento de enviar (no al importar el archivo),
// así funciona aunque dotenv se cargue después de este require.
const cfg = () => ({
  user: (process.env.EMAIL_USER || process.env.GMAIL_USER || '').trim(),
  pass: (process.env.EMAIL_PASS || process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),
  frontend: process.env.APP_BASE_URL || 'http://localhost:8080',
  backend: process.env.APP_BASE_URL_BACKEND || 'http://localhost:3000',
});

// Revisa el .env y devuelve un mensaje claro si algo falta
const configProblem = () => {
  const { user, pass } = cfg();
  if (!user) return 'Falta EMAIL_USER en el .env';
  if (!pass) return 'Falta EMAIL_PASS en el .env';
  if (pass.length !== 16) return `EMAIL_PASS tiene ${pass.length} caracteres; la contraseña de aplicación de Gmail tiene 16`;
  return null;
};

// Dos formas de conectar con Gmail: 465 (SSL) y 587 (STARTTLS).
// Si una red bloquea o hace lento el 465, se reintenta por el 587.
const makeTransport = (port) => {
  const { user, pass } = cfg();
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
};

const NETWORK_ERRORS = ['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'EDNS'];

// Traduce los errores de Gmail a algo entendible en la terminal
const explain = (err) => {
  if (err.responseCode === 535 || err.code === 'EAUTH')
    return 'Gmail rechazó usuario/contraseña. Revisa EMAIL_USER y crea una NUEVA contraseña de aplicación (si la borraste o cambiaste la contraseña de Google, la anterior deja de servir).';
  if (NETWORK_ERRORS.includes(err.code))
    return 'No se pudo conectar con Gmail (red/firewall/antivirus bloqueando SMTP). Prueba con otra red, por ejemplo los datos del celular.';
  if (err.responseCode === 550 || err.responseCode === 553)
    return 'Gmail rechazó el destinatario: revisa que el correo exista y esté bien escrito.';
  return '';
};

// Escapa texto del usuario antes de meterlo en el HTML
const escapeHtml = (str = '') =>
  String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Envío genérico: intenta 465 y, si es un problema de red, reintenta por 587
const sendEmail = async ({ to, subject, html, link }) => {
  console.log(`[email] Enlace para ${to}: ${link}`); // siempre visible, aunque el correo falle
  const problem = configProblem();
  if (problem) {
    console.error(`[email] ${problem}`);
    throw new Error(problem);
  }
  const { user } = cfg();
  const message = { from: `"BlockSign" <${user}>`, to, subject, html };

  let lastErr;
  for (const port of [465, 587]) {
    try {
      const info = await makeTransport(port).sendMail(message);
      console.log(`[email] Enviado a ${to} por el puerto ${port} (messageId: ${info.messageId})`);
      return info;
    } catch (err) {
      lastErr = err;
      console.error(`[email] Falló por el puerto ${port}:`, err.code || '', err.responseCode || '', err.message);
      if (!NETWORK_ERRORS.includes(err.code)) break; // error de autenticación o destinatario: no sirve reintentar
    }
  }
  const hint = explain(lastErr);
  if (hint) console.error(`[email] → ${hint}`);
  throw lastErr;
};

// Comprueba la conexión con Gmail. Llámala al arrancar el servidor:
//   require('./services/email.service').verifyEmailTransport();
const verifyEmailTransport = async () => {
  const problem = configProblem();
  if (problem) {
    console.error(`[email] ${problem}`);
    return false;
  }
  for (const port of [465, 587]) {
    try {
      await makeTransport(port).verify();
      console.log(`[email] Conexión con Gmail OK por el puerto ${port} (${cfg().user})`);
      return true;
    } catch (err) {
      console.error(`[email] Gmail no responde por el puerto ${port}:`, err.code || '', err.message);
      const hint = explain(err);
      if (hint && !NETWORK_ERRORS.includes(err.code)) {
        console.error(`[email] → ${hint}`);
        return false;
      }
    }
  }
  console.error(`[email] → ${explain({ code: 'ETIMEDOUT' })}`);
  return false;
};

// ────────────────────────────────────────────────
// VERIFICACIÓN DE EMAIL
// ────────────────────────────────────────────────
const sendVerificationEmail = async (email, name, token) => {
  const link = `${cfg().backend}/api/auth/verify-email/${encodeURIComponent(token)}`;
  const safeName = escapeHtml(name);

  return sendEmail({
    to: email,
    subject: 'Verifica tu cuenta en BlockSign',
    link,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family: 'Segoe UI', sans-serif; background: #0f0f1a; color: #fff; margin: 0; padding: 20px;">
        <div style="max-width: 560px; margin: 0 auto; background: #1a1a2e; border-radius: 16px; padding: 40px; border: 1px solid #2a2a4a;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #6366f1; font-size: 28px; margin: 0;">🔐 BlockSign</h1>
            <p style="color: #9ca3af; margin-top: 8px; font-size: 14px;">Sistema de Firma Digital con Blockchain</p>
          </div>
          <h2 style="color: #e5e7eb; font-size: 22px; margin-bottom: 12px;">Hola, ${safeName} 👋</h2>
          <p style="color: #9ca3af; line-height: 1.6; margin-bottom: 24px;">
            Gracias por registrarte en BlockSign. Para activar tu cuenta verifica tu correo electrónico.
          </p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${link}" style="background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; padding: 16px 40px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 16px; display: inline-block;">
              Verificar mi cuenta
            </a>
          </div>
          <p style="color: #6b7280; font-size: 13px; line-height: 1.6;">
            Si el botón no funciona, copia este enlace en tu navegador:<br>
            <span style="color: #9ca3af; word-break: break-all;">${link}</span>
          </p>
          <p style="color: #6b7280; font-size: 13px; line-height: 1.6;">
            Este enlace expira en <strong style="color: #9ca3af;">24 horas</strong>. Si no creaste esta cuenta, ignora este mensaje.
          </p>
          <hr style="border: none; border-top: 1px solid #2a2a4a; margin: 24px 0;">
          <p style="color: #4b5563; font-size: 12px; text-align: center;">
            BlockSign · Universidad Manuela Beltrán · IS25133 · 2026
          </p>
        </div>
      </body>
      </html>
    `,
  });
};

// ────────────────────────────────────────────────
// RECUPERAR CONTRASEÑA
// ────────────────────────────────────────────────
const sendPasswordResetEmail = async (email, name, token) => {
  const link = `${cfg().frontend}/#/reset-password?token=${encodeURIComponent(token)}`;
  const safeName = escapeHtml(name);

  return sendEmail({
    to: email,
    subject: 'Recupera tu contraseña de BlockSign',
    link,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family: 'Segoe UI', sans-serif; background: #0f0f1a; color: #fff; margin: 0; padding: 20px;">
        <div style="max-width: 560px; margin: 0 auto; background: #1a1a2e; border-radius: 16px; padding: 40px; border: 1px solid #2a2a4a;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #6366f1; font-size: 28px; margin: 0;">🔐 BlockSign</h1>
          </div>
          <h2 style="color: #e5e7eb; font-size: 22px; margin-bottom: 12px;">Recuperar contraseña</h2>
          <p style="color: #9ca3af; line-height: 1.6; margin-bottom: 24px;">
            Hola <strong style="color: #e5e7eb;">${safeName}</strong>, recibimos una solicitud para restablecer tu contraseña.
          </p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${link}" style="background: linear-gradient(135deg, #f59e0b, #ef4444); color: white; padding: 16px 40px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 16px; display: inline-block;">
              Restablecer contraseña
            </a>
          </div>
          <p style="color: #6b7280; font-size: 13px; line-height: 1.6;">
            Si el botón no funciona, copia este enlace en tu navegador:<br>
            <span style="color: #9ca3af; word-break: break-all;">${link}</span>
          </p>
          <div style="background: #111827; border-radius: 8px; padding: 16px; margin-top: 16px;">
            <p style="color: #6b7280; font-size: 13px; margin: 0; line-height: 1.6;">
              ⚠️ Este enlace <strong style="color: #9ca3af;">expira en 1 hora</strong>. Si no solicitaste este cambio, ignora este correo.
            </p>
          </div>
          <hr style="border: none; border-top: 1px solid #2a2a4a; margin: 24px 0;">
          <p style="color: #4b5563; font-size: 12px; text-align: center;">
            BlockSign · Universidad Manuela Beltrán · IS25133 · 2026
          </p>
        </div>
      </body>
      </html>
    `,
  });
};

module.exports = { sendVerificationEmail, sendPasswordResetEmail, verifyEmailTransport };
