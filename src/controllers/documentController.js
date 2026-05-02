const pool = require('../config/db');
const crypto = require('crypto');

exports.uploadDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file" });
    }

    const file = req.file;

    // 🔐 HASH
    const hash = crypto
      .createHash('sha256')
      .update(file.buffer)
      .digest('hex');

    // 💾 guardar TODO en PostgreSQL
    await pool.query(
      `INSERT INTO documents (user_id, file_data, hash)
       VALUES ($1, $2, $3)`,
      [req.user.id, file.buffer, hash]
    );

    res.json({
      message: "Documento guardado en PostgreSQL",
      hash
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};