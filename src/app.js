require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/authRoutes');
const documentRoutes = require('./routes/documentRoutes');
const profileRoutes = require('./routes/profileRoutes');
const signatureRoutes = require('./routes/signatureRoutes');
const signingRoutes = require('./routes/signingRoutes');
const agentRoutes = require('./routes/agentRoutes');
const auditRoutes = require('./routes/auditRoutes');
const { initAudit, auditMiddleware } = require('./services/audit.service');
const { initKeys } = require('./services/keys.service');
const keysRoutes = require('./routes/keysRoutes');
const teamsRoutes = require('./routes/teamsRoutes');
const inboxRoutes = require('./routes/inboxRoutes');
const { initCollab } = require('./services/collab.service');

// Inicializar Firebase
const { initFirebase } = require('./config/firebase');
initFirebase();

// Inicializar Blockchain
const { initBlockchain } = require('./services/blockchain.service');
initBlockchain();

const app = express();
app.set('trust proxy', 1); // IP real detrás de un proxy (Render, Vercel…)

// Auditoría: crea la tabla si no existe
initAudit();
initKeys();
initCollab();

// Seguridad
app.use(helmet({ crossOriginOpenerPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ID por petición + registro de auditoría
app.use(auditMiddleware);

// Rate limiting
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 600,
  message: { error: 'Demasiadas solicitudes, intenta más tarde' },
  // El seguimiento de la firma consulta cada pocos segundos: no cuenta para el límite
  skip: (req) => req.method === 'GET' && /^\/api\/signing\/[^/]+\/status$/.test(req.path),
}));

// Rutas
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/signatures', signatureRoutes);
app.use('/api/signing', signingRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/keys', keysRoutes);
app.use('/api/teams', teamsRoutes);
app.use('/api/inbox', inboxRoutes);

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