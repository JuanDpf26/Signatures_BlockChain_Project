const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// prueba de conexión (puedes quitarla luego)
pool.connect()
  .then(() => console.log("✅ Conectado a Supabase PostgreSQL"))
  .catch(err => console.error("❌ Error de conexión:", err));

module.exports = pool;