const Patient = require('../models/Patient');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');
const bcrypt = require('bcryptjs');

// Generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'your-secret-key', {
    expiresIn: process.env.JWT_EXPIRE || '30d'
  });
};

// @desc    Register patient
// @route   POST /api/patients/register
// @access  Public
exports.registerPatient = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      idNumber,
      password,
      address,
      dateOfBirth,
      gender,
      emergencyContact
    } = req.body;

    // Check if patient already exists
    const patientExists = await Patient.findOne({ 
      $or: [{ email }, { idNumber }] 
    });

    if (patientExists) {
      return res.status(400).json({
        success: false,
        message: 'Patient already exists with this email or ID number'
      });
    }

const patient = await Patient.create({
  patient_id: `PAT-${uuidv4()}`,
  firstName,
  lastName,
  email,
  phone,
  idNumber,
  password,
  address,
  dateOfBirth,
  gender,
  emergencyContact
});


    // Generate token
    const token = generateToken(patient._id);

    res.status(201).json({
      success: true,
      token,
      patient: {
        _id: patient._id,
        firstName: patient.firstName,
        lastName: patient.lastName,
        email: patient.email,
        phone: patient.phone,
        idNumber: patient.idNumber,
        address: patient.address,
        dateOfBirth: patient.dateOfBirth,
        gender: patient.gender,
        emergencyContact: patient.emergencyContact
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Error registering patient',
      error: error.message
    });
  }
};

// @desc    Login patient
// @route   POST /api/patients/login
// @access  Public
exports.loginPatient = async (req, res) => {
  try {
    let { idNumber, password } = req.body;

    idNumber = idNumber.trim();
    password = password.trim();

    const patient = await Patient.findOne({ idNumber }).select('+password');

    if (!patient) {
      console.log("Patient not found for:", idNumber);
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const isMatch = await patient.comparePassword(password);

    console.log("Password match:", isMatch);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const token = generateToken(patient._id);

    res.status(200).json({
      success: true,
      token,
      patient: {
        _id: patient._id,
        firstName: patient.firstName,
        lastName: patient.lastName,
        email: patient.email,
        phone: patient.phone,
        idNumber: patient.idNumber,
        address: patient.address,
        dateOfBirth: patient.dateOfBirth,
        gender: patient.gender,
        emergencyContact: patient.emergencyContact
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Error logging in',
      error: error.message
    });
  }
};


// @desc    Get patient profile
// @route   GET /api/patients/profile
// @access  Private
exports.getPatientProfile = async (req, res) => {
  try {
    const patient = await Patient.findById(req.patientId);

    if (!patient) {
      return res.status(404).json({
        success: false,
        message: 'Patient not found'
      });
    }

    res.status(200).json({
      success: true,
      patient
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching profile',
      error: error.message
    });
  }
};

// @desc    Update patient profile
// @route   PUT /api/patients/profile
// @access  Private
exports.updatePatientProfile = async (req, res) => {
  try {
    const updates = req.body;
    delete updates.password; // Don't allow password update here
    
    const patient = await Patient.findByIdAndUpdate(
      req.patientId,
      updates,
      { new: true, runValidators: true }
    );

    res.status(200).json({
      success: true,
      patient
    });
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating profile',
      error: error.message
    });
  }
};
exports.forgotPasswordPatient = async (req, res) => {
  const { email } = req.body;

  const patient = await Patient.findOne({ email });
  if (!patient) {
    return res.json({ success: true, message: 'If email exists, link was sent' });
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  patient.resetPasswordToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');
  patient.resetPasswordExpire = Date.now() + 1000 * 60 * 60 * 2; // 2 hours

  await patient.save({ validateBeforeSave: false });

  const resetUrl = `http://localhost:3000//reset-password-patient/${resetToken}`;

  await sendEmail({
  to: email,
  subject: 'Reset your password',
  html: `
    <p>You requested a password reset.</p>
    <p>Click below:</p>
    <a href="${resetUrl}">${resetUrl}</a>
    <p>This link expires soon.</p>
  `
});

  res.json({ success: true, message: 'Reset link sent to email' });
};

exports.resetPasswordPatient = async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  const hashedPassword = await bcrypt.hash(password, 10);

  const patient = await Patient.findOneAndUpdate(
    {
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() }
    },
    {
      password: hashedPassword,
      resetPasswordToken: undefined,
      resetPasswordExpire: undefined
    },
    { new: true, runValidators: false } // 👈 important
  );

  if (!patient) {
    return res.status(400).json({ message: 'Token invalid or expired' });
  }

  res.json({ message: 'Password reset successful' });
};
