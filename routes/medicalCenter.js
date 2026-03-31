const express = require('express');
const {
  registerMedicalCenter,
  loginMedicalCenter,
  getMe,
  addBranch,
  addPractitioner,
  updateProfile,
  getAllMedicalCenters ,forgotPasswordMedicalCenter,resetPasswordMedicalCenter,getPaymentSettings,updatePaymentSettings ,updateBankDetails
} = require('../controllers/medicalCenterController');
const { protect } = require('../middleware/auth');
const { authLimiter, generalLimiter } = require('../middleware/rateLimiter');


const router = express.Router();

// Public routes with rate limiting
router.post('/register', authLimiter, registerMedicalCenter);
router.post('/login', authLimiter, loginMedicalCenter);
router.get('/all', getAllMedicalCenters);
router.get('/payment-settings', getPaymentSettings);

router.post('/forgot-password', authLimiter, forgotPasswordMedicalCenter);
router.put('/reset-password/:token', authLimiter, resetPasswordMedicalCenter);

// Protected routes
router.use(protect); // All routes below this are protected
router.use(generalLimiter); // Apply general rate limiting to all protected routes

router.get('/me', getMe);
router.put('/profile', updateProfile);

router.put(
  '/bank-details',
  updateBankDetails
);



router.put('/payment-settings', updatePaymentSettings);


module.exports = router;