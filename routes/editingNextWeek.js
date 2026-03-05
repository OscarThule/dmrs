const express = require('express');
const router = express.Router();
const editingNextWeekController = require('../controllers/editingNextWeek');
const { protect, requirePractitioner, requireMedicalCenter } = require('../middleware/auth');




// Get rolling window schedule for a specific medical center - PUBLIC ACCESS
router.route('/public/rolling-window/:medicalCenterId')
  .get(editingNextWeekController.getPublicRollingWindow);

// Get rolling window schedule by medical center ID (query param) - PUBLIC ACCESS
router.route('/public/rolling-window')
  .get(editingNextWeekController.getPublicRollingWindowByQuery);

  

// Apply authentication middleware to all routes
router.use(protect);

// Doctor personal schedule - accessible to practitioners only
router.route('/doctor-personal-schedule')
  .get(requirePractitioner, editingNextWeekController.getDoctorPersonalSchedule);

// Rolling window schedule - accessible to medical centers only
router.route('/rolling-window')
  .get(requireMedicalCenter, editingNextWeekController.getRollingWindow);

router.route('/roll-window')
  .post(requireMedicalCenter, editingNextWeekController.rollWindow);

// Daily schedule management - accessible to medical centers only
router.route('/:scheduleId/daily/:date')
  .put(requireMedicalCenter, editingNextWeekController.updateDailySchedule);

// Doctor assignment routes - accessible to medical centers only
router.route('/:scheduleId/assign-doctor/:date')
  .post(requireMedicalCenter, editingNextWeekController.assignDoctorToSlot);

router.route('/:scheduleId/remove-doctor/:date')
  .post(requireMedicalCenter, editingNextWeekController.removeDoctorFromSlot);

router.route('/:scheduleId/doctor-assignments')
  .get(requireMedicalCenter, editingNextWeekController.getDoctorAssignments);

// Slot duration management - accessible to medical centers only
router.route('/:scheduleId/slot-duration/:date')
  .put(requireMedicalCenter, editingNextWeekController.updateSlotDuration);

// Lunch break management - accessible to medical centers only
router.route('/:scheduleId/lunch-break/:date')
  .post(requireMedicalCenter, editingNextWeekController.addLunchBreak);

router.route('/:scheduleId/remove-lunch-break/:date')
  .post(requireMedicalCenter, editingNextWeekController.removeLunchBreak);

// Session management - accessible to medical centers only
router.route('/:scheduleId/session/:date')
  .put(requireMedicalCenter, editingNextWeekController.updateSession);

// Working day management - accessible to medical centers only
router.route('/:scheduleId/toggle-working/:date')
  .put(requireMedicalCenter, editingNextWeekController.toggleWorkingDay);

// Legacy routes - accessible to medical centers only
router.route('/')
  .get(requireMedicalCenter, editingNextWeekController.getRollingWindow)
  .post(requireMedicalCenter, editingNextWeekController.getRollingWindow);

router.route('/:id')
  .get(requireMedicalCenter, editingNextWeekController.getWeeklySchedule)
  .put(requireMedicalCenter, editingNextWeekController.updateWeeklySchedule);

module.exports = router;