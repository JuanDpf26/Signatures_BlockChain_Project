const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',  // Puedes cambiar a SendGrid, Resend, etc.
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // App password de Gmail (no tu contraseña normal)
  },
});

const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';

// ────────────────────────────────────────────────
// VERIFICACIÓN DE EMAIL
// ────────────────────────────────────────────────
const sendVerificationEmail = async (email, name, token) => {
  const link = `${baseUrl}/api/auth/verify-email/${token}`;

  await transporter.sendMail({
    from: `"BlockSign" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Verifica tu cuenta en BlockSign',
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family: 'Segoe UI', sans-serif; background: #0f0f1a; color: #fff; margin: 0; padding: 20px;">
        <div style="max-width: 560px; margin: 0 auto; background: #1a1a2e; border-radius: 16px; padding: 40px; border: 1px solid #2a2a4a;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #6366f1; font-size: 28px; margin: 0; letter-spacing: -1px;">🔐 BlockSign</h1>
            <p style="color: #9ca3af; margin-top: 8px; font-size: 14px;">Sistema de Firma Digital con Blockchain</p>
          </div>
          
          <h2 style="color: #e5e7eb; font-size: 22px; margin-bottom: 12px;">Hola, ${name} 👋</h2>
          <p style="color: #9ca3af; line-height: 1.6; margin-bottom: 24px;">
            Gracias por registrarte en BlockSign. Para activar tu cuenta y comenzar a firmar documentos de forma segura, verifica tu correo electrónico.
          </p>
          
          <div style="text-align: center; margin: 32px 0;">
            <a href="${link}" style="background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; padding: 16px 40px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 16px; display: inline-block;">
              Verificar mi cuenta
            </a>
          </div>
          
          <p style="color: #6b7280; font-size: 13px; line-height: 1.6;">
            Este enlace expira en <strong style="color: #9ca3af;">24 horas</strong>. Si no creaste esta cuenta, puedes ignorar este mensaje.
          </p>
          
          <hr style="border: none; border-top: 1px solid #2a2a4a; margin: 24px 0;">
          <p style="color: #4b5563; font-size: 12px; text-align: center;">
            BlockSign · Universidad Manuela Beltrán · Ingeniería de Software 2025
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
  const link = `${process.env.FLUTTER_DEEP_LINK || 'blocksign://reset-password'}?token=${token}`;
  // Para web: `${baseUrl}/reset-password?token=${token}`

  await transporter.sendMail({
    from: `"BlockSign" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Recupera tu contraseña de BlockSign',
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family: 'Segoe UI', sans-serif; background: #0f0f1a; color: #fff; margin: 0; padding: 20px;">
        <div style="max-width: 560px; margin: 0 auto; background: #1a1a2e; border-radius: 16px; padding: 40px; border: 1px solid #2a2a4a;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #6366f1; font-size: 28px; margin: 0; letter-spacing: -1px;">🔐 BlockSign</h1>
          </div>
          
          <h2 style="color: #e5e7eb; font-size: 22px; margin-bottom: 12px;">Recuperar contraseña</h2>
          <p style="color: #9ca3af; line-height: 1.6; margin-bottom: 24px;">
            Hola <strong style="color: #e5e7eb;">${name}</strong>, recibimos una solicitud para restablecer tu contraseña.
          </p>
          
          <div style="text-align: center; margin: 32px 0;">
            <a href="${link}" style="background: linear-gradient(135deg, #f59e0b, #ef4444); color: white; padding: 16px 40px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 16px; display: inline-block;">
              Restablecer contraseña
            </a>
          </div>
          
          <div style="background: #111827; border-radius: 8px; padding: 16px; margin-top: 16px;">
            <p style="color: #6b7280; font-size: 13px; margin: 0; line-height: 1.6;">
              ⚠️ Este enlace <strong style="color: #9ca3af;">expira en 1 hora</strong>. Si no solicitaste este cambio, ignora este correo. Tu contraseña actual permanece segura.
            </p>
          </div>
          
          <hr style="border: none; border-top: 1px solid #2a2a4a; margin: 24px 0;">
          <p style="color: #4b5563; font-size: 12px; text-align: center;">
            BlockSign · Universidad Manuela Beltrán · Ingeniería de Software 2025
          </p>
        </div>
      </body>
      </html>
    `,
  });
};

module.exports = { sendVerificationEmail, sendPasswordResetEmail };