const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/db');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/email.service');
const { verifyGoogleToken } = require('../services/google.service');

// ────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────
const generateToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '7d' });

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const isStrongPassword = (password) =>
  password.length >= 8 &&
  /[A-Z]/.test(password) &&
  /[0-9]/.test(password);

// ────────────────────────────────────────────────
// REGISTER
// ────────────────────────────────────────────────
const register = async (req, res) => {
  try {
    const { name, email, password, document_id, phone, captchaToken } = req.body;

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

    // CAPTCHA desactivado en desarrollo
// TODO: reactivar en producción
if (process.env.NODE_ENV === 'production') {
  if (!captchaToken) {
    return res.status(400).json({ error: 'Debes completar el captcha' });
  }
  const captchaValid = await verifyCaptcha(captchaToken);
  if (!captchaValid) {
    return res.status(400).json({ error: 'Captcha inválido, intenta de nuevo' });
  }
}

    // Verificar si el correo ya existe
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Ya existe una cuenta con este correo' });
    }

    // Verificar documento duplicado
    const existingDoc = await pool.query('SELECT id FROM users WHERE document_id = $1', [document_id]);
    if (existingDoc.rows.length > 0) {
      return res.status(409).json({ error: 'Ya existe una cuenta con este documento' });
    }

    const hashed = await bcrypt.hash(password, 12);

    // Token de verificación de email
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const result = await pool.query(
      `INSERT INTO users (name, email, password, document_id, phone, email_verification_token, email_verification_expires, is_email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false)
       RETURNING id, name, email`,
      [name, email, hashed, document_id, phone, verificationToken, verificationExpires]
    );

    // Enviar correo de verificación
    await sendVerificationEmail(email, name, verificationToken);

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
  try {
    const { token } = req.params;

    const result = await pool.query(
      `SELECT id FROM users
       WHERE email_verification_token = $1
         AND email_verification_expires > NOW()
         AND is_email_verified = false`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Token inválido o expirado' });
    }

    await pool.query(
      `UPDATE users
       SET is_email_verified = true,
           email_verification_token = NULL,
           email_verification_expires = NULL
       WHERE id = $1`,
      [result.rows[0].id]
    );

    return res.json({ message: 'Correo verificado exitosamente. Ya puedes iniciar sesión.' });
  } catch (err) {
    console.error('ERROR VERIFY EMAIL:', err);
    return res.status(500).json({ error: 'Error al verificar correo' });
  }
};

// ────────────────────────────────────────────────
// LOGIN
// ────────────────────────────────────────────────
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Correo y contraseña son requeridos' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const user = result.rows[0];

    // Verificar si es cuenta de Google (sin password)
    if (!user.password) {
      return res.status(400).json({ error: 'Esta cuenta usa Google. Inicia sesión con Google.' });
    }

    if (!user.is_email_verified) {
      return res.status(403).json({
        error: 'Debes verificar tu correo antes de iniciar sesión. Revisa tu bandeja de entrada.',
      });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    // Actualizar último login
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
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'Token de Google requerido' });
    }

    const googleUser = await verifyGoogleToken(idToken);

    if (!googleUser) {
      return res.status(401).json({ error: 'Token de Google inválido' });
    }

    const { email, name, picture, sub: googleId } = googleUser;

    // Buscar usuario existente
    let result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      // Crear cuenta nueva con Google
      result = await pool.query(
        `INSERT INTO users (name, email, google_id, avatar_url, is_email_verified)
         VALUES ($1, $2, $3, $4, true)
         RETURNING *`,
        [name, email, googleId, picture]
      );
    } else {
      // Actualizar google_id si no lo tenía
      if (!result.rows[0].google_id) {
        await pool.query(
          'UPDATE users SET google_id = $1, avatar_url = $2, last_login = NOW() WHERE id = $3',
          [googleId, picture, result.rows[0].id]
        );
      }
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
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    }

    const result = await pool.query('SELECT id, name FROM users WHERE email = $1', [email]);

    // Siempre responder igual para no revelar si el correo existe
    if (result.rows.length === 0) {
      return res.json({ message: 'Si el correo existe, recibirás un enlace de recuperación.' });
    }

    const user = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
      [resetToken, resetExpires, user.id]
    );

    await sendPasswordResetEmail(email, user.name, resetToken);

    return res.json({ message: 'Si el correo existe, recibirás un enlace de recuperación.' });
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
      'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Token inválido o expirado' });
    }

    const hashed = await bcrypt.hash(newPassword, 12);

    await pool.query(
      'UPDATE users SET password = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
      [hashed, result.rows[0].id]
    );

    return res.json({ message: 'Contraseña actualizada exitosamente' });
  } catch (err) {
    console.error('ERROR RESET PASSWORD:', err);
    return res.status(500).json({ error: 'Error al actualizar contraseña' });
  }
};

// ────────────────────────────────────────────────
// VERIFY CAPTCHA (hCaptcha)
// ────────────────────────────────────────────────
const verifyCaptcha = async (token) => {
  try {
    const response = await fetch(
      `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET}&response=${token}`,
      { method: 'POST' }
    );
    const data = await response.json();
    return data.success === true;
  } catch {
    return false;
  }
};

module.exports = { register, verifyEmail, login, googleAuth, forgotPassword, resetPassword };