const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const { protect, requirePatient, requireAnyUser, requirePractitioner, requireMedicalCenter } = require('../middleware/auth');
const Appointment = require('../models/Appointments');

// ============ PATIENT ROUTES (PROTECTED) ============

// Book an appointment (Patient only)
router.post(
  '/',
  protect,
  requirePatient,
  bookingController.createPendingAppointment
);

// Get appointments (patient / doctor / medical center)
router.get(
  '/patient',
  protect,
  requireAnyUser,
  bookingController.getPatientAppointments
);

// Get all appointments (Patient only)
// Get all appointments for a medical center (Patient only)
router.get(
  '/all',
  protect,
  requireAnyUser,
  bookingController.getAllAppointments
);

// Cancel appointment (patient / doctor / medical center)
router.put(
  '/:id/cancel',
  protect,
  requireAnyUser,
  bookingController.cancelAppointment
);

// Get available doctors for slot (Patient only)
router.get(
  '/available-doctors',
  protect,
  requirePatient,
  bookingController.getAvailableDoctorsForSlot
);

// ============ SLOT SHIFTING ROUTES ============

// Shift doctor's slots due to delay (Doctor or Medical Center only)
router.post(
  '/shift-slots',
  protect,
  (req, res, next) => {
    // Allow practitioners and medical centers
    if (req.userType !== 'practitioner' && req.userType !== 'medicalCenter') {
      return res.status(403).json({
        success: false,
        message: 'Doctor or medical center access required'
      });
    }
    next();
  },
  bookingController.shiftDoctorSlots
);

// Get late arrivals history (Doctor or Medical Center only)
router.get(
  '/late-arrivals',
  protect,
  (req, res, next) => {
    if (req.userType !== 'Practitioner' && req.userType !== 'MedicalCenter') {
      return res.status(403).json({
        success: false,
        message: 'Doctor or medical center access required'
      });
    }
    next();
  },
  bookingController.getLateArrivals
);

// ============ MEDICAL CENTER ROUTES ============

// Get medical center appointments (Medical Center only)
router.get(
  '/medical-center',
  protect,
  async (req, res) => {
    if (req.userType !== 'MedicalCenter') {
      return res.status(403).json({
        success: false,
        message: 'Medical center access required'
      });
    }
    
    try {
      const { status, dateFrom, dateTo, limit = 10, page = 1 } = req.query;
      const skip = (page - 1) * limit;
      
      const query = { medical_center_id: req.medicalCenter._id };
      
      if (status) query.status = status;
      if (dateFrom) query.date = { $gte: new Date(dateFrom) };
      if (dateTo) {
        if (!query.date) query.date = {};
        query.date.$lte = new Date(dateTo);
      }
      
      const appointments = await Appointment.find(query)
        .populate('patient_id', 'firstName lastName email phone')
        .populate('practitioner_id', 'full_name role specialties')
        .sort({ date: 1, slot_start: 1 })
        .skip(skip)
        .limit(parseInt(limit));
      
      const total = await Appointment.countDocuments(query);
      
      res.status(200).json({
        success: true,
        data: appointments,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      console.error('Error fetching medical center appointments:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch appointments'
      });
    }
  }
);

// Check doctor availability for a specific slot
router.get(
  '/check-doctor-availability',
  protect,
  requirePatient,
  async (req, res) => {
    try {
      const { practitioner_id, date, slot_id } = req.query;
      
      if (!practitioner_id || !date || !slot_id) {
        return res.status(400).json({
          success: false,
          message: 'Missing required parameters'
        });
      }
      
      // Check if doctor already has appointment at this time
      const existingAppointment = await Appointment.findOne({
        practitioner_id,
        date: new Date(date),
        slot_id,
        status: { $in: ['pending', 'confirmed'] }
      });
      
      res.status(200).json({
        success: true,
        isAvailable: !existingAppointment,
        existingAppointmentId: existingAppointment?._id || null
      });
    } catch (error) {
      console.error('Error checking doctor availability:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to check doctor availability'
      });
    }
  }
);

// ============ PRACTITIONER ROUTES ============

// Get practitioner appointments (Practitioner only)
router.get(
  '/practitioner',
  protect,
  async (req, res) => {
    if (req.userType !== 'Practitioner') {
      return res.status(403).json({
        success: false,
        message: 'Practitioner access required'
      });
    }
    
    try {
      const { status, date, limit = 100, page = 1 } = req.query;
      const skip = (page - 1) * limit;
      
      const query = { practitioner_id: req.practitioner._id };
      
      if (status && status !== 'all') query.status = status;
      if (date) query.date = new Date(date);
      
      const appointments = await Appointment.find(query)
        .populate('patient_id', 'firstName lastName email phone dateOfBirth gender emergencyContact')
        .populate('medical_center_id', 'facility_name address phone')
        .sort({ date: 1, slot_start: 1 })
        .skip(skip)
        .limit(parseInt(limit));
      
      const total = await Appointment.countDocuments(query);
      
      res.status(200).json({
        success: true,
        data: appointments,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      console.error('Error fetching practitioner appointments:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch appointments'
      });
    }
  }
);

router.put(
  '/appointment/:id/update',
  protect,
  async (req, res) => {
    try {
      const bookingController = require('../controllers/bookingController');
      await bookingController.updateAppointment(req, res);
    } catch (error) {
      console.error('Error in appointment update route:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }
);

module.exports = router;