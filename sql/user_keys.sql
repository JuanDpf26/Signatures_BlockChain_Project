-- Claves asimétricas por usuario (ECDSA P-256). El servidor la crea solo al arrancar.
CREATE TABLE IF NOT EXISTS user_keys (
  user_id          TEXT PRIMARY KEY,
  algorithm        TEXT NOT NULL,          -- ECDSA-P256-SHA256
  public_key_pem   TEXT NOT NULL,          -- clave pública (SPKI, PEM)
  private_key_enc  TEXT NOT NULL,          -- clave privada cifrada: iv:tag:cifrado (AES-256-GCM, base64)
  fingerprint      TEXT NOT NULL,          -- SHA-256 de la clave pública (DER)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
