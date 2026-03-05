const express = require('express');
const router = express.Router();
const { 
  registerPatient, 
  loginPatient, 
  getPatientProfile,
  updatePatientProfile ,
    forgotPasswordPatient,
  resetPasswordPatient
} = require('../controllers/patientController');
const { protect } = require('../middleware/auth');

// Public routes
router.post('/register', registerPatient);
router.post('/login', loginPatient);

router.post('/forgot-password', forgotPasswordPatient);
router.put('/reset-password/:token', resetPasswordPatient);

// Protected routes
router.get('/profile', protect, getPatientProfile);
router.put('/profile', protect, updatePatientProfile);

module.exports = router;