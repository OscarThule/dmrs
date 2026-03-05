const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const patientSchema = new mongoose.Schema(
  {
    patient_id: {
      type: String,
      unique: true,
      immutable: true,
      index: true, // fast lookups
    },

    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
    },

    lastName: {
      type: String,
      required: [true, 'Last name is required'],
      trim: true,
    },

    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      index: true, // IMPORTANT for login speed
      lowercase: true,
      trim: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
        'Please provide a valid email',
      ],
    },

    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
    },

    idNumber: {
      type: String,
      required: [true, 'ID number is required'],
      unique: true,
      index: true, // IMPORTANT for login speed
      trim: true,
    },

    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 6,
      select: false, // keep hidden by default
    },

    resetPasswordToken: { type: String, index: true },
    resetPasswordExpire: { type: Date, index: true },

    address: {
      type: String,
      required: [true, 'Address is required'],
      trim: true,
    },

    dateOfBirth: {
      type: Date,
      required: [true, 'Date of birth is required'],
    },

    gender: {
      type: String,
      enum: ['Male', 'Female', 'Other'],
      required: [true, 'Gender is required'],
    },

    emergencyContact: {
      type: String,
      required: [true, 'Emergency contact is required'],
      trim: true,
    },

    medicalCenters: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MedicalCenter',
      },
    ],

    medicalHistory: { type: String, default: '' },
    allergies: { type: String, default: '' },
    currentMedications: { type: String, default: '' },
  },
  {
    timestamps: true, // automatically adds createdAt and updatedAt
  }
);

// Ensure patient_id exists
patientSchema.pre('validate', function (next) {
  if (!this.patient_id) {
    this.patient_id = `PAT-${uuidv4()}`;
  }
  next();
});

// Hash password when changed
patientSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    const saltRounds = Number(process.env.BCRYPT_ROUNDS || 10); // keep 10 unless you know what you're doing
    const salt = await bcrypt.genSalt(saltRounds);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// If you update password using findOneAndUpdate/updateOne, hash it too
async function hashPasswordInUpdate(next) {
  const update = this.getUpdate();
  if (!update) return next();

  const password =
    update.password ||
    (update.$set && update.$set.password) ||
    (update.$unset && update.$unset.password);

  if (!password || typeof password !== 'string') return next();

  const saltRounds = Number(process.env.BCRYPT_ROUNDS || 10);
  const salt = await bcrypt.genSalt(saltRounds);
  const hashed = await bcrypt.hash(password, salt);

  if (update.password) update.password = hashed;
  if (update.$set && update.$set.password) update.$set.password = hashed;

  next();
}

patientSchema.pre('findOneAndUpdate', hashPasswordInUpdate);
patientSchema.pre('updateOne', hashPasswordInUpdate);
patientSchema.pre('updateMany', hashPasswordInUpdate);

// Compare password method
patientSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('Patient', patientSchema);