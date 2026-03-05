const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const workingHoursSchema = new mongoose.Schema({
  day: {
    type: String,
    enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
    required: true
  },
  morning: {
    enabled: { type: Boolean, default: true },
    start: { type: String, default: '08:00' },
    end: { type: String, default: '12:00' }
  },
  afternoon: {
    enabled: { type: Boolean, default: true },
    start: { type: String, default: '13:00' },
    end: { type: String, default: '17:00' }
  },
  night: { 
    enabled: { type: Boolean, default: false },
    start: { type: String, default: '18:00' },
    end: { type: String, default: '22:00' }
  },
  enabled: { type: Boolean, default: true }
});

const absenceSchema = new mongoose.Schema({
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  reason: String,
  type: {
    type: String,
    enum: ['vacation', 'sick_leave', 'training', 'personal', 'other'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  }
});

const practitionerSchema = new mongoose.Schema({
  practitioner_id: { type: String, default: uuidv4, unique: true },
  medical_center_ids: [
  {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicalCenter',

  }

],
resetPasswordToken: String,
resetPasswordExpire: Date,
  
  // Personal Information
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: String,
  idNumber: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  
  // Professional Information
  role: {
    type: String,
    enum: ['doctor', 'nurse', 'specialist', 'surgeon', 'therapist', 'admin'],
    required: true
  },
  specialization: [String],
  qualification: { type: String, required: true },
  licenseNumber: { type: String, required: true },
  experience: { type: Number, default: 0 },
  
  // Availability and Settings
  availableFor: [{
    type: String,
    enum: ['face-to-face', 'online']
  }],
  isActive: { type: Boolean, default: true },
  isTemporary: { type: Boolean, default: false },
  maxPatientsPerSlot: { type: Number, default: 4 },
  hourlyRate: { type: Number, default: 0 },
  
  // Working Hours
  defaultWorkingHours: [workingHoursSchema],
  
  // Temporary Period
  temporaryPeriod: {
    start: Date,
    end: Date
  },
  
  // Schedule and Status
  currentStatus: {
    type: String,
    enum: ['available', 'busy', 'on_break', 'off_duty', 'absent'],
    default: 'available'
  },
  currentPatientLoad: { type: Number, default: 0 },
  
  // Time Tracking
  absences: [absenceSchema],
  lateArrivals: [{
    date: Date,
    duration: Number, // in minutes
    reason: String
  }],
  
  // Additional Information
  notes: String,
  
  // Timestamps
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
  last_login: Date
});

// Update timestamp before saving
practitionerSchema.pre('save', function(next) {
  this.updated_at = Date.now();
  next();
});

// Index for efficient queries
practitionerSchema.index({ medical_center_ids: 1, isActive: 1 });
practitionerSchema.index({ email: 1 });
practitionerSchema.index({ idNumber: 1 });

module.exports = mongoose.model('Practitioner', practitionerSchema);