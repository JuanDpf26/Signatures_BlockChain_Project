const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const c = require('../controllers/notifications.controller');

const router = express.Router();
router.use(authMiddleware);
router.get('/', c.list);
router.get('/summary', c.summary);
router.post('/read', c.markRead);
router.post('/archive', c.archive);

module.exports = router;
