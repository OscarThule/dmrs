const Practitioner = require('../models/Practitioner');
const MedicalCenter = require('../models/MedicalCenter');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Generate token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: '30d'
  });
};

// @desc    Add new practitioner
// @route   POST /api/practitioners
// @access  Private (Medical Center Admin)
const addPractitioner = async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      idNumber,
      password,
      specialization,
      qualification,
      licenseNumber,
      experience,
      role,
      availableFor,
      isActive,
      isTemporary,
      maxPatientsPerSlot,
      notes,
      defaultWorkingHours,
      hourlyRate,
      temporaryPeriod
    } = req.body;

    // Validation
    if (!name || !email || !idNumber || !password || !qualification || !licenseNumber) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields: name, email, ID number, password, qualification, and license number'
      });
    }

    // Check if practitioner already exists
    const existingPractitioner = await Practitioner.findOne({
      $or: [
        { email },
        { idNumber },
        { licenseNumber }
      ]
    });

    if (existingPractitioner) {
      return res.status(400).json({
        success: false,
        message: 'Practitioner with this email, ID number, or license number already exists'
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create practitioner
    const practitioner = await Practitioner.create({
      medical_center_ids: [req.medicalCenter._id],
      name,
      email,
      phone,
      idNumber,
      password: hashedPassword,
      specialization: specialization || [],
      qualification,
      licenseNumber,
      experience: experience || 0,
      role: role || 'doctor',
      availableFor: availableFor || ['face-to-face'],
      isActive: isActive !== undefined ? isActive : true,
      isTemporary: isTemporary || false,
      maxPatientsPerSlot: maxPatientsPerSlot || 4,
      notes,
      defaultWorkingHours: defaultWorkingHours || getDefaultWorkingHours(),
      hourlyRate: hourlyRate || 0,
      temporaryPeriod
    });

    // IMPROVEMENT: Use $addToSet to prevent duplicate practitioner IDs in medical center
    await MedicalCenter.findByIdAndUpdate(
      req.medicalCenter._id,
      { $addToSet: { practitioners: practitioner._id } } // Prevents duplicates
    );

    res.status(201).json({
      success: true,
      message: 'Practitioner added successfully',
      data: {
        practitioner_id: practitioner.practitioner_id,
        name: practitioner.name,
        email: practitioner.email,
        role: practitioner.role,
        isActive: practitioner.isActive,
        medical_center_ids: practitioner.medical_center_ids
      }
    });
  } catch (error) {
    console.error('Add practitioner error:', error);

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Practitioner with this email, ID number, or license number already exists'
      });
    }

    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error adding practitioner',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

