const express = require('express');
const {
  getDefaultOperationalHours,
  updateDefaultOperationalHours,
  resetDefaultOperationalHours
  // Remove createDefaultOperationalHours from imports
} = require('../controllers/defaultOperationalHoursController');
const { protect, requireMedicalCenter } = require('../middleware/auth');
const { validateDefaultOperationalHours } = require('../middleware/validation');

const router = express.Router();

// Apply authentication and medical center verification to all routes
router.use(protect);
router.use(requireMedicalCenter);

// @route   GET /api/default-operational-hours
// @desc    Get default operational hours for medical center
// @access  Private (Medical Center)
router.get('/', getDefaultOperationalHours);

// @route   PUT /api/default-operational-hours
// @desc    Update default operational hours (also creates if doesn't exist)
// @access  Private (Medical Center)
router.put('/', validateDefaultOperationalHours, updateDefaultOperationalHours);

// @route   PATCH /api/default-operational-hours
// @desc    Partial update default operational hours
// @access  Private (Medical Center)
router.patch('/', updateDefaultOperationalHours);

// @route   POST /api/default-operational-hours/reset
// @desc    Reset default operational hours to template
// @access  Private (Medical Center)
router.post('/reset', resetDefaultOperationalHours);

// @route   GET /api/default-operational-hours/validate
// @desc    Validate current operational hours configuration
// @access  Private (Medical Center)
router.get('/validate', async (req, res) => {
  try {
    const DefaultOperationalHours = require('../models/DefaultOperationalHours');
    const operationalHours = await DefaultOperationalHours.findOne({
      medical_center_id: req.medicalCenter._id
    });

    if (!operationalHours) {
      return res.status(404).json({
        success: false,
        message: 'No operational hours found'
      });
    }

    // Validate all days for time conflicts
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const validationResults = {};
    let hasConflicts = false;

    days.forEach(day => {
      const isValid = operationalHours.validateTimeConflicts(day);
      validationResults[day] = isValid;
      if (!isValid) hasConflicts = true;
    });

    res.status(200).json({
      success: true,
      data: {
        validationResults,
        hasConflicts,
        operationalHours: {
          _id: operationalHours._id,
          slotDuration: operationalHours.slotDuration,
          bufferTime: operationalHours.bufferTime,
          updated_at: operationalHours.updated_at
        }
      }
    });
  } catch (error) {
    console.error('Validation error:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating operational hours',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
});

module.exports = router;