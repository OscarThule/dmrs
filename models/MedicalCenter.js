const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// -----------------------
// Address Schema
// -----------------------
const addressSchema = new mongoose.Schema({
  // user-entered fields
  line1: { type: String, required: true, trim: true },
  line2: { type: String, default: '', trim: true },
  city: { type: String, required: true, trim: true },
  province: { type: String, required: true, trim: true },
  postal: { type: String, required: true, trim: true },

  // system-generated fields
  full_address: { type: String, default: '', trim: true },
  formatted_address: { type: String, default: '', trim: true },
  place_id: { type: String, default: '', trim: true },

  lat: { type: Number, default: null },
  lng: { type: Number, default: null },

  location_source: {
    type: String,
    enum: ['address', 'geolocation', 'address_and_geolocation'],
    default: 'address'
  },

  is_location_verified: {
    type: Boolean,
    default: false
  }
}, { _id: false });
 
// -----------------------
// Payment Settings Schema
// -----------------------
const paymentSettingsSchema = new mongoose.Schema({
  enablePayments: { type: Boolean, default: false },

  consultationFee: { type: Number, default: 0 },        // Full consultation price
  bookingDeposit: { type: Number, default: 0 },          // Fixed amount deposit
  depositPercentage: { type: Number, default: 0 },       // Optional % mode
  remainingAmount: { type: Number, default: 0 },

  onlineConsultationFee: { type: Number, default: 0 },

  allowPartialPayments: { type: Boolean, default: false },

  paymentMethods: {
    type: [String],
    enum: ['credit_card', 'debit_card', 'cash', 'insurance', 'eft'],
    default: ['cash']
  },

  currency: { type: String, default: 'ZAR' },
  lastUpdated: { type: Date, default: Date.now }
});


// -----------------------
// Practitioner Schema
// -----------------------
const practitionerSchema = new mongoose.Schema({
  practitioner_id: { type: String, default: uuidv4 },

  full_name: { type: String, default: '', trim: true },

  role: {
    type: String,
    enum: ['doctor', 'nurse', 'clinical_manager', 'admin', 'receptionist', 'technician', ''],
    default: ''
  },

  professional_license_number: { type: String, default: '', trim: true },

  license_type: {
    type: String,
    enum: ['HPCSA', 'SANC', 'other'],
    default: 'HPCSA'
  },

  license_doc_url: { type: String, default: '', trim: true },

  contact_email: { type: String, default: '', trim: true },

  contact_phone: { type: String, default: '', trim: true },

  verification_status: {
    type: String,
    enum: ['unverified', 'pending', 'verified', 'rejected'],
    default: 'unverified'
  },

  is_active: { type: Boolean, default: true },

  specialties: { type: [String], default: [] },

  added_at: { type: Date, default: Date.now },
  last_updated: { type: Date, default: Date.now }
}, { _id: true });

// -----------------------
// Operational Hours Schema
// -----------------------
const operationalHoursSchema = new mongoose.Schema({
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
  lunches: [{
    id: { type: String, default: uuidv4 },
    start: String,
    end: String,
    reason: String,
    duration: Number,
    enabled: { type: Boolean, default: true },
    recurring: { type: Boolean, default: false },
    affectedStaff: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Practitioner' }]
  }],
  nightLunches: [{
    id: { type: String, default: uuidv4 },
    start: String,
    end: String,
    reason: String,
    duration: Number,
    enabled: { type: Boolean, default: true },
    recurring: { type: Boolean, default: false },
    affectedStaff: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Practitioner' }]
  }],
  enabled: { type: Boolean, default: true }
});

// -----------------------
// Medical Center Schema
// -----------------------
const medicalCenterSchema = new mongoose.Schema({
  // Unique identifier
  medical_center_id: { type: String, default: uuidv4 },
  
  // Parent relationship - null for main center, ObjectId for branches
  parent_center_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicalCenter',
    default: null
  },

  paymentSettings: {
  type: paymentSettingsSchema,
  default: () => ({})
},

  
  // Basic Information
  facility_name: { type: String, required: true },
  company_reg_number: { type: String, required: true },
  healthcare_reg_number: { type: String, required: true },
  facility_type: {
    type: String,
    enum: ['surgery', 'clinic', 'hospital', 'community_health', 'mobile_unit', 'other'],
    required: true
  },
  description: String,
  website: String,
  
  // Authentication
  official_domain_email: { type: String, required: true },
  phone: { type: String, required: true },
  password: { type: String, required: true, select: false },
  
  // Password Reset
resetPasswordToken: { type: String },
resetPasswordExpire: { type: Date },

  // Location
  address: {
  type: addressSchema,
  required: true
},
  // Practitioners (can work at this center/branch)
  practitioners: [practitionerSchema],
  
  // References to external practitioner documents
  practitionerReferences: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Practitioner'
  }],
  
  // Schedules
  weeklySchedules: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WeeklySchedule'
  }],
  
  // -----------------------
