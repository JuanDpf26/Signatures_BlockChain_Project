const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/db');
const {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
  sendPasswordChangedEmail,
} = require('../services/email.service');
const { verifyGoogleToken } = require('../services/google.service');

// ────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────
const generateToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '7d' });

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Guarda y compara siempre el correo en minúsculas y sin espacios
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const isStrongPassword = (password) =>
  password.length >= 8 &&
  /[A-Z]/.test(password) &&
  /[0-9]/.test(password);

const newVerificationToken = () => ({
  token: crypto.randomBytes(32).toString('hex'),
  expires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
});

// Envía en segundo plano: la respuesta HTTP no espera al servidor de correo
// (Gmail puede tardar varios segundos y el frontend corta a los 15 s).
const sendInBackground = (label, fn) => {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`[email] ${label}: enviado`))
    .catch((err) => console.error(`[email] ${label}: ERROR`, err.code || '', err.message));
};

// ────────────────────────────────────────────────
// REGISTER
// ────────────────────────────────────────────────
const register = async (req, res) => {
  try {
    const { name, password, document_id, phone, captchaToken } = req.body;
    const email = normalizeEmail(req.body.email);

    // Validaciones básicas
    if (!name || !email || !password || !document_id || !phone) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'El correo electrónico no es válido' });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({
        error: 'La contraseña debe tener mínimo 8 caracteres, una mayúscula y un número',
      });
    }

    if (!/^\d{6,12}$/.test(document_id)) {
      return res.status(400).json({ error: 'El documento debe tener entre 6 y 12 dígitos' });
    }

    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'El teléfono debe tener 10 dígitos' });
    }

    // CAPTCHA
    if (!captchaToken) {
      return res.status(400).json({ error: 'Debes completar el captcha' });
    }
    const captchaValid = await verifyCaptcha(captchaToken);
    if (!captchaValid) {
      return res.status(400).json({ error: 'Captcha inválido, intenta de nuevo' });
    }

    // ¿El correo ya existe?
    const existing = await pool.query(
      'SELECT id, name, is_email_verified FROM users WHERE LOWER(email) = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      const user = existing.rows[0];

      // Cuenta creada pero nunca verificada (p. ej. el correo no llegó):
      // generamos un token nuevo y reenviamos, en vez de dejarla atrapada.
      if (!user.is_email_verified) {
        const { token, expires } = newVerificationToken();
        await pool.query(
          `UPDATE users
             SET email_verification_token = $1,
                 email_verification_expires = $2
           WHERE id = $3`,
          [token, expires, user.id]
        );
        sendInBackground(`verificación (reenvío) a ${email}`, () => sendVerificationEmail(email, user.name, token));
        return res.status(200).json({
          message: 'Esta cuenta ya estaba registrada pero no verificada. Te enviamos un nuevo correo de verificación.',
        });
      }

      return res.status(409).json({ error: 'Ya existe una cuenta con este correo' });
    }

    // Documento duplicado
    const existingDoc = await pool.query('SELECT id FROM users WHERE document_id = $1', [document_id]);
    if (existingDoc.rows.length > 0) {
      return res.status(409).json({ error: 'Ya existe una cuenta con este documento' });
    }

    const hashed = await bcrypt.hash(password, 12);
    const { token: verificationToken, expires: verificationExpires } = newVerificationToken();

    const result = await pool.query(
      `INSERT INTO users (name, email, password, document_id, phone, email_verification_token, email_verification_expires, is_email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false)
       RETURNING id, name, email`,
      [name, email, hashed, document_id, phone, verificationToken, verificationExpires]
    );

    // La cuenta queda creada aunque el correo falle; se puede reenviar después
    sendInBackground(`verificación a ${email}`, () => sendVerificationEmail(email, name, verificationToken));

    return res.status(201).json({
      message: 'Cuenta creada. Revisa tu correo para verificar tu cuenta.',
      user: result.rows[0],
    });
  } catch (err) {
    console.error('ERROR REGISTER:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// ────────────────────────────────────────────────
// VERIFY EMAIL
// ────────────────────────────────────────────────
const verifyEmail = async (req, res) => {
  const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:8080';
  try {
    const { token } = req.params;

    const result = await pool.query(
      `SELECT id, name, email FROM users
       WHERE email_verification_token = $1
         AND email_verification_expires > NOW()
         AND is_email_verified = false`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.redirect(`${appBaseUrl}/#/verify-email?success=false`);
    }

    await pool.query(
      `UPDATE users
       SET is_email_verified = true,
           email_verification_token = NULL,
           email_verification_expires = NULL
       WHERE id = $1`,
      [result.rows[0].id]
    );

    const u = result.rows[0];
    sendInBackground(`bienvenida a ${u.email}`, () => sendWelcomeEmail(u.email, u.name));

    return res.redirect(`${appBaseUrl}/#/verify-email?success=true`);
  } catch (err) {
    console.error('ERROR VERIFY EMAIL:', err);
    return res.redirect(`${appBaseUrl}/#/verify-email?success=false`);
  }
};

// ────────────────────────────────────────────────
// RESEND VERIFICATION  (nuevo)
// POST /api/auth/resend-verification   body: { email }
// ────────────────────────────────────────────────
const resendVerification = async (req, res) => {
  const genericMsg = 'Si la cuenta existe y no está verificada, te enviamos un nuevo correo de verificación.';
  try {
    const email = normalizeEmail(req.body.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    }

    const result = await pool.query(
      'SELECT id, name, is_email_verified FROM users WHERE LOWER(email) = $1',
      [email]
    );

    // Misma respuesta exista o no, para no revelar qué correos están registrados
    if (result.rows.length === 0 || result.rows[0].is_email_verified) {
      return res.json({ message: genericMsg });
    }

    const user = result.rows[0];
    const { token, expires } = newVerificationToken();
    await pool.query(
      `UPDATE users
         SET email_verification_token = $1,
             email_verification_expires = $2
       WHERE id = $3`,
      [token, expires, user.id]
    );

    sendInBackground(`verificación (reenvío) a ${email}`, () => sendVerificationEmail(email, user.name, token));
    return res.json({ message: genericMsg });
  } catch (err) {
    console.error('ERROR RESEND VERIFICATION:', err);
    return res.status(500).json({ error: 'Error al procesar la solicitud' });
  }
};

// ────────────────────────────────────────────────
// LOGIN
// ────────────────────────────────────────────────
const login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Correo y contraseña son requeridos' });
    }

    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const user = result.rows[0];

    // Cuenta de Google (sin password)
    if (!user.password) {
      return res.status(400).json({ error: 'Esta cuenta usa Google. Inicia sesión con Google.' });
    }

    // Primero la contraseña: así no se revela si una cuenta existe sin verificar
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    if (!user.is_email_verified) {
      return res.status(403).json({
        error: 'Debes verificar tu correo antes de iniciar sesión. Revisa tu bandeja de entrada.',
      });
    }

    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    const token = generateToken(user.id);

    return res.json({
      message: 'Inicio de sesión exitoso',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar_url,
      },
    });
  } catch (err) {
    console.error('ERROR LOGIN:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// ────────────────────────────────────────────────
// GOOGLE LOGIN / REGISTER
// ────────────────────────────────────────────────
const googleAuth = async (req, res) => {
  try {
    const { idToken, isWeb } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'Token de Google requerido' });
    }

    let email, name, picture, googleId;

    if (isWeb) {
      // En web viene accessToken — lo verificamos con la API de Google
      const response = await fetch(
        'https://www.googleapis.com/oauth2/v3/userinfo',
        { headers: { Authorization: `Bearer ${idToken}` }, signal: AbortSignal.timeout(8000) }
      );
      const googleUser = await response.json();

      if (!googleUser.email) {
        return res.status(401).json({ error: 'Token de Google inválido' });
      }

      email = googleUser.email;
      name = googleUser.name;
      picture = googleUser.picture;
      googleId = googleUser.sub;
    } else {
      // En móvil viene idToken — lo verificamos con google-auth-library
      const googleUser = await verifyGoogleToken(idToken);

      if (!googleUser) {
        return res.status(401).json({ error: 'Token de Google inválido' });
      }

      email = googleUser.email;
      name = googleUser.name;
      picture = googleUser.picture;
      googleId = googleUser.sub;
    }

    email = normalizeEmail(email);

    let result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [email]);

    if (result.rows.length === 0) {
      result = await pool.query(
        `INSERT INTO users (name, email, google_id, avatar_url, is_email_verified)
         VALUES ($1, $2, $3, $4, true)
         RETURNING *`,
        [name, email, googleId, picture]
      );
    } else if (!result.rows[0].google_id) {
      // Google ya confirmó el correo, así que la cuenta queda verificada
      await pool.query(
        `UPDATE users
           SET google_id = $1, avatar_url = $2, last_login = NOW(),
               is_email_verified = true,
               email_verification_token = NULL,
               email_verification_expires = NULL
         WHERE id = $3`,
        [googleId, picture, result.rows[0].id]
      );
    } else {
      await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [result.rows[0].id]);
    }

    const user = result.rows[0];
    const token = generateToken(user.id);

    return res.json({
      message: 'Autenticación con Google exitosa',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: picture,
      },
    });
  } catch (err) {
    console.error('ERROR GOOGLE AUTH:', err);
    return res.status(500).json({ error: 'Error al autenticar con Google' });
  }
};

