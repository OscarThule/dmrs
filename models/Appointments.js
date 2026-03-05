const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  appointment_id: {
    type: String,
    required: true,
    unique: true
  },
  patient_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true,
    index: true
  },
  medical_center_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicalCenter',
    required: true,
    index: true
  },
  practitioner_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Practitioner',
    required: true,
    index: true
  },
  schedule_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RollingSchedule',
    required: true
  },
  date: {
    type: Date,
    required: true,
    index: true
  },
  slot_id: {
    type: String,
    required: true
  },
  original_slot_id: {
    type: String,
    default: null
  },
  slot_start: {
    type: String,
    required: true
  },
  slot_end: {
    type: String,
    required: true
  },
  doctor_name: {
    type: String,
    required: true
  },
  doctor_role: {
    type: String,
    default: 'Doctor'
  },
  doctor_specialization: {
    type: [String],
    default: []
  },
  patient_name: {
    type: String,
    required: true
  },
  patient_email: {
    type: String,
    required: true
  },
  patient_phone: {
    type: String,
    required: true
  },
  reason_for_visit: {
    type: String,
    required: true
  },
  symptoms: {
    type: String,
    default: ''
  },
  preferred_specialization: {
    type: String,
    required: true
  },
  consultation_type: {
    type: String,
    enum: ['face-to-face', 'telemedicine', 'follow-up'],
    default: 'face-to-face'
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'cancelled', 'completed', 'no-show', 'rescheduled'],
    default: 'pending',
    index: true
  },
  payment_status: {
  type: String,
  enum: ['pending', 'success', 'failed', 'refunded', 'none'],
  default: 'pending',
  index: true
},
payment_reference: {
  type: String,
  default: null
},

is_paid: {
  type: Boolean,
  default: false
},
  notes: {
    type: String,
    default: ''
  },
  cancellation_reason: {
    type: String,
    default: ''
  },
  cancelled_by: {
    type: String,
    enum: ['patient', 'doctor', 'medicalCenter', 'system'],
    default: 'patient'
  },
  cancelled_at: {
    type: Date
  },
  completed_by: {
    type: String,
    enum: ['doctor', 'system'],
    default: 'doctor'
  },
  completed_at: {
    type: Date
  },
  updated_by: {
    type: String,
    enum: ['patient', 'doctor', 'medicalCenter', 'system']
  },
  confirmation_sent: {
    type: Boolean,
    default: false
  },
  reminder_sent: {
    type: Boolean,
    default: false
  },
  appointment_duration: {
    type: Number,
    default: 30
  },
  rating: {
    type: Number,
    min: 1,
    max: 5
  },
  feedback: {
    type: String
  },
  // New fields for slot shifting
  is_shifted_slot: {
    type: Boolean,
    default: false
  },
  shift_notes: {
    type: String,
    default: ''
  },
  original_appointment_time: {
    slot_start: String,
    slot_end: String
  },
  shift_history: [{
    old_slot_start: String,
    old_slot_end: String,
    new_slot_start: String,
    new_slot_end: String,
    shifted_at: Date,
    shifted_by: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'shift_history.shifted_by_type'
    },
    shifted_by_type: {
      type: String,
      enum: ['Practitioner', 'MedicalCenter', 'System']
    },
    reason: String
  }]
}, {
  timestamps: true
});

// Compound indexes for faster queries
appointmentSchema.index({ patient_id: 1, date: 1, status: 1 });
appointmentSchema.index({ medical_center_id: 1, date: 1, status: 1 });
appointmentSchema.index({ practitioner_id: 1, date: 1, status: 1 });
appointmentSchema.index({ schedule_id: 1, slot_id: 1, date: 1 });
appointmentSchema.index({ is_shifted_slot: 1 });
appointmentSchema.index({ 'shift_history.shifted_at': -1 });

// Virtual for formatted date
appointmentSchema.virtual('formatted_date').get(function() {
  return this.date ? this.date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }) : '';
});

// Virtual for appointment time range
appointmentSchema.virtual('time_range').get(function() {
  return `${this.slot_start} - ${this.slot_end}`;
});

// Virtual for original time if shifted
appointmentSchema.virtual('original_time_range').get(function() {
  if (this.original_appointment_time && this.original_appointment_time.slot_start) {
    return `${this.original_appointment_time.slot_start} - ${this.original_appointment_time.slot_end}`;
  }
  return `${this.slot_start} - ${this.slot_end}`;
});

// Method to check if appointment is upcoming
appointmentSchema.methods.isUpcoming = function() {
  const now = new Date();
  const appointmentDateTime = new Date(this.date);
  const [hours, minutes] = this.slot_start.split(':').map(Number);
  appointmentDateTime.setHours(hours, minutes, 0, 0);
  
  return appointmentDateTime > now && this.status === 'confirmed';
};

// Method to check if appointment can be cancelled
appointmentSchema.methods.canBeCancelled = function() {
  if (this.status !== 'pending' && this.status !== 'confirmed') {
    return false;
  }
  
  const now = new Date();
  const appointmentDateTime = new Date(this.date);
  const [hours, minutes] = this.slot_start.split(':').map(Number);
  appointmentDateTime.setHours(hours, minutes, 0, 0);
  
  const timeDifference = appointmentDateTime - now;
  const hoursDifference = timeDifference / (1000 * 60 * 60);
  
  return hoursDifference >= 2;
};

// Method to record a shift
appointmentSchema.methods.recordShift = function(oldStart, oldEnd, newStart, newEnd, shiftedBy, shiftedByType, reason) {
  if (!this.original_appointment_time.slot_start) {
    // First time shifting, record original time
    this.original_appointment_time = {
      slot_start: oldStart,
      slot_end: oldEnd
    };
  }
  
  this.shift_history.push({
    old_slot_start: oldStart,
    old_slot_end: oldEnd,
    new_slot_start: newStart,
    new_slot_end: newEnd,
    shifted_at: new Date(),
    shifted_by: shiftedBy,
    shifted_by_type: shiftedByType,
    reason: reason
  });
  
  this.is_shifted_slot = true;
  this.shift_notes = `Last shifted: ${reason || 'Time adjusted'}`;
  this.slot_start = newStart;
  this.slot_end = newEnd;
};

module.exports = mongoose.model('Appointment', appointmentSchema);