// Paystack Subaccount & Bank Details
// -----------------------
paystack: {
  subaccount_code: {
    type: String,
    default: null,
    
  },

  is_subaccount_active: {
    type: Boolean,
    default: false
  },

  bank_details: {
    bank_name: { type: String },
    bank_code: { type: String }, // Paystack bank code (IMPORTANT)
    account_number: { type: String },
    account_name: { type: String }
  },

  created_at: { type: Date },
  updated_at: { type: Date }
},

  // Operational Hours for this center/branch
  defaultOperationalHours: [operationalHoursSchema],
  
  // Settings specific to this center/branch
  settings: {
    slotDuration: { type: Number, default: 30 },
    bufferTime: { type: Number, default: 0 },
    maxDoctorsPerSlot: { type: Number, default: 2 },
    availableDoctorsDay: { type: Number, default: 8 },
    availableDoctorsNight: { type: Number, default: 2 },
    maxFaceToFace: { type: Number, default: 6 },
    maxOnline: { type: Number, default: 4 },
    maxDailyAppointments: { type: Number, default: 100 },
    bookingLeadTime: { type: Number, default: 30 },
    maxRescheduleAttempts: { type: Number, default: 2 },
    autoCancelUnconfirmed: { type: Number, default: 2 },
    allowAutomaticRescheduling: { type: Boolean, default: true },

    consultationCosts: {
      government: { faceToFace: { type: Number, default: 0 }, online: { type: Number, default: 0 } },
      private: { faceToFace: { type: Number, default: 500 }, online: { type: Number, default: 300 } },
      effectiveFrom: { type: Date, default: Date.now },
      history: [{
        government: { faceToFace: Number, online: Number },
        private: { faceToFace: Number, online: Number },
        effectiveFrom: Date,
        effectiveUntil: Date
      }]
    },

    peakHours: {
      morning: { start: { type: String, default: '09:00' }, end: { type: String, default: '11:00' }, multiplier: { type: Number, default: 1.2 } },
      afternoon: { start: { type: String, default: '14:00' }, end: { type: String, default: '16:00' }, multiplier: { type: Number, default: 1.2 } }
    },

    nonWorkingDates: [{ date: Date, reason: String, recurring: { type: Boolean, default: false } }]
  },

  // Status & Verification
  is_verified: { type: Boolean, default: false },
  is_active: { type: Boolean, default: true },
  verification_status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected', 'needs_review'], 
    default: 'pending' 
  },
  
  // Admin Contact for this center/branch
  admin_contact: { 
    name: String, 
    email: String, 
    phone: String, 
    position: String 
  },
  
  // Billing (can be separate or shared with parent)
  billing: {
    plan: { type: String, enum: ['basic', 'professional', 'enterprise'], default: 'basic' },
    subscription_id: String,
    status: { type: String, enum: ['active', 'inactive', 'suspended', 'cancelled'], default: 'active' },
    next_billing_date: Date,
    payment_method: { type: String, enum: ['card', 'bank_transfer', 'other'] },
    is_shared_with_parent: { type: Boolean, default: false }
  },

  // Statistics for this center/branch
  statistics: { 
    total_patients: { type: Number, default: 0 }, 
    total_appointments: { type: Number, default: 0 }, 
    monthly_appointments: { type: Number, default: 0 }, 
    average_rating: { type: Number, default: 0 }, 
    response_time: { type: Number, default: 0 } 
  },

  // Timestamps
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
  verified_at: Date,
  last_login: Date,
  
  // Branding (can be different per branch)
  logo_url: String,
  theme_colors: {
    primary: { type: String, default: '#3B82F6' },
    secondary: { type: String, default: '#10B981' }
  }
});

// -----------------------
// Pre-save hooks
// -----------------------
medicalCenterSchema.pre('save', function(next) {
  this.updated_at = Date.now();
  next();
});

medicalCenterSchema.pre('save', async function(next) {
  if (this.isModified('official_domain_email') || this.isModified('company_reg_number') || this.isModified('healthcare_reg_number')) {
    const MedicalCenter = mongoose.model('MedicalCenter');
    const existing = await MedicalCenter.findOne({
      $or: [
        { official_domain_email: this.official_domain_email },
        { company_reg_number: this.company_reg_number },
        { healthcare_reg_number: this.healthcare_reg_number }
      ],
      _id: { $ne: this._id }
    });
    if (existing) {
      const error = new Error('Medical center with this email, company registration, or healthcare license already exists');
      return next(error);
    }
  }
  next();
});

