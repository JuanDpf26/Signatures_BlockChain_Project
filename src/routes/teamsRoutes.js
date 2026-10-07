const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const c = require('../controllers/teams.controller');

router.use(authMiddleware);
router.get('/', c.listTeams);
router.post('/', c.createTeam);
router.get('/users/search', c.searchUsers);
router.get('/:id', c.getTeam);
router.patch('/:id', c.updateTeam);
router.delete('/:id', c.deleteTeam);
router.post('/:id/members', c.addMember);
router.patch('/:id/members/:userId', c.setMemberRole);
router.delete('/:id/members/:userId', c.removeMember);

module.exports = router;
