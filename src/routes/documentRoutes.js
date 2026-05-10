const express = require('express');
const router = express.Router();
const multer = require('multer');
const authMiddleware = require('../middleware/authMiddleware');
const {
  uploadDocument,
  getDocuments,
  getDocument,
  updateDocumentMeta,
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

router.get('/stats', getStats);
router.post('/upload', upload.single('file'), uploadDocument);
router.get('/', getDocuments);
router.get('/:id', getDocument);
router.patch('/:id', updateDocumentMeta);
router.delete('/:id', deleteDocument);

module.exports = router;