// @desc    Get all practitioners for medical center
// @route   GET /api/practitioners
// @access  Private
const getPractitioners = async (req, res) => {
  try {
    const practitioners = await Practitioner.find({ 
      medical_center_ids: req.medicalCenter._id
    }).select('-password');

    res.status(200).json({
      success: true,
      count: practitioners.length,
      data: practitioners
    });
  } catch (error) {
    console.error('Get practitioners error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching practitioners',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

// @desc    Get single practitioner
// @route   GET /api/practitioners/:id
// @access  Private
const getPractitioner = async (req, res) => {
  try {
    const practitioner = await Practitioner.findOne({
      _id: req.params.id,
      medical_center_ids: req.medicalCenter._id
    }).select('-password');

    if (!practitioner) {
      return res.status(404).json({
        success: false,
        message: 'Practitioner not found'
      });
    }

    res.status(200).json({
      success: true,
      data: practitioner
    });
  } catch (error) {
    console.error('Get practitioner error:', error);
    
    // Handle invalid ObjectId
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid practitioner ID format'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error fetching practitioner',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

// @desc    Update practitioner
// @route   PUT /api/practitioners/:id
// @access  Private
const updatePractitioner = async (req, res) => {
  try {
    const updates = req.body;

    // Remove sensitive/immutable fields
    delete updates.password;
    delete updates.medical_center_ids;
    delete updates.practitioner_id;

    const practitioner = await Practitioner.findOneAndUpdate(
      { _id: req.params.id, medical_center_ids: req.medicalCenter._id },
      updates,
      { new: true, runValidators: true }
    ).select('-password');

    if (!practitioner) {
      return res.status(404).json({
        success: false,
        message: 'Practitioner not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Practitioner updated successfully',
      data: practitioner
    });
  } catch (error) {
    console.error('Update practitioner error:', error);

    // Handle invalid ObjectId
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid practitioner ID format'
      });
    }

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Practitioner with this email, ID number, or license number already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error updating practitioner',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

// @desc    Delete practitioner
// @route   DELETE /api/practitioners/:id
// @access  Private
const deletePractitioner = async (req, res) => {
  try {
    const practitioner = await Practitioner.findOneAndDelete({
      _id: req.params.id,
      medical_center_ids: req.medicalCenter._id
    });

    if (!practitioner) {
      return res.status(404).json({
        success: false,
        message: 'Practitioner not found'
      });
    }

    // Remove from medical center's practitioners array
    await MedicalCenter.findByIdAndUpdate(
      req.medicalCenter._id,
      { $pull: { practitioners: req.params.id } }
    );

    res.status(200).json({
      success: true,
      message: 'Practitioner deleted successfully'
    });
  } catch (error) {
    console.error('Delete practitioner error:', error);
    
    // Handle invalid ObjectId
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid practitioner ID format'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error deleting practitioner',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

// @desc    Practitioner login
// @route   POST /api/practitioners/login
// @access  Public
const loginPractitioner = async (req, res) => {
  try {
    const { idNumber, password } = req.body;

    console.log("LOGIN REQUEST BODY:", req.body);

    if (!idNumber || !password) {
      return res.status(400).json({
        success: false,
        message: 'ID number and password are required'
      });
    }

    // Find practitioner by ID number
    const practitioner = await Practitioner.findOne({ idNumber });

    if (!practitioner) {
      return res.status(401).json({
        success: false,
        message: 'Invalid ID number or password'
      });
    }

    // Compare password with hashed password
    const isMatch = await bcrypt.compare(password, practitioner.password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid ID number or password'
      });
    }

    // Check if account is active
    if (!practitioner.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated. Please contact your medical center administrator.'
      });
    }

    // Check for expired temporary contracts
    if (practitioner.isTemporary && practitioner.temporaryPeriod) {
      const now = new Date();
      if (now > new Date(practitioner.temporaryPeriod.end)) {
        return res.status(401).json({
          success: false,
          message: 'Temporary contract expired. Please contact your medical center administrator.'
        });
      }
      
      // Also check if temporary period hasn't started yet
      if (now < new Date(practitioner.temporaryPeriod.start)) {
        return res.status(401).json({
          success: false,
          message: 'Temporary contract has not started yet. Please contact your medical center administrator.'
        });
      }
    } 

  



    // Generate JWT
    const token = generateToken(practitioner._id);

    // Prepare session data for frontend
    const sessionData = {
      id: practitioner._id,
      practitioner_id: practitioner.practitioner_id,
      name: practitioner.name,
      email: practitioner.email,
      phone: practitioner.phone,
      idNumber: practitioner.idNumber,
      role: practitioner.role,
      specialization: practitioner.specialization,
      medical_center_ids: practitioner.medical_center_ids,
      isActive: practitioner.isActive,
      last_login: practitioner.last_login
    };

    // Update last login time
    practitioner.last_login = new Date();
    await practitioner.save();

    return res.status(200).json({
      session: sessionData,
      token
    });

  } catch (error) {
    console.error("Login Error:", error);
    return res.status(500).json({
      success: false,
      message: 'Server error during login'
    });
  }
};

const updateSelfPractitioner = async (req, res) => {
  try {
    const updates = req.body;

    // Prevent sensitive or forbidden updates
    delete updates.password;
    delete updates.role;
    delete updates.medical_center_ids;
    delete updates.practitioner_id;
    delete updates.isTemporary;
    delete updates.temporaryPeriod;
    delete updates.defaultWorkingHours;
    delete updates.maxPatientsPerSlot;
    delete updates.isActive;

    const practitioner = await Practitioner.findByIdAndUpdate(
      req.user.id,
      updates,
      { new: true, runValidators: true }
    ).select('-password');

    if (!practitioner) {
      return res.status(404).json({
        success: false,
        message: 'Practitioner not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: practitioner
    });
  } catch (error) {
    console.error('Update self practitioner error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating profile',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

// Helper: Default working hours
const getDefaultWorkingHours = () => {
  const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  return days.map(day => ({
    day,
    morning: { enabled: true, start: '08:00', end: '12:00' },
    afternoon: { enabled: true, start: '13:00', end: '17:00' },
    night: { enabled: false, start: '18:00', end: '22:00' },
    enabled: !['saturday','sunday'].includes(day)
  }));
};

  // @desc    Forgot password
// @route   POST /api/practitioners/forgot-password
// @access  Public
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const practitioner = await Practitioner.findOne({ email });
    if (!practitioner) {
      return res.status(200).json({
        success: true,
        message: 'If the email exists, a reset link has been sent'
      });
    }

    // Generate token
    const resetToken = crypto.randomBytes(32).toString('hex');

    practitioner.resetPasswordToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');

    practitioner.resetPasswordExpire = Date.now()+ 2 * 60  * 60 * 1000; // 15 min

    await practitioner.save();

    // 🔐 Production:
    // Send email/SMS here using SendGrid, AWS SES, Twilio, etc.
   const resetUrl = `http://localhost:3000/doctorLogin?token=${resetToken}`;

const sendEmail = require('../utils/sendEmail'); // same helper you used for medical center

await sendEmail({
  to: practitioner.email,
  subject: 'Reset your password',
  html: `
    <p>You requested a password reset.</p>
    <p>Click the link below (valid for 2 hours):</p>
    <a href="${resetUrl}">${resetUrl}</a>
    <p>If you didn’t request this, ignore this email.</p>
  `
});



    return res.status(200).json({
      success: true,
      message: 'Password reset link sent'
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Reset password
// @route   POST /api/practitioners/reset-password/:token
// @access  Public
const resetPassword = async (req, res) => {
  try {
    const hashedToken = crypto
      .createHash('sha256')
      .update(req.params.token)
      .digest('hex');

    const practitioner = await Practitioner.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() }
    });

    if (!practitioner) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired token'
      });
    }

    const salt = await bcrypt.genSalt(12);
    practitioner.password = await bcrypt.hash(req.body.password, salt);

    practitioner.resetPasswordToken = undefined;
    practitioner.resetPasswordExpire = undefined;

    await practitioner.save();

    res.status(200).json({
      success: true,
      message: 'Password reset successful'
    });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = {
  addPractitioner,
  getPractitioners,
  getPractitioner,
  updatePractitioner,
  deletePractitioner,
  loginPractitioner,
  updateSelfPractitioner,
 forgotPassword ,
  resetPassword
};