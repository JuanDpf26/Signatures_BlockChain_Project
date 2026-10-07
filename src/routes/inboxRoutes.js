const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const c = require('../controllers/inbox.controller');

router.use(authMiddleware);
router.get('/', c.listInbox);
router.get('/summary', c.inboxSummary);
router.get('/:id', c.getInboxItem);
router.post('/:id/respond', c.respond);
router.post('/:id/archive', c.archive);

module.exports = router;
