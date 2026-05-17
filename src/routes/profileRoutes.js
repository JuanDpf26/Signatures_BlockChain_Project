const express = require('express');
const router = express.Router();
const multer = require('multer');
const authMiddleware = require('../middleware/authMiddleware');
const {
  getProfile,
  updateProfile,
  uploadAvatar,
  changePassword,
  deleteAccount,
} = require('../controllers/profileController');

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Solo imágenes JPG, PNG o WebP'));
  },
});

router.use(authMiddleware);

router.get('/', getProfile);
router.patch('/', updateProfile);
router.post('/avatar', avatarUpload.single('avatar'), uploadAvatar);
router.patch('/password', changePassword);
router.delete('/', deleteAccount);

module.exports = router;