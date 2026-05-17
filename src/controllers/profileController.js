const pool = require('../config/db');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ────────────────────────────────────────────────
// GET PERFIL
// ────────────────────────────────────────────────
const getProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT id, name, email, document_id, phone, avatar_url,
              google_id, is_email_verified, last_login, created_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Stats del usuario
    const stats = await pool.query(
      `SELECT
        COUNT(*) as total_docs,
        COUNT(*) FILTER (WHERE status = 'signed') as signed_docs,
        COUNT(*) FILTER (WHERE status = 'verified') as verified_docs,
        COALESCE(SUM((metadata->>'size_bytes')::bigint), 0) as total_size
       FROM documents WHERE user_id = $1`,
      [userId]
    );

    const user = result.rows[0];
    const s = stats.rows[0];

    return res.json({
      user: {
        ...user,
        stats: {
          total_docs: parseInt(s.total_docs),
          signed_docs: parseInt(s.signed_docs),
          verified_docs: parseInt(s.verified_docs),
          total_size_mb: (parseInt(s.total_size) / (1024 * 1024)).toFixed(2),
        },
      },
    });
  } catch (err) {
    console.error('ERROR GET PROFILE:', err);
    return res.status(500).json({ error: 'Error al obtener perfil' });
  }
};

// ────────────────────────────────────────────────
// UPDATE PERFIL
// ────────────────────────────────────────────────
const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, phone } = req.body;

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'El nombre debe tener mínimo 2 caracteres' });
    }

    if (phone && !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'El teléfono debe tener 10 dígitos' });
    }

    const result = await pool.query(
      `UPDATE users
       SET name = $1, phone = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, name, email, document_id, phone, avatar_url`,
      [name.trim(), phone || null, userId]
    );

    return res.json({
      message: 'Perfil actualizado exitosamente',
      user: result.rows[0],
    });
  } catch (err) {
    console.error('ERROR UPDATE PROFILE:', err);
    return res.status(500).json({ error: 'Error al actualizar perfil' });
  }
};

// ────────────────────────────────────────────────
// UPLOAD AVATAR
// ────────────────────────────────────────────────
const uploadAvatar = async (req, res) => {
  try {
    const userId = req.user.id;

    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió imagen' });
    }

    const { buffer, mimetype } = req.file;

    // Validar tipo
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(mimetype)) {
      return res.status(400).json({ error: 'Solo se permiten imágenes JPG, PNG o WebP' });
    }

    // Redimensionar y optimizar con sharp (200x200px, calidad 85)
    const optimized = await sharp(buffer)
      .resize(200, 200, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 85 })
      .toBuffer();

    const fileName = `avatars/${userId}/avatar.jpg`;

    // Eliminar avatar anterior si existe
    await supabase.storage.from('avatars').remove([fileName]);

    // Subir nuevo avatar
    const { error: storageError } = await supabase.storage
      .from('avatars')
      .upload(fileName, optimized, {
        contentType: 'image/jpeg',
        upsert: true,
      });

    if (storageError) {
      console.error('AVATAR STORAGE ERROR:', storageError);
      return res.status(500).json({ error: 'Error al subir imagen' });
    }

    const { data: urlData } = supabase.storage
      .from('avatars')
      .getPublicUrl(fileName);

    // Agregar timestamp para evitar caché
    const avatarUrl = `${urlData.publicUrl}?t=${Date.now()}`;

    await pool.query(
      'UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2',
      [avatarUrl, userId]
    );

    return res.json({
      message: 'Foto de perfil actualizada',
      avatar_url: avatarUrl,
    });
  } catch (err) {
    console.error('ERROR UPLOAD AVATAR:', err);
    return res.status(500).json({ error: 'Error al actualizar foto' });
  }
};

// ────────────────────────────────────────────────
// CHANGE PASSWORD
// ────────────────────────────────────────────────
const changePassword = async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    if (newPassword.length < 8 ||
        !/[A-Z]/.test(newPassword) ||
        !/[0-9]/.test(newPassword)) {
      return res.status(400).json({
        error: 'La nueva contraseña debe tener mínimo 8 caracteres, una mayúscula y un número',
      });
    }

    const result = await pool.query(
      'SELECT password, google_id FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = result.rows[0];

    // Cuentas Google no tienen password
    if (!user.password) {
      return res.status(400).json({
        error: 'Esta cuenta usa Google. No puedes cambiar la contraseña aquí.',
      });
    }

    const validCurrent = await bcrypt.compare(currentPassword, user.password);
    if (!validCurrent) {
      return res.status(401).json({ error: 'La contraseña actual es incorrecta' });
    }

    // Verificar que no sea la misma
    const samePassword = await bcrypt.compare(newPassword, user.password);
    if (samePassword) {
      return res.status(400).json({
        error: 'La nueva contraseña debe ser diferente a la actual',
      });
    }

    const newHash = await bcrypt.hash(newPassword, 12);

    await pool.query(
      'UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2',
      [newHash, userId]
    );

    return res.json({ message: 'Contraseña actualizada exitosamente' });
  } catch (err) {
    console.error('ERROR CHANGE PASSWORD:', err);
    return res.status(500).json({ error: 'Error al cambiar contraseña' });
  }
};

// ────────────────────────────────────────────────
// DELETE ACCOUNT
// ────────────────────────────────────────────────
const deleteAccount = async (req, res) => {
  try {
    const userId = req.user.id;
    const { password } = req.body;

    const result = await pool.query(
      'SELECT password FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Verificar contraseña si no es cuenta Google
    if (result.rows[0].password) {
      if (!password) {
        return res.status(400).json({ error: 'Ingresa tu contraseña para confirmar' });
      }
      const valid = await bcrypt.compare(password, result.rows[0].password);
      if (!valid) {
        return res.status(401).json({ error: 'Contraseña incorrecta' });
      }
    }

    // Eliminar archivos de Supabase Storage
    const docs = await pool.query(
      'SELECT file_url FROM documents WHERE user_id = $1',
      [userId]
    );

    for (const doc of docs.rows) {
      const parts = doc.file_url.split('/storage/v1/object/public/documents/');
      if (parts[1]) {
        await supabase.storage.from('documents').remove([parts[1]]);
      }
    }

    // Eliminar avatar
    await supabase.storage.from('avatars').remove([`avatars/${userId}/avatar.jpg`]);

    // Eliminar usuario (cascade elimina documentos, firmas, audit_log)
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    return res.json({ message: 'Cuenta eliminada permanentemente' });
  } catch (err) {
    console.error('ERROR DELETE ACCOUNT:', err);
    return res.status(500).json({ error: 'Error al eliminar cuenta' });
  }
};

module.exports = { getProfile, updateProfile, uploadAvatar, changePassword, deleteAccount };