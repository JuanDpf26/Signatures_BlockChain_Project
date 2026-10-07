const express = require('express');
const router = express.Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/authMiddleware');
const {
  uploadDocument,
  getDocuments,
  getDocument,
  reanalyzeDocument,
  updateDocumentMeta,
  replaceDocumentFile,
  sendDocumentByEmail,
  deleteDocument,
  getStats,
} = require('../controllers/documentController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Solo PDF y Word permitidos'));
  },
});

router.use(authMiddleware);

// Envío por correo: máximo 15 envíos cada 15 minutos por usuario (evita spam)
const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  keyGenerator: (req) => `send:${req.user.id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Enviaste muchos correos seguidos. Espera unos minutos e inténtalo de nuevo.' },
});

router.get('/stats', getStats);
router.post('/upload', upload.single('file'), uploadDocument);
router.get('/', getDocuments);
router.get('/:id', getDocument);
router.post('/:id/reanalyze', reanalyzeDocument);
router.patch('/:id', updateDocumentMeta);
router.put('/:id/file', upload.single('file'), replaceDocumentFile);
router.post('/:id/send', sendLimiter, sendDocumentByEmail);
router.delete('/:id', deleteDocument);

module.exports = router;