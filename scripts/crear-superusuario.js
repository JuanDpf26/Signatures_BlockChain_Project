// Crea una cuenta de SUPERUSUARIO (administración de DocBlockSign).
//
//   npm run superusuario            → crea una cuenta nueva de administración
//   npm run superusuario -- --listar → muestra quiénes son superusuarios
//   npm run superusuario -- --quitar correo@dominio.com → la vuelve cuenta normal
//
// Los superusuarios son cuentas aparte de los usuarios finales: solo entran a la
// consola de administración y no suben, firman ni comparten documentos.
// No existe forma de crear uno desde la app; solo con este script (o SQL),
// con acceso al .env del backend.
//
// La contraseña se escribe aquí, en la terminal; nunca la pegues en un chat.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const readline = require('readline');
const bcrypt = require('bcrypt');
const pool = require('../src/config/db');
const { initAccount } = require('../src/services/account.service');

const args = process.argv.slice(2);

const ask = (q, { hidden = false } = {}) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(q)) rl.output.write(s);
        else if (s === '\r\n' || s === '\n' || s === '\r') rl.output.write(s);
        else rl.output.write('*'.repeat(s.length));
      };
    }
    rl.question(q, (a) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(a.trim());
    });
  });

const strong = (p) => p.length >= 10 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p);

const listar = async () => {
  const r = await pool.query(`SELECT name, email, suspended, last_login FROM users WHERE role = 'admin' ORDER BY email`);
  if (!r.rows.length) return console.log('No hay superusuarios todavía.');
  console.log('Superusuarios:');
  for (const u of r.rows) console.log(` - ${u.name} <${u.email}>${u.suspended ? ' (suspendido)' : ''}`);
};

const quitar = async (email) => {
  const r = await pool.query(`UPDATE users SET role = 'user' WHERE LOWER(email) = LOWER($1) AND role = 'admin' RETURNING email`, [email]);
  console.log(r.rowCount ? `✔ ${r.rows[0].email} ya no es superusuario.` : 'Ese correo no es superusuario.');
};

const crear = async () => {
  console.log('── Nuevo superusuario de DocBlockSign ──\n');
  const name = await ask('Nombre completo: ');
  const email = (await ask('Correo: ')).toLowerCase();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Nombre o correo no válido.');

  const ex = await pool.query(
    `SELECT u.id, u.role, (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id)::int AS docs
       FROM users u WHERE LOWER(u.email) = $1`,
    [email]
  );
  if (ex.rows.length) {
    const u = ex.rows[0];
    if (u.role === 'admin') return console.log('Ese correo ya es superusuario.');
    throw new Error(
      `Ese correo ya es una cuenta de usuario${u.docs ? ` con ${u.docs} documentos` : ''}. ` +
        'Los superusuarios van aparte: usa otro correo (por ejemplo admin.tunombre@...).'
    );
  }

  const p1 = await ask('Contraseña (mín. 10, con mayúscula, minúscula y número): ', { hidden: true });
  if (!strong(p1)) throw new Error('La contraseña no cumple los requisitos.');
  const p2 = await ask('Repite la contraseña: ', { hidden: true });
  if (p1 !== p2) throw new Error('Las contraseñas no coinciden.');

  const hashed = await bcrypt.hash(p1, 12);
  await pool.query(
    `INSERT INTO users (name, email, password, is_email_verified, role, email_reminders)
     VALUES ($1, $2, $3, TRUE, 'admin', FALSE)`,
    [name, email, hashed]
  );
  console.log(`\n✔ Superusuario creado: ${name} <${email}>`);
  console.log('  Ingresa en la app con ese correo y contraseña; abrirá la consola de administración.');
};

(async () => {
  try {
    await initAccount(); // asegura las columnas role/suspended
    if (args[0] === '--listar') await listar();
    else if (args[0] === '--quitar') await quitar(args[1] || '');
    else await crear();
  } catch (e) {
    console.error('✖', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
