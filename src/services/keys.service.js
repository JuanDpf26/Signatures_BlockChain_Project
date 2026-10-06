// ────────────────────────────────────────────────
// CLAVES ASIMÉTRICAS POR USUARIO (ECDSA P-256)
//
// Cada usuario tiene un par de claves:
//  - La clave pública se guarda en claro y cualquiera puede usarla para
//    comprobar sus firmas.
//  - La clave privada se guarda CIFRADA con AES-256-GCM. La clave de cifrado
//    sale de KEY_ENCRYPTION_SECRET (.env) y nunca se guarda en la base de datos.
//
// Al firmar, el servidor descifra la clave privada en memoria, firma la huella
// del documento y la descarta. La firma (y no solo un hash) queda en la base de
// datos, y el hash de esa firma es el que se registra en blockchain.
// ────────────────────────────────────────────────
const crypto = require('crypto');
const pool = require('../config/db');

const ALGORITHM = 'ECDSA-P256-SHA256';
let ready = false;
let kek = null; // key encryption key (32 bytes)

const getKek = () => {
  if (kek) return kek;
  const secret = process.env.KEY_ENCRYPTION_SECRET;
  if (secret) {
    kek = crypto.createHash('sha256').update(secret).digest();
  } else {
    // Solo para desarrollo: se deriva del JWT_SECRET para no romper el arranque
    console.warn('⚠️ [Claves] Falta KEY_ENCRYPTION_SECRET en el .env; se usa una clave derivada (solo desarrollo).');
    kek = crypto.scryptSync(process.env.JWT_SECRET || 'blocksign-dev', 'blocksign-user-keys', 32);
  }
  return kek;
};

const initKeys = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_keys (
        user_id          TEXT PRIMARY KEY,
        algorithm        TEXT NOT NULL,
        public_key_pem   TEXT NOT NULL,
        private_key_enc  TEXT NOT NULL,   -- iv:tag:cifrado (base64), AES-256-GCM
        fingerprint      TEXT NOT NULL,   -- SHA-256 de la clave pública (DER)
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    getKek();
    ready = true;
    console.log('🔑 [Claves] Tabla user_keys lista');
  } catch (err) {
    console.error('❌ [Claves] No se pudo crear la tabla user_keys:', err.message);
  }
};

const encrypt = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKek(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
};

const decrypt = (packed) => {
  const [iv, tag, enc] = packed.split(':').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKek(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
};

const fingerprintOf = (publicPem) => {
  const der = crypto.createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
};

/** Devuelve la clave pública del usuario; si no tiene, genera su par de claves. */
const getOrCreateUserKeys = async (userId) => {
  if (!ready) throw new Error('El módulo de claves no está listo');
  const found = await pool.query('SELECT algorithm, public_key_pem, fingerprint, created_at FROM user_keys WHERE user_id = $1', [String(userId)]);
  if (found.rows.length) return { ...found.rows[0], created: false };

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1', // P-256
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const fingerprint = fingerprintOf(publicKey);
  const ins = await pool.query(
    `INSERT INTO user_keys (user_id, algorithm, public_key_pem, private_key_enc, fingerprint)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING algorithm, public_key_pem, fingerprint, created_at`,
    [String(userId), ALGORITHM, publicKey, encrypt(privateKey), fingerprint]
  );
  if (!ins.rows.length) return getOrCreateUserKeys(userId); // otra petición la creó primero
  console.log(`🔑 [Claves] Par de claves generado para el usuario ${userId}`);
  return { ...ins.rows[0], created: true };
};

/** Texto exacto que se firma (incluye la huella del archivo, el firmante y la fecha) */
const buildPayload = ({ documentHash, signerEmail, signedAt }) =>
  `BlockSign|v1|doc:${String(documentHash).toLowerCase()}|signer:${String(signerEmail).toLowerCase()}|at:${signedAt}`;

/** Firma el payload con la clave privada del usuario. Devuelve la firma (DER, base64). */
const signWithUserKey = async (userId, payload) => {
  const r = await pool.query('SELECT private_key_enc FROM user_keys WHERE user_id = $1', [String(userId)]);
  if (!r.rows.length) throw new Error('El usuario no tiene claves');
  const privatePem = decrypt(r.rows[0].private_key_enc);
  const signature = crypto.sign('sha256', Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privatePem));
  return signature.toString('base64');
};

/** Comprueba una firma con la clave pública */
const verifySignature = (publicPem, payload, signatureB64) => {
  try {
    return crypto.verify('sha256', Buffer.from(payload, 'utf8'), crypto.createPublicKey(publicPem), Buffer.from(signatureB64, 'base64'));
  } catch (_) {
    return false;
  }
};

/** Hash SHA-256 de la firma: es lo que se registra en el contrato */
const signatureDigest = (signatureB64) => crypto.createHash('sha256').update(Buffer.from(signatureB64, 'base64')).digest('hex');

const getPublicKey = async (userId) => {
  const r = await pool.query('SELECT algorithm, public_key_pem, fingerprint, created_at FROM user_keys WHERE user_id = $1', [String(userId)]);
  return r.rows[0] || null;
};

module.exports = {
  ALGORITHM,
  initKeys,
  getOrCreateUserKeys,
  buildPayload,
  signWithUserKey,
  verifySignature,
  signatureDigest,
  getPublicKey,
  fingerprintOf,
};
