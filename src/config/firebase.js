const admin = require('firebase-admin');

// Inicializar Firebase Admin SDK
// Descarga el serviceAccountKey.json desde:
// Firebase Console → Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada
// Ponlo en: src/config/firebase-service-account.json
// Y agrégalo a .gitignore

let db;

const initFirebase = () => {
  if (admin.apps.length > 0) {
    db = admin.firestore();
    return db;
  }

  try {
    // Opción 1: Archivo JSON (desarrollo local)
    if (process.env.NODE_ENV !== 'production') {
      const serviceAccount = require('./firebase-service-account.json');
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    } else {
      // Opción 2: Variable de entorno (Railway en producción)
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

    db = admin.firestore();
    console.log('✅ Firebase Firestore conectado');
    return db;
  } catch (err) {
    console.error('❌ Error conectando Firebase:', err.message);
    return null;
  }
};

const getFirestore = () => {
  if (!db) return initFirebase();
  return db;
};

module.exports = { initFirebase, getFirestore };