const mongoose = require('mongoose');

const shiftHistorySchema = new mongoose.Schema(
  {
    old_slot_start: { type: String },
    old_slot_end: { type: String },
    new_slot_start: { type: String },
    new_slot_end: { type: String },
    shifted_at: { type: Date, default: Date.now },
    shifted_by: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'shift_history.shifted_by_type'
    },
    shifted_by_type: {
      type: String,
      enum: ['Practitioner', 'MedicalCenter', 'System']
    },
    reason: { type: String, default: '' }
  },
  { _id: false }
);

const appointmentSchema = new mongoose.Schema(
  {
    appointment_id: {
      type: String,
      required: true,
      unique: true,
      trim: true
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
      required: true,
      trim: true
    },

    original_slot_id: {
      type: String,
      default: null,
      trim: true
    },

    slot_start: {
      type: String,
      required: true,
      trim: true
    },

    slot_end: {
      type: String,
      required: true,
      trim: true
    },

    doctor_name: {
      type: String,
      required: true,
      trim: true
    },

    doctor_role: {
      type: String,
      default: 'Doctor',
      trim: true
    },

    doctor_specialization: {
      type: [String],
      default: []
    },

    patient_name: {
      type: String,
      required: true,
      trim: true
    },

    patient_email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },

    patient_phone: {
      type: String,
      required: true,
      trim: true
    },

    reason_for_visit: {
      type: String,
      required: true,
      trim: true
    },

    symptoms: {
      type: String,
      default: '',
      trim: true
    },

    preferred_specialization: {
      type: String,
      required: true,
      trim: true
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
      default: null,
      trim: true
    },

    is_paid: {
      type: Boolean,
      default: false
    },

    consultation_fee: {
      type: Number,
      default: 0,
      min: 0
    },

    deposit_amount: {
      type: Number,
      default: 0,
      min: 0
    },

    platform_fee: {
      type: Number,
      default: 0,
      min: 0
    },

    total_amount: {
      type: Number,
      default: 0,
      min: 0
    },

    currency: {
      type: String,
      default: 'ZAR',
      trim: true
    },

    payment_required: {
      type: Boolean,
      default: true
    },

    payment_amount_paid: {
      type: Number,
      default: 0,
      min: 0
    },

    notes: {
      type: String,
      default: '',
      trim: true
    },

    cancellation_reason: {
      type: String,
      default: '',
      trim: true
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
      default: 30,
      min: 1
    },

    rating: {
      type: Number,
      min: 1,
      max: 5
    },

    feedback: {
      type: String,
      trim: true
    },

    is_shifted_slot: {
      type: Boolean,
      default: false
    },

    shift_notes: {
      type: String,
      default: '',
      trim: true
    },

    original_appointment_time: {
      slot_start: { type: String, default: null },
      slot_end: { type: String, default: null }
    },

    shift_history: {
      type: [shiftHistorySchema],
      default: []
    }
  },
  {
    timestamps: true
  }
);

// Indexes
appointmentSchema.index({ patient_id: 1, date: 1, status: 1 });
appointmentSchema.index({ medical_center_id: 1, date: 1, status: 1 });
appointmentSchema.index({ practitioner_id: 1, date: 1, status: 1 });
appointmentSchema.index({ schedule_id: 1, slot_id: 1, date: 1 });
appointmentSchema.index({ payment_reference: 1 });
appointmentSchema.index({ payment_status: 1, status: 1 });
appointmentSchema.index({ is_shifted_slot: 1 });
appointmentSchema.index({ 'shift_history.shifted_at': -1 });

// Virtuals
appointmentSchema.virtual('formatted_date').get(function () {
  return this.date
    ? this.date.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
    : '';
});

appointmentSchema.virtual('time_range').get(function () {
  return `${this.slot_start} - ${this.slot_end}`;
});

appointmentSchema.virtual('original_time_range').get(function () {
  if (this.original_appointment_time?.slot_start) {
    return `${this.original_appointment_time.slot_start} - ${this.original_appointment_time.slot_end}`;
  }
  return `${this.slot_start} - ${this.slot_end}`;
});

// Methods
appointmentSchema.methods.isUpcoming = function () {
  const now = new Date();
  const appointmentDateTime = new Date(this.date);
  const [hours, minutes] = this.slot_start.split(':').map(Number);

  appointmentDateTime.setHours(hours, minutes, 0, 0);

  return appointmentDateTime > now && this.status === 'confirmed';
};

appointmentSchema.methods.canBeCancelled = function () {
  if (!['pending', 'confirmed'].includes(this.status)) {
    return false;
  }

  const now = new Date();
  const appointmentDateTime = new Date(this.date);
  const [hours, minutes] = this.slot_start.split(':').map(Number);

  appointmentDateTime.setHours(hours, minutes, 0, 0);

  const hoursDifference = (appointmentDateTime - now) / (1000 * 60 * 60);

  return hoursDifference >= 2;
};

appointmentSchema.methods.recordShift = function (
  oldStart,
  oldEnd,
  newStart,
  newEnd,
  shiftedBy,
  shiftedByType,
  reason
) {
  if (!this.original_appointment_time?.slot_start) {
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
    reason: reason || ''
  });

  this.is_shifted_slot = true;
  this.shift_notes = `Last shifted: ${reason || 'Time adjusted'}`;
  this.slot_start = newStart;
  this.slot_end = newEnd;
};

module.exports = mongoose.model('Appointment', appointmentSchema);