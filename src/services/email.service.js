const nodemailer = require('nodemailer');

// ────────────────────────────────────────────────
// CONFIGURACIÓN — envío con Gmail
// ────────────────────────────────────────────────
// Variables de entorno (.env):
//   EMAIL_USER           → tu cuenta de Gmail  (también acepta GMAIL_USER)
//   EMAIL_PASS           → contraseña de aplicación de 16 caracteres (también acepta GMAIL_APP_PASSWORD)
//   APP_BASE_URL         → URL del frontend  (ej: http://localhost:8080)
//   APP_BASE_URL_BACKEND → URL del backend   (ej: http://localhost:3000)
//   BREVO_API_KEY        → (opcional) envía por la API HTTPS de Brevo en vez de SMTP.
//                          Necesario en Render gratis, que bloquea los puertos SMTP.
//   EMAIL_FROM           → (opcional, con Brevo) remitente verificado; por defecto EMAIL_USER

// La configuración se lee al momento de enviar (no al importar el archivo),
// así funciona aunque dotenv se cargue después de este require.
const cfg = () => ({
  user: (process.env.EMAIL_USER || process.env.GMAIL_USER || '').trim(),
  pass: (process.env.EMAIL_PASS || process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),
  frontend: (process.env.APP_BASE_URL || 'http://localhost:8080').trim().replace(/\/+$/, ''),
  backend: (process.env.APP_BASE_URL_BACKEND || 'http://localhost:3000').trim().replace(/\/+$/, ''),
  brevoKey: (process.env.BREVO_API_KEY || '').trim().replace(/^["']|["']$/g, ''),
  from: (process.env.EMAIL_FROM || process.env.EMAIL_USER || process.env.GMAIL_USER || '').trim(),
});

const useBrevo = () => !!cfg().brevoKey;

// Revisa el .env y devuelve un mensaje claro si algo falta
const configProblem = () => {
  if (useBrevo()) return cfg().from ? null : 'Falta EMAIL_FROM (o EMAIL_USER) para enviar con Brevo';
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

// ────────────────────────────────────────────────
// ENVÍO POR API HTTPS (Brevo)
// ────────────────────────────────────────────────
// Render gratis bloquea los puertos SMTP (25, 465, 587), así que allí
// el correo sale por HTTPS (puerto 443). El remitente debe estar verificado en Brevo.
const toList = (v) =>
  (Array.isArray(v) ? v : String(v || '').split(','))
    .map((e) => String(e).trim())
    .filter(Boolean)
    .map((email) => ({ email }));

const sendViaBrevo = async ({ to, bcc, subject, html, text, attachments, replyTo }) => {
  const { brevoKey, from } = cfg();
  const body = {
    sender: { name: 'DocBlockSign', email: from },
    to: toList(to),
    subject,
    htmlContent: html,
    textContent: text,
  };
  const b = toList(bcc);
  if (b.length) body.bcc = b;
  if (replyTo) body.replyTo = { email: replyTo };
  if (attachments?.length) {
    body.attachment = attachments.map((a) => ({
      name: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(a.content || '').toString('base64'),
    }));
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': brevoKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Brevo respondió ${res.status}`);
    err.code = 'EBREVO';
    err.responseCode = res.status;
    if (res.status === 401) console.error('[email] → BREVO_API_KEY inválida. Crea una en Brevo → SMTP & API → API Keys.');
    if (res.status === 400 && /sender/i.test(err.message))
      console.error(`[email] → El remitente ${from} no está verificado en Brevo (Senders, Domains & Dedicated IPs → Senders).`);
    throw err;
  }
  console.log(`[email] Enviado a ${to} por Brevo (messageId: ${data.messageId || '—'})`);
  return { messageId: data.messageId };
};

// Envío genérico: intenta 465 y, si es un problema de red, reintenta por 587
const sendEmail = async ({ to, bcc, subject, html, text, link, attachments, replyTo }) => {
  if (link) console.log(`[email] Enlace para ${to}: ${link}`); // siempre visible, aunque el correo falle
  const problem = configProblem();
  if (problem) {
    console.error(`[email] ${problem}`);
    throw new Error(problem);
  }
  if (useBrevo()) return sendViaBrevo({ to, bcc, subject, html, text, attachments, replyTo });
  const { user } = cfg();
  const message = { from: `"DocBlockSign" <${user}>`, to, subject, html, text };
  if (attachments?.length) message.attachments = attachments;
  if (replyTo) message.replyTo = replyTo;
  if (bcc) message.bcc = bcc;

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
  if (useBrevo()) {
    console.log(`[email] Envío por Brevo (HTTPS) como ${cfg().from}`);
    return true;
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
// PLANTILLA BASE
// Tablas + estilos en línea: así se ve bien en Gmail, Outlook y el celular.
// Colores de la app: azul institucional #0B45B5 y azul medio #1565C0.
// ────────────────────────────────────────────────
const C = {
  primary: '#0B45B5',
  cyan: '#1565C0',
  text: '#202124',
  hint: '#5F6368',
  border: '#E3E8EF',
  page: '#F4F6FA',
  success: '#2E7D32',
  warning: '#D99A00',
  danger: '#DC2626',
};
const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const button = (href, label, color = C.primary) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:28px auto;">
    <tr><td align="center" bgcolor="${color}" style="border-radius:10px;">
      <a href="${href}" target="_blank"
         style="display:inline-block;padding:15px 36px;font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">
        ${label}
      </a>
    </td></tr>
  </table>`;

const callout = (html, color = C.primary, icon = 'ℹ️') => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;">
    <tr><td style="background:${color}0F;border:1px solid ${color}33;border-left:4px solid ${color};border-radius:10px;padding:14px 16px;font-family:${FONT};font-size:13px;line-height:1.6;color:${C.text};">
      <span style="font-size:15px;">${icon}</span>&nbsp; ${html}
    </td></tr>
  </table>`;

// Lista de pasos numerados (1, 2, 3…)
const steps = (items) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px;">
    ${items
      .map(
        (t, i) => `
      <tr>
        <td width="34" valign="top" style="padding:6px 0;">
          <div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:${C.primary}14;color:${C.primary};font-family:${FONT};font-size:13px;font-weight:800;text-align:center;">${i + 1}</div>
        </td>
        <td valign="top" style="padding:8px 0 6px 8px;font-family:${FONT};font-size:14px;line-height:1.5;color:${C.text};">${t}</td>
      </tr>`
      )
      .join('')}
  </table>`;

// Tabla etiqueta / valor (datos de la firma, etc.)
const dataTable = (rows) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;border:1px solid ${C.border};border-radius:10px;border-collapse:separate;">
    ${rows
      .map(
        ([k, v, mono], i) => `
      <tr>
        <td style="padding:11px 14px;${i ? `border-top:1px solid ${C.border};` : ''}font-family:${FONT};font-size:12px;font-weight:600;color:${C.hint};white-space:nowrap;" valign="top">${k}</td>
        <td style="padding:11px 14px;${i ? `border-top:1px solid ${C.border};` : ''}font-family:${mono ? "Consolas, 'Courier New', monospace" : FONT};font-size:${mono ? 12 : 13}px;font-weight:600;color:${C.text};word-break:break-all;" align="right">${v}</td>
      </tr>`
      )
      .join('')}
  </table>`;

const fallbackLink = (link) => `
  <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.hint};">
    ¿El botón no funciona? Copia este enlace en tu navegador:<br>
    <a href="${link}" style="color:${C.primary};word-break:break-all;">${link}</a>
  </p>`;

/**
 * Arma el correo completo.
 * @param preheader texto corto que Gmail muestra junto al asunto
 * @param accent    color de la franja superior e ícono
 */
const layout = ({ preheader, accent = C.primary, icon = '🔐', eyebrow, title, body }) => `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light only">
  <title>${title}</title>
  <style>
    @media (max-width: 480px) {
      .pad { padding: 28px 22px 8px !important; }
      .padb { padding: 8px 22px 26px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}">
    <tr><td align="center" style="padding:32px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;">

        <!-- Marca -->
        <tr><td align="center" style="padding-bottom:20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td bgcolor="${C.primary}" style="width:38px;height:38px;border-radius:10px;text-align:center;font-size:19px;line-height:38px;">⛓️</td>
            <td style="padding-left:10px;font-family:${FONT};font-size:21px;font-weight:800;color:${C.text};letter-spacing:-0.3px;">Block<span style="color:${C.primary};">Sign</span></td>
          </tr></table>
        </td></tr>

        <!-- Tarjeta -->
        <tr><td bgcolor="#ffffff" style="border-radius:16px;border:1px solid ${C.border};overflow:hidden;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="height:5px;line-height:5px;font-size:0;background:${accent};background-image:linear-gradient(90deg, ${accent}, ${C.cyan});">&nbsp;</td></tr>
            <tr><td style="padding:36px 36px 8px;" class="pad">
              <div style="width:56px;height:56px;line-height:56px;border-radius:16px;background:${accent}14;text-align:center;font-size:28px;margin-bottom:18px;">${icon}</div>
              ${eyebrow ? `<p style="margin:0 0 6px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${accent};">${eyebrow}</p>` : ''}
              <h1 style="margin:0 0 14px;font-family:${FONT};font-size:24px;line-height:1.3;font-weight:800;color:${C.text};">${title}</h1>
              ${body}
            </td></tr>
            <tr><td style="padding:8px 36px 32px;" class="padb"></td></tr>
          </table>
        </td></tr>

        <!-- Pie -->
        <tr><td align="center" style="padding:22px 20px 0;font-family:${FONT};font-size:12px;line-height:1.7;color:#8A919C;">
          Firma digital con huella SHA-256 y registro en Ethereum (Sepolia)<br>
          DocBlockSign · Universidad Manuela Beltrán · Proyecto de grado 2026<br>
          <span style="color:#A9AFB8;">Este es un correo automático, no es necesario responderlo.</span>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

const p = (html, extra = '') =>
  `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.65;color:#3C4043;${extra}">${html}</p>`;

const fmtDate = (d = new Date()) =>
  new Date(d).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'long', timeStyle: 'short' });

// ────────────────────────────────────────────────
// VERIFICACIÓN DE EMAIL
// ────────────────────────────────────────────────
const sendVerificationEmail = async (email, name, token) => {
  const link = `${cfg().backend}/api/auth/verify-email/${encodeURIComponent(token)}`;
  const safeName = escapeHtml(name);

  return sendEmail({
    to: email,
    subject: 'Confirma tu correo para activar DocBlockSign',
    link,
    text: `Hola ${name}:\n\nConfirma tu correo para activar tu cuenta de DocBlockSign:\n${link}\n\nEl enlace vence en 24 horas. Si no creaste esta cuenta, ignora este mensaje.`,
    html: layout({
      preheader: 'Un clic y tu cuenta queda lista para firmar documentos.',
      icon: '✉️',
      eyebrow: 'Activa tu cuenta',
      title: `¡Hola, ${safeName}! Confirma tu correo`,
      body: `
        ${p('Gracias por registrarte en <strong>DocBlockSign</strong>. Solo falta confirmar que este correo es tuyo para activar tu cuenta.')}
        ${button(link, 'Confirmar mi correo')}
        ${p('<strong>Lo que podrás hacer:</strong>', 'margin-bottom:4px;')}
        ${steps([
          'Subir tus documentos y obtener un <strong>análisis automático con IA</strong>.',
          'Firmarlos con tu firma manuscrita digital.',
          'Registrar cada firma en <strong>blockchain</strong> para que nadie pueda alterarla.',
        ])}
        ${callout('Este enlace vence en <strong>24 horas</strong>. Si no creaste esta cuenta, ignora este correo: no se activará.', C.warning, '⏳')}
        ${fallbackLink(link)}`,
    }),
  });
};

// ────────────────────────────────────────────────
// BIENVENIDA (después de verificar)
// ────────────────────────────────────────────────
const sendWelcomeEmail = async (email, name) => {
  const link = `${cfg().frontend}/#/login`;
  const safeName = escapeHtml(name);
  return sendEmail({
    to: email,
    subject: '¡Tu cuenta de DocBlockSign está activa!',
    text: `Hola ${name}:\n\nTu cuenta de DocBlockSign ya está activa. Ingresa en ${link}\n\nPrimeros pasos: crea tu firma en Perfil, sube un documento y fírmalo.`,
    html: layout({
      preheader: 'Ya puedes subir, analizar y firmar tus documentos.',
      accent: C.success,
      icon: '🎉',
      eyebrow: 'Cuenta activada',
      title: `¡Bienvenido a DocBlockSign, ${safeName}!`,
      body: `
        ${p('Tu correo quedó verificado y tu cuenta ya está activa. Así empiezas en menos de 2 minutos:')}
        ${steps([
          '<strong>Crea tu firma</strong> en <em>Perfil → Mi firma</em> (la dibujas una sola vez).',
          '<strong>Sube un documento</strong> PDF o Word: la IA lo resume y lo clasifica.',
          '<strong>Fírmalo</strong> y mira en vivo cómo se registra en la blockchain.',
          '<strong>Verifica</strong> cualquier archivo cuando quieras para comprobar que no fue modificado.',
        ])}
        ${button(link, 'Ingresar a DocBlockSign', C.success)}`,
    }),
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
    subject: 'Restablece tu contraseña de DocBlockSign',
    link,
    text: `Hola ${name}:\n\nRecibimos una solicitud para restablecer tu contraseña. Crea una nueva aquí:\n${link}\n\nEl enlace vence en 1 hora. Si no fuiste tú, ignora este correo: tu contraseña no cambiará.`,
    html: layout({
      preheader: 'Crea una nueva contraseña. El enlace vence en 1 hora.',
      accent: C.warning,
      icon: '🔑',
      eyebrow: 'Seguridad de la cuenta',
      title: 'Restablece tu contraseña',
      body: `
        ${p(`Hola <strong>${safeName}</strong>, recibimos una solicitud para cambiar la contraseña de tu cuenta.`)}
        ${p('Haz clic en el botón para crear una nueva. Debe tener al menos 8 caracteres, una mayúscula y un número.')}
        ${button(link, 'Crear nueva contraseña', C.warning)}
        ${dataTable([
          ['Solicitado', fmtDate()],
          ['Vence en', '1 hora'],
        ])}
        ${callout('¿No fuiste tú? Ignora este correo: tu contraseña <strong>no cambiará</strong> mientras nadie use este enlace.', C.danger, '🛡️')}
        ${fallbackLink(link)}`,
    }),
  });
};

// ────────────────────────────────────────────────
// CONTRASEÑA CAMBIADA (aviso de seguridad)
// ────────────────────────────────────────────────
const sendPasswordChangedEmail = async (email, name) => {
  const link = `${cfg().frontend}/#/forgot-password`;
  const safeName = escapeHtml(name);
  return sendEmail({
    to: email,
    subject: 'Tu contraseña de DocBlockSign fue cambiada',
    text: `Hola ${name}:\n\nLa contraseña de tu cuenta se cambió el ${fmtDate()}.\nSi no fuiste tú, recupera tu cuenta de inmediato: ${link}`,
    html: layout({
      preheader: 'Si fuiste tú, no tienes que hacer nada.',
      accent: C.success,
      icon: '✅',
      eyebrow: 'Aviso de seguridad',
      title: 'Tu contraseña fue actualizada',
      body: `
        ${p(`Hola <strong>${safeName}</strong>, te confirmamos que la contraseña de tu cuenta se cambió correctamente.`)}
        ${dataTable([
          ['Cuenta', escapeHtml(email)],
          ['Fecha', fmtDate()],
        ])}
        ${p('Si fuiste tú, no tienes que hacer nada más.')}
        ${callout(`¿No reconoces este cambio? <a href="${link}" style="color:${C.danger};font-weight:700;">Recupera tu cuenta ahora</a> y cambia también la contraseña de tu correo.`, C.danger, '⚠️')}`,
    }),
  });
};

// ────────────────────────────────────────────────
// DOCUMENTO FIRMADO (comprobante)
// ────────────────────────────────────────────────
const sendDocumentSignedEmail = async (email, name, info) => {
  const { title, documentHash, txHash, blockNumber, explorerUrl, signedAt } = info;
  const verifyLink = `${cfg().frontend}/#/home`;
  const safeName = escapeHtml(name);
  const safeTitle = escapeHtml(title);
  const short = (h) => (h && h.length > 26 ? `${h.slice(0, 14)}…${h.slice(-10)}` : h || '—');
  return sendEmail({
    to: email,
    subject: `Firmaste "${title}" ✍️`,
    text: `Hola ${name}:\n\nFirmaste "${title}" y quedó registrado en la blockchain Sepolia.\n\nHuella SHA-256: ${documentHash}\nTransacción: ${txHash}\nBloque: ${blockNumber}\nVer en Etherscan: ${explorerUrl}\n\nGuarda este correo como comprobante.`,
    html: layout({
      preheader: `Comprobante de firma · bloque #${blockNumber}`,
      accent: C.primary,
      icon: '✍️',
      eyebrow: 'Comprobante de firma',
      title: 'Documento firmado y registrado en blockchain',
      body: `
        ${p(`Hola <strong>${safeName}</strong>, tu firma de <strong>“${safeTitle}”</strong> quedó registrada de forma permanente en la red Ethereum Sepolia.`)}
        ${dataTable([
          ['Documento', safeTitle],
          ['Fecha', fmtDate(signedAt || new Date())],
          ['Bloque', `#${blockNumber ?? '—'}`],
          ['Huella SHA-256', short(documentHash), true],
          ['Transacción', short(txHash), true],
        ])}
        ${explorerUrl ? button(explorerUrl, 'Ver transacción en Etherscan') : ''}
        ${callout(`Cualquier persona puede comprobar que el archivo es auténtico subiéndolo en <a href="${verifyLink}" style="color:${C.primary};font-weight:700;">DocBlockSign → Verificar</a>. Si alguien cambia aunque sea un carácter, la verificación fallará.`, C.cyan, '🔎')}
        ${p('Guarda este correo como comprobante de tu firma.', `font-size:13px;color:${C.hint};`)}`,
    }),
  });
};

/**
 * Envía un documento a otras personas desde la plataforma.
 * Incluye el archivo adjunto (o un enlace), su huella SHA-256 y, si está firmado,
 * los datos del registro en blockchain y un enlace para verificarlo sin cuenta.
 */
const sendDocumentEmail = async ({ to, bcc, sender, doc, message, subject, attachment, kind = 'info', inApp = false }) => {
  const { title, hash, signed, txHash, blockNumber, explorerUrl, signedAt, fileUrl } = doc;
  const verifyLink = `${cfg().frontend}/#/verify?hash=${encodeURIComponent(hash || '')}`;
  const safeTitle = escapeHtml(title);
  const safeSender = escapeHtml(sender.name || sender.email);
  const short = (h) => (h && h.length > 26 ? `${h.slice(0, 14)}…${h.slice(-10)}` : h || '—');
  const note = message ? escapeHtml(message).replace(/\r?\n/g, '<br>') : '';

  const rows = [
    ['Documento', safeTitle],
    ['Enviado por', `${safeSender}<br><span style="font-weight:500;color:${C.hint};">${escapeHtml(sender.email)}</span>`],
    ['Estado', signed ? '✅ Firmado y registrado en blockchain' : '⏳ Pendiente de firma'],
    ['Huella SHA-256', short(hash), true],
  ];
  if (signed) {
    rows.push(['Bloque', `#${blockNumber ?? '—'}`]);
    rows.push(['Transacción', short(txHash), true]);
    if (signedAt) rows.push(['Firmado', fmtDate(signedAt)]);
  }

  const review = kind === 'review';
  const appLink = `${cfg().frontend}/#/login`;
  return sendEmail({
    to,
    bcc,
    replyTo: sender.email,
    attachments: attachment ? [attachment] : undefined,
    subject: subject || (review ? `${sender.name || sender.email} te pidió revisar "${title}"` : `${sender.name || sender.email} te compartió "${title}"`),
    text:
      `${sender.name || sender.email} (${sender.email}) te compartió "${title}" por DocBlockSign.\n\n` +
      (message ? `Mensaje:\n${message}\n\n` : '') +
      `Estado: ${signed ? 'firmado y registrado en blockchain' : 'pendiente de firma'}\n` +
      `Huella SHA-256: ${hash}\n` +
      (signed ? `Transacción: ${txHash}\nBloque: ${blockNumber}\n` : '') +
      (attachment ? 'El archivo va adjunto.\n' : `Descargar: ${fileUrl}\n`) +
      `\nVerifica su autenticidad: ${verifyLink}`,
    html: layout({
      preheader: `${sender.name || sender.email} te compartió un documento`,
      accent: signed ? C.success : C.primary,
      icon: '📄',
      eyebrow: review ? 'Solicitud de revisión' : 'Documento compartido',
      title: review ? `Te pidieron revisar “${safeTitle}”` : `Te compartieron “${safeTitle}”`,
      body: `
        ${p(review
          ? `<strong>${safeSender}</strong> te envió este documento para que lo <strong>revises y lo apruebes o rechaces</strong>.`
          : `<strong>${safeSender}</strong> te envió este documento a través de DocBlockSign.`)}
        ${inApp ? callout(`También está en tu <strong>bandeja de entrada</strong> de DocBlockSign${review ? ', donde puedes aprobarlo o rechazarlo' : ''}. <a href="${appLink}" style="color:${C.primary};font-weight:700;">Abrir DocBlockSign</a>`, C.primary, '📥') : ''}
        ${note ? callout(note, C.primary, '💬') : ''}
        ${dataTable(rows)}
        ${attachment
          ? p(`📎 El archivo va <strong>adjunto</strong> a este correo.`)
          : button(fileUrl, 'Descargar documento')}
        ${button(verifyLink, signed ? 'Verificar autenticidad' : 'Ver huella del documento', signed ? C.primary : C.cyan)}
        ${callout(
          signed
            ? 'Para comprobar que nadie lo modificó, abre “Verificar autenticidad” y sube el archivo: DocBlockSign calcula su huella en tu navegador y la compara con la registrada en blockchain.'
            : 'Este documento todavía no está firmado. Su huella SHA-256 sirve para comprobar más adelante que el archivo no cambió.',
          C.cyan,
          '🔎'
        )}
        ${signed && explorerUrl ? p(`También puedes ver la transacción en <a href="${explorerUrl}" style="color:${C.primary};font-weight:700;">Etherscan</a>.`, `font-size:13px;color:${C.hint};`) : ''}
        ${p('Si no esperabas este correo, puedes ignorarlo. Responder a este mensaje le escribe directamente a quien te lo envió.', `font-size:12px;color:${C.hint};`)}`,
    }),
  });
};

/** Aviso al remitente: alguien aprobó o rechazó un documento que envió para revisión */
const sendShareResponseEmail = async ({ to, senderName, reviewer, title, decision, comment }) => {
  const ok = decision === 'approved';
  const safeTitle = escapeHtml(title);
  const who = escapeHtml(reviewer.name || reviewer.email);
  return sendEmail({
    to,
    replyTo: reviewer.email,
    subject: `${reviewer.name || reviewer.email} ${ok ? 'aprobó' : 'rechazó'} "${title}"`,
    text: `${reviewer.name || reviewer.email} ${ok ? 'aprobó' : 'rechazó'} "${title}".${comment ? `\n\nComentario: ${comment}` : ''}`,
    html: layout({
      preheader: `${ok ? 'Aprobado' : 'Rechazado'}: ${title}`,
      accent: ok ? C.success : C.danger || '#D32F2F',
      icon: ok ? '✅' : '↩️',
      eyebrow: 'Respuesta a tu solicitud',
      title: ok ? 'Documento aprobado' : 'Documento rechazado',
      body: `
        ${p(`Hola <strong>${escapeHtml(senderName || '')}</strong>, <strong>${who}</strong> ${ok ? 'aprobó' : 'rechazó'} <strong>“${safeTitle}”</strong>.`)}
        ${comment ? callout(escapeHtml(comment).replace(/\r?\n/g, '<br>'), ok ? C.success : C.warning, '💬') : ''}
        ${button(`${cfg().frontend}/#/login`, 'Ver en mi bandeja')}`,
    }),
  });
};

module.exports = {
  sendVerificationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendDocumentSignedEmail,
  sendDocumentEmail,
  sendShareResponseEmail,
  verifyEmailTransport,
};
