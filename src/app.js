require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/authRoutes');
const documentRoutes = require('./routes/documentRoutes');
const profileRoutes = require('./routes/profileRoutes');
const signatureRoutes = require('./routes/signatureRoutes');
const { initFirebase } = require('./config/firebase');

// Inicializar Firebase
initFirebase();

const app = express();

// Seguridad
app.use(helmet({ crossOriginOpenerPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Demasiadas solicitudes, intenta más tarde' },
}));

// Rutas
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/signatures', signatureRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// Error handler global
app.use((err, req, res, next) => {
  console.error('ERROR:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
});