const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const {
  saveSignatureImage,
  getSignatureImage,
  deleteSignatureImage,
} = require('../controllers/signatureController');

router.use(authMiddleware);

router.get('/', getSignatureImage);
router.post('/', saveSignatureImage);
router.delete('/', deleteSignatureImage);

module.exports = router;