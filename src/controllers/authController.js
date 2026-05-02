const bcrypt = require('bcrypt');
const pool = require('../config/db');

// REGISTRO
const register = async (req, res) => {
  try {
    console.log("BODY:", req.body);

    const { name, email, password, document_id, phone } = req.body;

    if (!name || !email || !password || !document_id || !phone) {
      return res.status(400).json({
        error: "Faltan datos",
        received: req.body
      });
    }

    const hashed = await bcrypt.hash(password, 10);

    await pool.query(
      `INSERT INTO users (name, email, password, document_id, phone)
       VALUES ($1,$2,$3,$4,$5)`,
      [name, email, hashed, document_id, phone]
    );

    return res.json({ message: "Usuario creado" });

  } catch (err) {
    console.error("ERROR REGISTER:", err);
    return res.status(500).json({
      error: "Error en registro",
      detail: err.message
    });
  }
};

// LOGIN (básico por ahora)
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (user.rows.length === 0) {
      return res.status(400).json({ error: "Usuario no existe" });
    }

    const validPassword = await bcrypt.compare(
      password,
      user.rows[0].password
    );

    if (!validPassword) {
      return res.status(400).json({ error: "Contraseña incorrecta" });
    }

    res.json({
      message: "Login exitoso",
      user: {
        id: user.rows[0].id,
        name: user.rows[0].name,
        email: user.rows[0].email
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error en login" });
  }
};

module.exports = {
  register,
  login
};