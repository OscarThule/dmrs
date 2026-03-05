const jwt = require('jsonwebtoken');
const MedicalCenter = require('../models/MedicalCenter');
const Practitioner = require('../models/Practitioner');
const Patient = require('../models/Patient');

const protect = async (req, res, next) => {
  try {
    let token;

    // Extract Bearer token
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    // No token provided
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    console.log('🔐 Auth - Decoded token:', decoded);

    // Check for practitioner
    const practitioner = await Practitioner.findById(decoded.id).select('-password');
    if (practitioner) {
      console.log('✅ Auth - Found practitioner:', {
        id: practitioner._id,
        name: practitioner.full_name,
      });
      req.practitioner = practitioner;
      req.userType = 'practitioner';
      return next();
    }

    // Check for medical center
    const medicalCenter = await MedicalCenter.findById(decoded.id).select('-password');
    if (medicalCenter) {
      console.log('✅ Auth - Found medical center:', medicalCenter._id);
      req.medicalCenter = medicalCenter;
      req.userType = 'medicalCenter';
      return next();
    }

    // Check for patient - CRITICAL FIX: Set req.patient not req.patientId
    const patient = await Patient.findById(decoded.id).select('-password');
    if (patient) {
      console.log('✅ Auth - Found patient:', {
        id: patient._id,
        name: `${patient.firstName} ${patient.lastName}`,
      });
      
      // ✅ FIX: Set req.patient (not req.patientId)
      req.patient = patient;
      req.userType = 'patient';
      return next();
    }

    return res.status(401).json({
      success: false,
      message: 'User not found'
    });

  } catch (error) {
    console.error('❌ Auth error:', error.message);
    
    // More specific error messages
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired. Please log in again.'
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token. Please log in again.'
      });
    }
    
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
};

// Role-based access
const requireMedicalCenter = (req, res, next) => {
  if (req.userType !== 'medicalCenter') {
    return res.status(403).json({
      success: false,
      message: 'Medical center access required'
    });
  }
  next();
};

const requirePractitioner = (req, res, next) => {
  if (req.userType !== 'practitioner') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Practitioner only.'
    });
  }
  next();
};

const requirePatient = (req, res, next) => {
  if (req.userType !== 'patient') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Patient only.'
    });
  }
  next();
};
const requireAnyUser = (req, res, next) => {
  if (!['patient', 'practitioner', 'medicalCenter'].includes(req.userType)) {
    return res.status(403).json({
      success: false,
      message: 'Access denied'
    });
  }
  next();
};

module.exports = {
  protect,
  requireMedicalCenter,
  requirePractitioner,
  requirePatient,
  requireAnyUser
};