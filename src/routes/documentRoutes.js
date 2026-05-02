const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const auth = require('../middleware/authMiddleware');
const docController = require('../controllers/documentController');

router.post('/upload', auth, upload.single('file'), docController.uploadDocument);

module.exports = router;