// ────────────────────────────────────────────────
// FORGOT PASSWORD
// ────────────────────────────────────────────────
const forgotPassword = async (req, res) => {
  const genericMsg = 'Si el correo existe, recibirás un enlace de recuperación.';
  try {
    const email = normalizeEmail(req.body.email);

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    }

    const result = await pool.query('SELECT id, name FROM users WHERE LOWER(email) = $1', [email]);

    // Siempre responder igual para no revelar si el correo existe
    if (result.rows.length === 0) {
      return res.json({ message: genericMsg });
    }

    const user = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
      [resetToken, resetExpires, user.id]
    );

    // Responde de inmediato; el fallo (si lo hay) queda en el log del servidor
    sendInBackground(`recuperación a ${email}`, () => sendPasswordResetEmail(email, user.name, resetToken));

    return res.json({ message: genericMsg });
  } catch (err) {
    console.error('ERROR FORGOT PASSWORD:', err);
    return res.status(500).json({ error: 'Error al procesar la solicitud' });
  }
};

// ────────────────────────────────────────────────
// RESET PASSWORD
// ────────────────────────────────────────────────
const resetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token y nueva contraseña son requeridos' });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        error: 'La contraseña debe tener mínimo 8 caracteres, una mayúscula y un número',
      });
    }

    const result = await pool.query(
      'SELECT id, name, email FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Token inválido o expirado' });
    }

    const hashed = await bcrypt.hash(newPassword, 12);

    // Si pudo recibir el enlace en su correo, ese correo queda verificado
    await pool.query(
      `UPDATE users
         SET password = $1,
             reset_token = NULL,
             reset_token_expires = NULL,
             is_email_verified = true,
             email_verification_token = NULL,
             email_verification_expires = NULL
       WHERE id = $2`,
      [hashed, result.rows[0].id]
    );

    const u = result.rows[0];
    sendInBackground(`aviso de cambio de contraseña a ${u.email}`, () => sendPasswordChangedEmail(u.email, u.name));

    return res.json({ message: 'Contraseña actualizada exitosamente' });
  } catch (err) {
    console.error('ERROR RESET PASSWORD:', err);
    return res.status(500).json({ error: 'Error al actualizar contraseña' });
  }
};

