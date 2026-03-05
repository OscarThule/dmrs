const express = require('express');
const {
  addPractitioner,
  getPractitioners,
  getPractitioner,
  updatePractitioner,
  deletePractitioner,
  loginPractitioner , updateSelfPractitioner , forgotPassword,
  resetPassword
} = require('../controllers/practitionerController');
const { protect, requireMedicalCenter ,requirePractitioner } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Public routes
router.post('/login', authLimiter, loginPractitioner);



router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);
router.use(protect);
// Practitioner-only self update route
router.put('/me', updateSelfPractitioner);
// Protected routes (Medical Center only)
router.use(protect);
router.use(requireMedicalCenter);

router.post('/', addPractitioner);
router.get('/', getPractitioners);
router.get('/:id', getPractitioner);
router.put('/:id', updatePractitioner);
router.delete('/:id', deletePractitioner);

module.exports = router;