const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const ObjectId = mongoose.Schema.Types.ObjectId;

/* ----------------------------------------------
   SESSION SCHEMA (morning/afternoon/night)
------------------------------------------------*/
const sessionSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: true },
  start: {
    type: String,
    required: true,
    validate: {
      validator: (v) => /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v),
      message: 'Start time must be HH:MM'
    }
  },
  end: {
    type: String,
    required: true,
    validate: {
      validator: (v) => /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v),
      message: 'End time must be HH:MM'
    }
  }
}, { _id: false });

/* ----------------------------------------------
   LUNCH BREAK SCHEMA
------------------------------------------------*/
const lunchBreakSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4 },
  start: {
    type: String,
    validate: (v) => !v || /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v)
  },
  end: {
    type: String,
    validate: (v) => !v || /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v)
  },
  reason: { type: String, default: 'Lunch Break' },
  duration: { type: Number, default: 60 },
  enabled: { type: Boolean, default: true },
  recurring: { type: Boolean, default: false },
  affectedStaff: [{ type: ObjectId, ref: 'Practitioner' }]
}, { _id: false });

/* ----------------------------------------------
   DAY HOURS (sessions + lunches)
------------------------------------------------*/
const dayHoursSchema = new mongoose.Schema({
  morning: {
    type: sessionSchema,
    default: () => ({ start: '08:00', end: '12:00', enabled: true })
  },
  afternoon: {
    type: sessionSchema,
    default: () => ({ start: '13:00', end: '17:00', enabled: true })
  },
  night: {
    type: sessionSchema,
    default: () => ({ start: '18:00', end: '22:00', enabled: false })
  },
  lunches: { type: [lunchBreakSchema], default: [] },
  nightLunches: { type: [lunchBreakSchema], default: [] }
}, { _id: false });

/* ----------------------------------------------
   DEFAULT DAY TEMPLATE HELPER
------------------------------------------------*/
const defaultDayTemplate = (startMorning, endMorning, startAfternoon, endAfternoon, lunchStart, lunchEnd) => ({
  morning: { start: startMorning, end: endMorning, enabled: true },
  afternoon: { start: startAfternoon, end: endAfternoon, enabled: true },
  night: { start: '18:00', end: '22:00', enabled: false },
  lunches: [{
    id: uuidv4(),
    start: lunchStart,
    end: lunchEnd,
    reason: 'Lunch Break',
    duration: 60,
    enabled: true,
    recurring: true,
    affectedStaff: []
  }],
  nightLunches: []
});

/* ----------------------------------------------
   MAIN OPERATIONAL HOURS SCHEMA
------------------------------------------------*/
const defaultOperationalHoursSchema = new mongoose.Schema({
  medical_center_id: {
    type: ObjectId,
    ref: 'MedicalCenter',
    required: true,
    unique: true
  },

  defaultHours: {
    monday:    { type: dayHoursSchema, default: () => defaultDayTemplate('08:00','12:00','13:00','17:00','12:00','13:00') },
    tuesday:   { type: dayHoursSchema, default: () => defaultDayTemplate('08:00','12:00','13:00','17:00','12:00','13:00') },
    wednesday: { type: dayHoursSchema, default: () => defaultDayTemplate('08:00','12:00','13:00','17:00','12:00','13:00') },
    thursday:  { type: dayHoursSchema, default: () => defaultDayTemplate('08:00','12:00','13:00','17:00','12:00','13:00') },
    friday:    { type: dayHoursSchema, default: () => defaultDayTemplate('08:00','12:00','13:00','17:00','12:00','13:00') },

    saturday: {
      type: dayHoursSchema,
      default: () => defaultDayTemplate('09:00','13:00','14:00','18:00','13:00','14:00')
    },

    sunday: {
      type: dayHoursSchema,
      default: () => ({
        morning: { start: '10:00', end: '14:00', enabled: false },
        afternoon:{ start: '15:00', end: '19:00', enabled: false },
        night:    { start: '20:00', end: '23:00', enabled: false },
        lunches: [],
        nightLunches: []
      })
    }
  },

  slotDuration: { type: Number, default: 30, min: 5, max: 120 },
  bufferTime:   { type: Number, default: 0, min: 0, max: 60 },

  created_by: { type: ObjectId, ref: 'MedicalCenter', required: true },
  last_updated_by: { type: ObjectId, ref: 'MedicalCenter', required: true }
},
{
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

/* ----------------------------------------------
   FIXED STATIC METHOD (no req inside model)
------------------------------------------------*/
defaultOperationalHoursSchema.statics.findOrCreate = async function(medicalCenterId, userId) {
  let record = await this.findOne({ medical_center_id: medicalCenterId });

  if (!record) {
    record = await this.create({
      medical_center_id: medicalCenterId,
      created_by: userId,
      last_updated_by: userId
      // all defaults come from schema
    });
  }

  return record;
};

/* ----------------------------------------------
   TIME CONFLICT VALIDATION
------------------------------------------------*/
defaultOperationalHoursSchema.methods.doTimeRangesOverlap = function(s1, e1, s2, e2) {
  const toMin = (t) => {
    const [h,m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  return toMin(s1) < toMin(e2) && toMin(e1) > toMin(s2);
};

defaultOperationalHoursSchema.methods.validateTimeConflicts = function(day) {
  const d = this.defaultHours[day];
  const sessions = [d.morning, d.afternoon, d.night];

  for (let i = 0; i < sessions.length; i++) {
    for (let j = i+1; j < sessions.length; j++) {
      if (
        sessions[i].enabled &&
        sessions[j].enabled &&
        this.doTimeRangesOverlap(sessions[i].start, sessions[i].end, sessions[j].start, sessions[j].end)
      ) return false;
    }
  }
  return true;
};

/* ----------------------------------------------
   EXPORT MODEL
------------------------------------------------*/
module.exports = mongoose.model('DefaultOperationalHours', defaultOperationalHoursSchema);
