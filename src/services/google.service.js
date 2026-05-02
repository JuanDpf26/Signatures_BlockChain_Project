const { OAuth2Client } = require('google-auth-library');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Verifica un idToken de Google y retorna el payload del usuario.
 * Retorna null si el token es inválido.
 */
const verifyGoogleToken = async (idToken) => {
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    if (!payload || !payload.email_verified) {
      return null;
    }

    return payload; // { email, name, picture, sub, email_verified }
  } catch (err) {
    console.error('ERROR verificando token Google:', err.message);
    return null;
  }
};

module.exports = { verifyGoogleToken };