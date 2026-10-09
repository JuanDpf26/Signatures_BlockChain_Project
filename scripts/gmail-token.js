#!/usr/bin/env node
/**
 * Genera el GMAIL_REFRESH_TOKEN para enviar correos con la API de Gmail.
 *
 * Antes:
 *  1. Google Cloud → APIs y servicios → Biblioteca → activa "Gmail API".
 *  2. Credenciales → Crear credenciales → ID de cliente de OAuth → tipo
 *     "App de escritorio". Copia el ID y el secreto en tu .env como
 *     GMAIL_CLIENT_ID y GMAIL_CLIENT_SECRET.
 *  3. Pantalla de consentimiento → Público → "Publicar app" (En producción).
 *     Si queda "En prueba", el token vence a los 7 días.
 *
 * Uso (en tu PC, desde la carpeta del backend):
 *   node scripts/gmail-token.js
 * Abre el enlace que aparece, entra con el Gmail que enviará los correos
 * (el mismo de EMAIL_USER), acepta y copia el token que se imprime.
 */
require('dotenv').config({ quiet: true });
const http = require('http');
const { OAuth2Client } = require('google-auth-library');

const id = (process.env.GMAIL_CLIENT_ID || '').trim();
const secret = (process.env.GMAIL_CLIENT_SECRET || '').trim();
if (!id || !secret) {
  console.error('\n✖ Faltan GMAIL_CLIENT_ID y GMAIL_CLIENT_SECRET en el .env (cliente OAuth tipo "App de escritorio").\n');
  process.exit(1);
}

const PORT = 53682;
const redirect = `http://localhost:${PORT}`;
const client = new OAuth2Client(id, secret, redirect);
const url = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // obliga a entregar el refresh token
  scope: ['https://www.googleapis.com/auth/gmail.send'],
});

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get('code');
  if (!code) { res.end('Esperando la autorización…'); return; }
  try {
    const { tokens } = await client.getToken(code);
    res.end('Listo. Ya puedes cerrar esta pestaña y volver a la terminal.');
    if (!tokens.refresh_token) {
      console.error('\n✖ Google no entregó refresh token. Quita el acceso en https://myaccount.google.com/permissions y repite.\n');
    } else {
      console.log('\n✔ Copia esto en Render (Environment) y en tu .env:\n');
      console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    }
  } catch (e) {
    res.end('Error: ' + e.message);
    console.error('\n✖ ' + e.message + '\n');
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('\n1) Abre este enlace en el navegador y autoriza con tu Gmail:\n');
  console.log(url + '\n');
  console.log('2) Al terminar, el token aparece aquí.\n');
});
