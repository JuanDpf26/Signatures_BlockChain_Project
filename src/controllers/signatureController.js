const { getFirestore } = require('../config/firebase');

// ────────────────────────────────────────────────
// GUARDAR FIRMA COMO IMAGEN (base64)
// ────────────────────────────────────────────────
const saveSignatureImage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { signatureBase64, width, height } = req.body;

    if (!signatureBase64) {
      return res.status(400).json({ error: 'Imagen de firma requerida' });
    }

    // Validar que sea base64 válido
    if (!signatureBase64.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Formato de imagen inválido' });
    }

    // Validar tamaño (máx 500KB en base64)
    const base64Size = Buffer.byteLength(signatureBase64, 'utf8');
    if (base64Size > 700 * 1024) {
      return res.status(400).json({ error: 'La imagen de firma es demasiado grande' });
    }

    const db = getFirestore();
    const sigRef = db.collection('signatures').doc(userId);

    const signatureData = {
      userId,
      signatureBase64,
      width: width || 300,
      height: height || 150,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Upsert — un usuario solo tiene una firma guardada
    await sigRef.set(signatureData, { merge: true });

    return res.json({
      message: 'Firma guardada exitosamente',
      signature: {
        userId,
        width: signatureData.width,
        height: signatureData.height,
        updatedAt: signatureData.updatedAt,
      },
    });
  } catch (err) {
    console.error('ERROR SAVE SIGNATURE:', err);
    return res.status(500).json({ error: 'Error al guardar firma' });
  }
};

// ────────────────────────────────────────────────
// OBTENER FIRMA DEL USUARIO
// ────────────────────────────────────────────────
const getSignatureImage = async (req, res) => {
  try {
    const userId = req.user.id;
    const db = getFirestore();

    const sigDoc = await db.collection('signatures').doc(userId).get();

    if (!sigDoc.exists) {
      return res.status(404).json({ error: 'No tienes firma guardada aún' });
    }

    return res.json({ signature: sigDoc.data() });
  } catch (err) {
    console.error('ERROR GET SIGNATURE:', err);
    return res.status(500).json({ error: 'Error al obtener firma' });
  }
};

// ────────────────────────────────────────────────
// ELIMINAR FIRMA
// ────────────────────────────────────────────────
const deleteSignatureImage = async (req, res) => {
  try {
    const userId = req.user.id;
    const db = getFirestore();

    await db.collection('signatures').doc(userId).delete();

    return res.json({ message: 'Firma eliminada' });
  } catch (err) {
    console.error('ERROR DELETE SIGNATURE:', err);
    return res.status(500).json({ error: 'Error al eliminar firma' });
  }
};

module.exports = { saveSignatureImage, getSignatureImage, deleteSignatureImage };