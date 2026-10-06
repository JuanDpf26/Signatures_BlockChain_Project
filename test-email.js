// Diagnóstico del correo. Ejecutar desde la raíz del backend:
//   node test-email.js tu-correo@gmail.com
require('dotenv').config(); // SIEMPRE antes de importar el servicio

const pass = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');
console.log('──────── Configuración ────────');
console.log('EMAIL_USER           :', process.env.EMAIL_USER || 'NO definida');
console.log('EMAIL_PASS           :', pass ? `definida (${pass.length} caracteres, deben ser 16)` : 'NO definida');
console.log('APP_BASE_URL         :', process.env.APP_BASE_URL || 'NO definida (usa http://localhost:8080)');
console.log('APP_BASE_URL_BACKEND :', process.env.APP_BASE_URL_BACKEND || 'NO definida (usa http://localhost:3000)');
console.log('───────────────────────────────\n');

// Busca el servicio en las carpetas más comunes del proyecto
const candidates = ['./services/email.service', './src/services/email.service', './app/services/email.service'];
let service = null;
for (const c of candidates) {
  try {
    service = require(c);
    console.log(`Usando ${c}.js\n`);
    break;
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes(c.replace('./', ''))) throw e;
  }
}
if (!service) {
  console.error('❌ No encontré email.service.js. Búscalo con:');
  console.error('   Get-ChildItem -Recurse -Filter email.service.js | Where-Object { $_.FullName -notmatch "node_modules" }');
  process.exit(1);
}
const { verifyEmailTransport, sendVerificationEmail, sendPasswordResetEmail } = service;

(async () => {
  const to = process.argv[2];
  if (!to) {
    console.error('Uso: node test-email.js destino@correo.com');
    process.exit(1);
  }

  console.log('1) Probando conexión con Gmail…');
  const ok = await verifyEmailTransport();
  if (!ok) {
    console.error('\n❌ No hay conexión con Gmail. Lee el mensaje que empieza con "→" arriba.');
    process.exit(1);
  }

  try {
    console.log('\n2) Enviando correo de verificación…');
    await sendVerificationEmail(to, 'Prueba', 'token-de-prueba-verificacion');
    console.log('\n3) Enviando correo de recuperación…');
    await sendPasswordResetEmail(to, 'Prueba', 'token-de-prueba-recuperacion');
    console.log(`\n✅ Listo. Revisa la bandeja de entrada y SPAM de ${to}.`);
  } catch (err) {
    console.error('\n❌ Falló el envío:', err.message);
    process.exit(1);
  }
})();
