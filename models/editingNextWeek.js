// models/editingNextWeek.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// ============ HELPER FUNCTIONS ============
const getCurrentWindow = () => {
  const now = new Date();

  const windowStart = now;
  const windowEnd = new Date(
    now.getTime() + 21 * 24 * 60 * 60 * 1000
  );

  return { windowStart, windowEnd };
};

const isInRollingWindow = (date) => {
  const { windowStart, windowEnd } = getCurrentWindow();
  const target = new Date(date);
  return target >= windowStart && target < windowEnd;
};

const generateDoctorColor = (doctorId) => {
  const colors = [
    '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444',
    '#06B6D4', '#EC4899', '#84CC16', '#F97316', '#6366F1'
  ];
  let hash = 0;
  for (let i = 0; i < doctorId.length; i++) {
    hash = doctorId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

const generateTimeSlots = (daySchedule, slotDuration = 30) => {
  const slots = [];
  
  const generateSlotsForSession = (start, end, type = 'working') => {
    const [startHour, startMin] = start.split(':').map(Number);
    const [endHour, endMin] = end.split(':').map(Number);
    
    let current = new Date();
    current.setHours(startHour, startMin, 0, 0);
    const endTime = new Date();
    endTime.setHours(endHour, endMin, 0, 0);
    
    if (endHour < startHour && endHour !== 0) {
      endTime.setDate(endTime.getDate() + 1);
    }
    
    while (current < endTime) {
      const slotEnd = new Date(current.getTime() + slotDuration * 60000);
      
      if (slotEnd > endTime) break;
      
      const slotTime = current.getHours() * 60 + current.getMinutes();
      const isPeakHour = (slotTime >= 9 * 60 && slotTime < 11 * 60) || 
                        (slotTime >= 14 * 60 && slotTime < 16 * 60);
      
      slots.push({
        id: new mongoose.Types.ObjectId().toString(),
        start: current.toTimeString().slice(0, 5),
        end: slotEnd.toTimeString().slice(0, 5),
        capacity: 0,
        assignedDoctors: [],
        availableCapacity: 0,
        type: type,
        slotType: type === 'working' ? 'standard' : type,
        duration: slotDuration,
        isShifted: false,
        isPeakHour,
        specialization: 'general',
        specializations: ['general'],
        consultationType: 'face-to-face',
        originalTiming: null,
        shiftedFrom: null,
        shiftHistory: []
      });
      
      current = new Date(slotEnd.getTime());
    }
  };
  
  // Generate slots for each enabled session
  if (daySchedule.sessions?.morning?.enabled) {
    generateSlotsForSession(
      daySchedule.sessions.morning.start,
      daySchedule.sessions.morning.end,
      'working'
    );
  }
  
  if (daySchedule.sessions?.afternoon?.enabled) {
    generateSlotsForSession(
      daySchedule.sessions.afternoon.start,
      daySchedule.sessions.afternoon.end,
      'working'
    );
  }
  
  if (daySchedule.sessions?.night?.enabled) {
    // Generate night shift slots
    generateSlotsForSession('18:00', '22:00', 'night-shift');
    generateSlotsForSession('23:00', '08:00', 'night-shift');
  }
  
  return slots;
};

const recalculateDailyScheduleTotals = (daySchedule) => {
  if (!daySchedule.timeSlots) {
    daySchedule.timeSlots = [];
  }
  
  // Calculate total capacity
  daySchedule.totalCapacity = daySchedule.timeSlots.reduce(
    (sum, slot) => sum + slot.capacity, 0
  );
  
  // Collect unique doctor IDs
  const assignedDoctorIds = new Set();
  daySchedule.timeSlots.forEach(slot => {
    if (slot.assignedDoctors) {
      slot.assignedDoctors.forEach(doc => {
        if (doc.doctorId) {
          assignedDoctorIds.add(doc.doctorId.toString());
        }
      });
    }
  });
  
  daySchedule.assignedDoctors = Array.from(assignedDoctorIds);
  
  // Recalculate available capacity for each slot
  daySchedule.timeSlots.forEach(slot => {
    const assignedCapacity = slot.assignedDoctors.reduce(
      (sum, doc) => sum + (doc.maxPatients || 1), 0
    );
    slot.capacity = assignedCapacity;
    slot.availableCapacity = Math.max(0, assignedCapacity - (slot.assignedDoctors.reduce(
      (sum, doc) => sum + (doc.currentPatients || 0), 0
    )));
  });
};

const generateDefaultWindow = (medicalCenterId) => {
  const { windowStart, windowEnd } = getCurrentWindow();

  const dailySchedules = [];
  for (let i = 0; i < 21; i++) {
    // ⚠️ MIDDAY to avoid timezone shift
    const base = new Date(windowStart);
    base.setHours(12, 0, 0, 0);
    base.setDate(base.getDate() + i);

    // ✅ STRING calendar date
    const dateString = base.toISOString().slice(0, 10);

    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayOfWeek = base.getDay();
    const dayName = days[dayOfWeek];
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    const timeSlots = isWeekend ? [] : generateTimeSlots({
      sessions: {
        morning: { start: '09:00', end: '12:00', enabled: true },
        afternoon: { start: '13:00', end: '17:00', enabled: true },
        night: { start: '18:00', end: '20:00', enabled: false }
      }
    }, 30);

    dailySchedules.push({
      date: dateString,            // ✅ FIXED
      dayName,
      dayOfWeek,
      isWorking: !isWeekend,
      is24Hours: false,
      timeSlots,
      lunchBreaks: [{
        id: new mongoose.Types.ObjectId().toString(),
        start: '12:00',
        end: '13:00',
        reason: 'Lunch Break',
        duration: 60,
        enabled: true,
        recurring: true,
        affectedStaff: [],
        type: 'lunch'
      }],
      sessions: {
        morning: { start: '09:00', end: '12:00', enabled: !isWeekend },
        afternoon: { start: '13:00', end: '17:00', enabled: !isWeekend },
        night: { start: '18:00', end: '20:00', enabled: false }
      },
      doctorAssignments: [],
      doctorSchedules: [],
      totalCapacity: timeSlots.reduce((sum, slot) => sum + slot.capacity, 0),
      assignedDoctors: [],
      availableSpecializations: ['general'],
      defaultSlotCapacity: 0,
      slotDuration: 30,
      bufferTime: 5,
      maxDoctorsPerSlot: 1000,
      isReadOnly: false
    });
  }

  return {
    schedule_id: `ROLLING-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    medical_center_id: medicalCenterId,
    windowStart,
    windowEnd,
    dailySchedules,
    historicalDays: [],
    assignedDoctors: [],
    isActive: true,
    defaultDoctors: [],
    slotDuration: 30,
    bufferTime: 5,
    maxDoctorsPerSlot: 100,
    lateArrivals: [],
    createdBy: medicalCenterId,
    updatedBy: medicalCenterId
  };
};

// ============ SUB-SCHEMAS ============
const ShiftHistorySchema = new mongoose.Schema({
  oldStart: String,
  oldEnd: String,
  newStart: String,
  newEnd: String,
  shiftedAt: { type: Date, default: Date.now },
  shiftedBy: { type: mongoose.Schema.Types.ObjectId },
  shiftedByType: { type: String, enum: ['doctor', 'Practitioner','medicalCenter', 'system'] },
  reason: String,
  delayMinutes: Number
}, { _id: false });

const DoctorAssignmentSchema = new mongoose.Schema({
  doctorId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Practitioner'
  },
  doctorName: { 
    type: String 
  },
  consultationType: { 
    type: String, 
    enum: ['face-to-face', 'online'],
    default: 'face-to-face'
  },
  specialization: [{
    type: String
  }],
  maxPatients: { 
    type: Number, 
    default: 1 
  },
  currentPatients: { 
    type: Number, 
    default: 0 
  },
  isAvailable: { 
    type: Boolean, 
    default: true 
  },
  colorCode: { 
    type: String 
  },
  isShifted: { 
    type: Boolean, 
    default: false 
  },
  shiftReason: { 
    type: String 
  },
  shiftHistory: [ShiftHistorySchema]
}, { _id: false });

const TimeSlotSchema = new mongoose.Schema({
  id: { 
    type: String,
    default: () => new mongoose.Types.ObjectId().toString()
  },
  start: { 
    type: String,
    required: true
  },
  end: { 
    type: String,
    required: true
  },
  capacity: { 
    type: Number, 
    default: 0,
    min: 0
  },
  assignedDoctors: {
    type: [DoctorAssignmentSchema],
    default: []
  },
  availableCapacity: { 
    type: Number, 
    default: 0
  },
  type: { 
    type: String, 
    enum: ['working', 'night-shift', 'regular', 'emergency', 'procedure'],
    default: 'working'
  },
  slotType: { 
    type: String,
    default: 'regular'
  },
  duration: { 
    type: Number, 
    default: 30,
    min: 5,
    max: 120
  },
  isShifted: { 
    type: Boolean, 
    default: false 
  },
  originalTiming: {
    start: String,
    end: String
  },
  shiftedFrom: { 
    type: String 
  },
  shiftHistory: [ShiftHistorySchema],
  isPeakHour: { 
    type: Boolean, 
    default: false 
  },
  specialization: { 
    type: String,
    default: 'general'
  },
  specializations: [{ 
    type: String,
    default: ['general']
  }],
  consultationType: { 
    type: String,
    default: 'face-to-face'
  }
}, { _id: false });

const LunchBreakSchema = new mongoose.Schema({
  id: { 
    type: String,
    default: () => new mongoose.Types.ObjectId().toString()
  },
  start: { 
    type: String,
    required: true
  },
  end: { 
    type: String,
    required: true
  },
  reason: { 
    type: String,
    default: 'Lunch Break'
  },
  duration: { 
    type: Number,
    default: 60
  },
  enabled: { 
    type: Boolean, 
    default: true 
  },
  recurring: { 
    type: Boolean, 
    default: false 
  },
  affectedStaff: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Practitioner' 
  }],
  type: {
    type: String,
    enum: ['lunch', 'night-lunch'],
    default: 'lunch'
  }
}, { _id: false });

const SessionSchema = new mongoose.Schema({
  start: { 
    type: String,
    default: '09:00'
  },
  end: { 
    type: String,
    default: '17:00'
  },
  enabled: { 
    type: Boolean, 
    default: true 
  }
}, { _id: false });

const DailyScheduleSchema = new mongoose.Schema({
  date: { 
    type: Date,
    required: true,
    index: true
  },
  dayName: { 
    type: String,
    required: true
  },
  dayOfWeek: { 
    type: Number,
    required: true,
    min: 0,
    max: 6
  },
  isWorking: { 
    type: Boolean, 
    default: true 
  },
  is24Hours: { 
    type: Boolean, 
    default: false 
  },
  timeSlots: {
    type: [TimeSlotSchema],
    default: []
  },
  lunchBreaks: {
    type: [LunchBreakSchema],
    default: []
  },
  sessions: {
    morning: {
      type: SessionSchema,
      default: () => ({ start: '09:00', end: '12:00', enabled: true })
    },
    afternoon: {
      type: SessionSchema,
      default: () => ({ start: '13:00', end: '17:00', enabled: true })
    },
    night: {
      type: SessionSchema,
      default: () => ({ start: '18:00', end: '20:00', enabled: false })
    }
  },
  doctorAssignments: [DoctorAssignmentSchema],
  doctorSchedules: [{
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Practitioner' },
    availableSlots: [Number],
    notes: String
  }],
  totalCapacity: { 
    type: Number, 
    default: 0 
  },
  assignedDoctors: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Practitioner' 
  }],
  availableSpecializations: [{ 
    type: String,
    default: ['general']
  }],
  defaultSlotCapacity: {
    type: Number,
    default: 0,
    min: 1
  },
  slotDuration: {
    type: Number,
    default: 30,
    min: 5,
    max: 120
  },
  bufferTime: {
    type: Number,
    default: 5
  },
  maxDoctorsPerSlot: {
    type: Number,
    default: 1000,
    min: 1
  },
  isReadOnly: {
    type: Boolean,
    default: false
  }
});

const DefaultDoctorSchema = new mongoose.Schema({
  doctorId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Practitioner',
    required: true
  },
  doctorName: { 
    type: String,
    required: true
  },
  specializations: [{ 
    type: String,
    default: ['general']
  }],
  defaultSlots: [{
    dayOfWeek: Number,
    session: String,
    start: String,
    end: String
  }],
  availability: {
    type: Map,
    of: {
      morning: Boolean,
      afternoon: Boolean,
      night: Boolean
    },
    default: () => new Map()
  },
  color: { 
    type: String,
    default: function() {
      return generateDoctorColor(this.doctorId?.toString() || 'default');
    }
  }
}, { _id: false });

const LateArrivalSchema = new mongoose.Schema({
  doctorId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Practitioner'
  },
  doctorName: { 
    type: String 
  },
  date: { 
    type: Date 
  },
  duration: { 
    type: Number 
  },
  reason: { 
    type: String 
  },
  timestamp: { 
    type: Date, 
    default: Date.now 
  },
  affectedSlots: [{
    slotId: String,
    oldStart: String,
    oldEnd: String,
    newStart: String,
    newEnd: String
  }],
  affectedAppointments: [{
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    patientName: String
  }]
}, { _id: false });

// Historical day schema for past dates
const HistoricalDaySchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true
  },
  dailySchedule: DailyScheduleSchema,
  isReadOnly: {
    type: Boolean,
    default: true
  }
}, { _id: false });

// ============ MAIN ROLLING SCHEDULE SCHEMA ============
const RollingScheduleSchema = new mongoose.Schema({
  schedule_id: { 
    type: String, 
    unique: true 
  },
  medical_center_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'MedicalCenter',
    required: [true, 'Medical center ID is required']
  },
  
  // Rolling window dates
  windowStart: {
    type: Date,
    required: true,
    index: true
  },
  windowEnd: {
    type: Date,
    required: true,
    index: true
  },
  
  // Current 21-day window schedules
  dailySchedules: {
    type: [DailyScheduleSchema],
    default: [],
    validate: {
      validator: function(dailySchedules) {
        return dailySchedules.length <= 21;
      },
      message: 'Daily schedules cannot exceed 21 days'
    }
  },
  
  // Historical data (read-only)
  historicalDays: {
    type: [HistoricalDaySchema],
    default: []
  },
  
  assignedDoctors: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Practitioner' 
  }],
  
  isActive: { 
    type: Boolean, 
    default: true 
  },
  
  defaultDoctors: { 
    type: [DefaultDoctorSchema], 
    default: () => []
  },
  
  // Default settings that apply to all days
  slotDuration: { 
    type: Number, 
    default: 30,
    min: 5,
    max: 120
  },
  
  bufferTime: { 
    type: Number, 
    default: 5 
  },
  
  maxDoctorsPerSlot: { 
    type: Number, 
    default: 100,
    min: 1
  },
  
  lateArrivals: { 
    type: [LateArrivalSchema], 
    default: () => []
  },
  
  createdBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  },
  
  updatedBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// ============ SCHEMA MIDDLEWARE ============
RollingScheduleSchema.pre('save', function(next) {
  if (!this.schedule_id) {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    this.schedule_id = `ROLL-${timestamp}-${random}`;
  }
  
  // Ensure arrays exist
  if (!this.dailySchedules) this.dailySchedules = [];
  if (!this.assignedDoctors) this.assignedDoctors = [];
  if (!this.defaultDoctors) this.defaultDoctors = [];
  if (!this.lateArrivals) this.lateArrivals = [];
  if (!this.historicalDays) this.historicalDays = [];
  
  // Mark past dates as read-only
  const now = new Date();

  this.dailySchedules.forEach(day => {
    const dayEnd = new Date(day.date);
    dayEnd.setHours(23, 59, 59, 999);
    day.isReadOnly = dayEnd < now;
    
    // Recalculate totals for each day
    recalculateDailyScheduleTotals(day);
  });

  next();
});

// ============ STATIC METHODS ============
RollingScheduleSchema.statics.generateDefaultWindow = async function(medicalCenterId) {
  return generateDefaultWindow(medicalCenterId);
};

// Static method to find by medical center and current window
RollingScheduleSchema.statics.findByMedicalCenterAndCurrentWindow = function(medicalCenterId) {
  const { windowStart, windowEnd } = getCurrentWindow();
  
  return this.findOne({ 
    medical_center_id: medicalCenterId,
    windowStart: { $lte: windowStart },
    windowEnd: { $gte: windowEnd },
    isActive: true 
  });
};

// Static method to find by medical center and date
RollingScheduleSchema.statics.findByMedicalCenterAndDate =
function (medicalCenterId, dateString) {
  return this.findOne({
    medical_center_id: medicalCenterId,
    'dailySchedules.date': dateString,
    isActive: true
  });
};

// Static method to shift slots for a doctor
RollingScheduleSchema.statics.shiftDoctorSlots = async function(
  scheduleId, 
  medicalCenterId, 
  date, 
  doctorId, 
  delayMinutes, 
  startFromSlotId = null
) {
  const schedule = await this.findOne({
    _id: scheduleId,
    medical_center_id: medicalCenterId
  });

  if (!schedule) {
    throw new Error('Schedule not found');
  }

  const appointmentDate = new Date(date);
  const dateStr = appointmentDate.toISOString().split('T')[0];
  const dayIndex = schedule.dailySchedules.findIndex(day => 
    new Date(day.date).toISOString().split('T')[0] === dateStr
  );

  if (dayIndex === -1) {
    throw new Error('No schedule found for this date');
  }

  const daySchedule = schedule.dailySchedules[dayIndex];
  
  // Helper function to add minutes to time string
  const addMinutesToTime = (timeString, minutesToAdd) => {
    const [hours, minutes] = timeString.split(':').map(Number);
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    date.setMinutes(date.getMinutes() + minutesToAdd);
    
    // Format back to HH:mm
    const newHours = date.getHours().toString().padStart(2, '0');
    const newMinutes = date.getMinutes().toString().padStart(2, '0');
    return `${newHours}:${newMinutes}`;
  };

  // Find all slots for this doctor on this day
  let slotsToShift = [];
  
  if (startFromSlotId) {
    const startSlotIndex = daySchedule.timeSlots.findIndex(s => s.id === startFromSlotId);
    if (startSlotIndex === -1) {
      throw new Error('Start slot not found');
    }
    
    // Get all slots from the start slot onwards where doctor is assigned
    for (let i = startSlotIndex; i < daySchedule.timeSlots.length; i++) {
      const slot = daySchedule.timeSlots[i];
      const doctorInSlot = slot.assignedDoctors.find(doc => 
        doc.doctorId && doc.doctorId.toString() === doctorId.toString()
      );
      if (doctorInSlot) {
        slotsToShift.push({ slot, index: i, doctorInSlot });
      }
    }
  } else {
    // Get all slots for this doctor on this day
    daySchedule.timeSlots.forEach((slot, index) => {
      const doctorInSlot = slot.assignedDoctors.find(doc => 
        doc.doctorId && doc.doctorId.toString() === doctorId.toString()
      );
      if (doctorInSlot) {
        slotsToShift.push({ slot, index, doctorInSlot });
      }
    });
  }

  if (slotsToShift.length === 0) {
    throw new Error('No slots found for this doctor on this date');
  }

  // Create new shifted slots
  const shiftedSlots = [];
  const affectedSlots = [];

  for (const { slot, index } of slotsToShift) {
    const originalStart = slot.start;
    const originalEnd = slot.end;
    const newStart = addMinutesToTime(originalStart, delayMinutes);
    const newEnd = addMinutesToTime(originalEnd, delayMinutes);

    // Create a new shifted slot
    const shiftedSlot = {
      ...slot.toObject(),
      id: new mongoose.Types.ObjectId().toString(),
      start: newStart,
      end: newEnd,
      isShifted: true,
      shiftedFrom: slot.id,
      originalTiming: {
        start: originalStart,
        end: originalEnd
      },
      shiftHistory: [...(slot.shiftHistory || []), {
        oldStart: originalStart,
        oldEnd: originalEnd,
        newStart,
        newEnd,
        shiftedAt: new Date(),
        delayMinutes,
        reason: 'Doctor delay'
      }],
      assignedDoctors: slot.assignedDoctors.map(doc => {
        if (doc.doctorId && doc.doctorId.toString() === doctorId.toString()) {
          return {
            ...doc.toObject(),
            isShifted: true,
            shiftReason: 'Shifted due to doctor delay',
            shiftHistory: [...(doc.shiftHistory || []), {
              oldStart: originalStart,
              oldEnd: originalEnd,
              newStart,
              newEnd,
              shiftedAt: new Date(),
              delayMinutes,
              reason: 'Doctor delay'
            }]
          };
        }
        return doc;
      })
    };

    // Mark original slot to be removed
    daySchedule.timeSlots[index] = null;
    
    // Add the new slot
    daySchedule.timeSlots.push(shiftedSlot);
    
    // Track affected slot
    affectedSlots.push({
      slotId: slot.id,
      oldStart: originalStart,
      oldEnd: originalEnd,
      newStart,
      newEnd
    });

    shiftedSlots.push(shiftedSlot);
  }

  // Remove null slots (original slots that became empty)
  schedule.dailySchedules[dayIndex].timeSlots = daySchedule.timeSlots.filter(slot => slot !== null);

  // Sort slots by time
  schedule.dailySchedules[dayIndex].timeSlots.sort((a, b) => {
    return a.start.localeCompare(b.start);
  });

  // Recalculate totals
  recalculateDailyScheduleTotals(schedule.dailySchedules[dayIndex]);

  return {
    schedule,
    shiftedSlots,
    affectedSlots,
    slotsCount: slotsToShift.length
  };
};

// ============ VIRTUAL PROPERTIES ============
RollingScheduleSchema.virtual('windowRange').get(function() {
  if (this.windowStart && this.windowEnd) {
    const start = new Date(this.windowStart);
    const end = new Date(this.windowEnd);
    return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
  }
  return '';
});

// Virtual for doctor's shifted slots
RollingScheduleSchema.virtual('doctorShiftedSlots').get(function() {
  const shiftedSlots = [];
  this.dailySchedules.forEach(day => {
    day.timeSlots.forEach(slot => {
      if (slot.isShifted) {
        shiftedSlots.push({
          date: day.date,
          slotId: slot.id,
          start: slot.start,
          end: slot.end,
          shiftedFrom: slot.shiftedFrom,
          originalTiming: slot.originalTiming
        });
      }
    });
  });
  return shiftedSlots;
});

// ============ INDEXES ============
RollingScheduleSchema.index({ 
  medical_center_id: 1, 
  windowStart: 1, 
  windowEnd: 1 
});

RollingScheduleSchema.index({ 
  'dailySchedules.date': 1 
});

RollingScheduleSchema.index({ 
  'lateArrivals.doctorId': 1,
  'lateArrivals.date': 1 
});

RollingScheduleSchema.index({ 
  'dailySchedules.timeSlots.isShifted': 1 
});

RollingScheduleSchema.index({ 
  'dailySchedules.timeSlots.shiftedFrom': 1 
});

// ============ CREATE MODEL ============
const RollingSchedule = mongoose.model('RollingSchedule', RollingScheduleSchema);

// ============ EXPORTS ============
module.exports = {
  RollingSchedule, // The mongoose model
  getCurrentWindow,
  isInRollingWindow,
  generateDoctorColor,
  generateTimeSlots,
  recalculateDailyScheduleTotals,
  generateDefaultWindow
};