// ────────────────────────────────────────────────
// VERIFY CAPTCHA (Google reCAPTCHA)
// ────────────────────────────────────────────────
const verifyCaptcha = async (token) => {
  // La app Android no puede mostrar reCAPTCHA web y envía este token fijo.
  // Solo se acepta si el servidor lo permite explícitamente (pruebas del APK).
  if (token === 'mobile_bypass_dev') {
    const allowed = process.env.ALLOW_MOBILE_CAPTCHA_BYPASS === 'true';
    if (!allowed) console.warn('[captcha] Registro desde la app móvil rechazado: falta ALLOW_MOBILE_CAPTCHA_BYPASS=true');
    return allowed;
  }
  try {
    const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: process.env.RECAPTCHA_SECRET || '',
        response: token,
      }),
      signal: AbortSignal.timeout(8000), // no dejar colgado el registro si Google no responde
    });
    const data = await response.json();
    if (data.success !== true) console.error('[captcha] Google rechazó el captcha:', data['error-codes'] || data);
    return data.success === true;
  } catch (err) {
    console.error('[captcha] No se pudo verificar con Google:', err.name, err.message);
    return false;
  }
};

module.exports = {
  register,
  verifyEmail,
  resendVerification,
  login,
  googleAuth,
  forgotPassword,
  resetPassword,
};