// -----------------------
// Static Methods
// -----------------------
medicalCenterSchema.statics.findByEmail = function(email) {
  return this.findOne({ official_domain_email: email });
};

medicalCenterSchema.statics.findActive = function() {
  return this.find({ is_active: true, is_verified: true });
};

medicalCenterSchema.statics.findMainCenters = function() {
  return this.find({ parent_center_id: null });
};

medicalCenterSchema.statics.findBranches = function(parentId) {
  return this.find({ parent_center_id: parentId });
};

// -----------------------
// Instance Methods
// -----------------------
medicalCenterSchema.methods.getFullAddress = function() {
  const addr = this.address || {};
  return (
    addr.formatted_address ||
    addr.full_address ||
    `${addr.line1 || ''}${addr.line2 ? ', ' + addr.line2 : ''}${addr.city ? ', ' + addr.city : ''}${addr.province ? ', ' + addr.province : ''}${addr.postal ? ', ' + addr.postal : ''}`
  );
};

medicalCenterSchema.methods.addPractitioner = function(practitionerData) {
  this.practitioners.push(practitionerData);
  return this.save();
};

medicalCenterSchema.methods.removePractitioner = function(practitionerId) {
  this.practitioners = this.practitioners.filter(
    p => p.practitioner_id !== practitionerId
  );
  return this.save();
};

medicalCenterSchema.methods.getBranches = async function() {
  return await mongoose.model('MedicalCenter').find({ 
    parent_center_id: this._id 
  });
};

medicalCenterSchema.methods.getParent = async function() {
  if (!this.parent_center_id) return null;
  return await mongoose.model('MedicalCenter').findById(this.parent_center_id);
};

medicalCenterSchema.methods.isMainCenter = function() {
  return !this.parent_center_id;
};

medicalCenterSchema.methods.isBranch = function() {
  return !!this.parent_center_id;
};

medicalCenterSchema.methods.getHierarchy = async function() {
  const hierarchy = [];
  let current = this;
  
  // Go up to main center
  while (current) {
    hierarchy.unshift({
      _id: current._id,
      medical_center_id: current.medical_center_id,
      facility_name: current.facility_name,
      is_main: !current.parent_center_id
    });
    
    if (current.parent_center_id) {
      current = await mongoose.model('MedicalCenter').findById(current.parent_center_id);
    } else {
      current = null;
    }
  }
  
  return hierarchy;
};

// -----------------------
// Virtuals
// -----------------------
medicalCenterSchema.virtual('totalPractitioners').get(function() {
  return Array.isArray(this.practitioners) ? this.practitioners.length : 0;
});

medicalCenterSchema.virtual('branchCount').get(async function() {
  if (this.isBranch()) return 0;
  const count = await mongoose.model('MedicalCenter').countDocuments({
    parent_center_id: this._id,
    is_active: true
  });
  return count;
});

// -----------------------
// Query Helpers
// -----------------------
medicalCenterSchema.query.byParent = function(parentId) {
  return this.where({ parent_center_id: parentId });
};

medicalCenterSchema.query.mainCenters = function() {
  return this.where({ parent_center_id: null });
};

medicalCenterSchema.query.branches = function() {
  return this.where({ parent_center_id: { $ne: null } });
};

// -----------------------
// Indexes
// -----------------------
medicalCenterSchema.index({ official_domain_email: 1 }, { unique: true });
medicalCenterSchema.index({ company_reg_number: 1 }, { unique: true });
medicalCenterSchema.index({ healthcare_reg_number: 1 }, { unique: true });
medicalCenterSchema.index({ medical_center_id: 1 }, { unique: true });
medicalCenterSchema.index({ parent_center_id: 1 });
medicalCenterSchema.index({ parent_center_id: 1, is_active: 1 });
medicalCenterSchema.index({ is_verified: 1, is_active: 1 });
medicalCenterSchema.index({ 'address.city': 1, 'address.province': 1 });
medicalCenterSchema.index({ facility_type: 1 });
medicalCenterSchema.index({ created_at: -1 });
medicalCenterSchema.index({ 
  facility_name: 'text', 
  'address.line1': 'text', 
  'address.city': 'text', 
  'address.province': 'text' 
});

// -----------------------
module.exports = mongoose.model('MedicalCenter', medicalCenterSchema);