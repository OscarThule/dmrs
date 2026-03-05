// controllers/editingNextWeek.js
const { RollingSchedule } = require('../models/editingNextWeek');
const Practitioner = require('../models/Practitioner');
const { v4: uuidv4 } = require('uuid');
const { syncAppointmentsWithShift } = require('../services/paymentService');
const Appointment = require('../models/Appointments'); // Add to imports

/* -------------------------------------------------------------------------- */
/*                               HELPER FUNCTIONS                             */
/* -------------------------------------------------------------------------- */

// Get current 21-day rolling window
const getCurrentWindow = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const windowStart = new Date(today);
  const windowEnd = new Date(today);
  windowEnd.setDate(today.getDate() + 21);
  
  return { windowStart, windowEnd };
};

// Check if date is within current rolling window
const isInRollingWindow = (date) => {
  const { windowStart, windowEnd } = getCurrentWindow();
  const targetDate = new Date(date);
  targetDate.setHours(0, 0, 0, 0);
  
  return targetDate >= windowStart && targetDate < windowEnd;
};

// Check if date is in the past
const isPastDate = (date) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDate = new Date(date);
  targetDate.setHours(0, 0, 0, 0);
  return targetDate < today;
};

// Generate unique color for doctor
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

// Generate time slots based on sessions and duration
const generateTimeSlots = (daySchedule, slotDuration = 30) => {
  const slots = [];
  
  // Helper to generate slots for a time range
  const generateSlotsForRange = (startTime, endTime, type = 'working') => {
    const [startHour, startMin] = startTime.split(':').map(Number);
    const [endHour, endMin] = endTime.split(':').map(Number);
    
    let current = new Date();
    current.setHours(startHour, startMin, 0, 0);
    const endTimeObj = new Date();
    endTimeObj.setHours(endHour, endMin, 0, 0);
    
    // Handle overnight shifts
    if (endHour < startHour && endHour !== 0) {
      endTimeObj.setDate(endTimeObj.getDate() + 1);
    }
    
    while (current < endTimeObj) {
      const slotEnd = new Date(current.getTime() + slotDuration * 60000);
      
      if (slotEnd > endTimeObj) break;
      
      const slotTime = current.getHours() * 60 + current.getMinutes();
      const isPeakHour = (slotTime >= 9 * 60 && slotTime < 11 * 60) || 
                        (slotTime >= 14 * 60 && slotTime < 16 * 60);
      
      const slotId = `slot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      slots.push({
        id: slotId,
        start: current.toTimeString().slice(0, 5),
        end: slotEnd.toTimeString().slice(0, 5),
        capacity: 10,
        assignedDoctors: [],
        availableCapacity: 10,
        type: type,
        slotType: type === 'working' ? 'standard' : type,
        duration: slotDuration,
        isShifted: false,
        isPeakHour,
        specialization: 'general',
        specializations: ['general'],
        consultationType: 'face-to-face'
      });
      
      current = new Date(slotEnd.getTime());
    }
  };
  
  // Generate slots for each enabled session
  if (daySchedule.sessions?.morning?.enabled) {
    generateSlotsForRange(
      daySchedule.sessions.morning.start,
      daySchedule.sessions.morning.end,
      'working'
    );
  }
  
  if (daySchedule.sessions?.afternoon?.enabled) {
    generateSlotsForRange(
      daySchedule.sessions.afternoon.start,
      daySchedule.sessions.afternoon.end,
      'working'
    );
  }
  
  if (daySchedule.sessions?.night?.enabled) {
    // Night shift: 18:00-22:00 and 23:00-08:00
    generateSlotsForRange('18:00', '22:00', 'night-shift');
    generateSlotsForRange('23:00', '08:00', 'night-shift');
  }
  
  return slots;
};

// Recalculate daily schedule totals
const recalculateDailyScheduleTotals = (daySchedule) => {
  if (!daySchedule.timeSlots) {
    daySchedule.timeSlots = [];
  }
  
  // Calculate total capacity
  daySchedule.totalCapacity = daySchedule.timeSlots.reduce(
    (sum, slot) => sum + slot.capacity, 0
  );
  

  // Collect unique assigned doctor IDs
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
    slot.availableCapacity = Math.max(0, slot.capacity - assignedCapacity);
  });
  
  return daySchedule;
};

// Ensure complete 21-day window
const ensureCompleteWindow = async (rollingSchedule) => {
  const { windowStart, windowEnd } = getCurrentWindow();
  const existingDates = new Set(
    rollingSchedule.dailySchedules.map(day => 
      new Date(day.date).toISOString().split('T')[0]
    )
  );
  
  const daysToAdd = [];
  for (let i = 0; i < 21; i++) {
    const currentDate = new Date(windowStart);
    currentDate.setDate(windowStart.getDate() + i);
    const dateStr = currentDate.toISOString().split('T')[0];
    
    if (!existingDates.has(dateStr)) {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const dayOfWeek = currentDate.getDay();
      const dayName = days[dayOfWeek];
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      
      // Create basic day structure
      const newDay = {
        date: currentDate,
        dayName,
        dayOfWeek,
        isWorking: !isWeekend,
        is24Hours: false,
        timeSlots: [],
        lunchBreaks: [],
        sessions: {
          morning: { 
            start: '09:00', 
            end: '12:00', 
            enabled: !isWeekend 
          },
          afternoon: { 
            start: '13:00', 
            end: '17:00', 
            enabled: !isWeekend 
          },
          night: { 
            start: '18:00', 
            end: '20:00', 
            enabled: false 
          }
        },
        totalCapacity: 0,
        
        assignedDoctors: [],
        availableSpecializations: ['general'],
        defaultSlotCapacity: 10,
        slotDuration: rollingSchedule.slotDuration || 30,
        bufferTime: 5,
        maxDoctorsPerSlot: 100,
        isReadOnly: false
      };
      
      // Add lunch break for working days
      if (!isWeekend) {
        newDay.lunchBreaks.push({
          id: uuidv4(),
          start: '12:00',
          end: '13:00',
          reason: 'Lunch Break',
          duration: 60,
          enabled: true,
          recurring: true,
          affectedStaff: [],
          type: 'lunch'
        });
        
        // Generate time slots for working days
        newDay.timeSlots = generateTimeSlots(newDay, newDay.slotDuration);
        newDay.totalCapacity = newDay.timeSlots.reduce((sum, slot) => sum + slot.capacity, 0);
      }
      
      daysToAdd.push(newDay);
    }
  }
  
  if (daysToAdd.length > 0) {
    rollingSchedule.dailySchedules.push(...daysToAdd);
    rollingSchedule.dailySchedules.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    // Keep only 21 days
    if (rollingSchedule.dailySchedules.length > 21) {
      rollingSchedule.dailySchedules = rollingSchedule.dailySchedules.slice(0, 21);
    }
    
    await rollingSchedule.save();
  }
  
  return rollingSchedule;
};

// Move past days to historical data
const movePastDaysToHistorical = async (rollingSchedule) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const pastDays = [];
  const futureDays = [];
  
  rollingSchedule.dailySchedules.forEach(day => {
    const dayDate = new Date(day.date);
    dayDate.setHours(0, 0, 0, 0);
    
    if (dayDate < today) {
      // Mark as past and read-only
      day.isReadOnly = true;
      pastDays.push(day);
    } else {
      futureDays.push(day);
    }
  });
  
  if (pastDays.length > 0) {
    if (!rollingSchedule.historicalDays) {
      rollingSchedule.historicalDays = [];
    }
    
    // Add past days to historical with read-only flag
    pastDays.forEach(day => {
      rollingSchedule.historicalDays.push({
        date: day.date,
        dailySchedule: day,
        isReadOnly: true
      });
    });
    
    // Update daily schedules to only include future days
    rollingSchedule.dailySchedules = futureDays;
    
    await rollingSchedule.save();
  }
  
  return rollingSchedule;
};

/* -------------------------------------------------------------------------- */
/*                          GET ROLLING WINDOW                                */
/* -------------------------------------------------------------------------- */

// controllers/editingNextWeek.js - Update getRollingWindow function
const getRollingWindow = async (req, res) => {
  try {
    // Check if medical center is available
    if (!req.medicalCenter || !req.medicalCenter._id) {
      console.error('❌ Medical center not found in request');
      return res.status(401).json({
        success: false,
        message: "Medical center authentication required"
      });
    }

    const medicalCenterId = req.medicalCenter._id;
    const { windowStart, windowEnd } = getCurrentWindow();
    
    console.log('🔄 Getting rolling window for medical center:', medicalCenterId);
    console.log('📅 Window:', windowStart.toISOString().split('T')[0], 'to', windowEnd.toISOString().split('T')[0]);
    
    // Find existing active schedule for this medical center
    let rollingSchedule = await RollingSchedule.findOne({
      medical_center_id: medicalCenterId,
      isActive: true
    });
    
    console.log('🔍 Existing schedule found:', !!rollingSchedule);
    
    if (!rollingSchedule) {
      console.log('📝 Creating new rolling schedule...');
      
      try {
        // Create new schedule
        rollingSchedule = new RollingSchedule({
          schedule_id: `ROLL-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          medical_center_id: medicalCenterId,
          windowStart,
          windowEnd,
          dailySchedules: [],
          historicalDays: [],
          assignedDoctors: [],
          isActive: true,
          defaultDoctors: [],
          slotDuration: 30,
          bufferTime: 5,
          maxDoctorsPerSlot: 100,
          defaultSlotCapacity: 10,
          createdBy: medicalCenterId,
          updatedBy: medicalCenterId
        });

        // Save the basic schedule first
        await rollingSchedule.save();
        console.log('✅ Created new schedule with ID:', rollingSchedule._id);
        
        // Now ensure complete window
        rollingSchedule = await ensureCompleteWindow(rollingSchedule);
        console.log('✅ Added days to schedule');
        
        // Move past days to historical
        rollingSchedule = await movePastDaysToHistorical(rollingSchedule);
        
        // Get practitioners for default doctors
        const practitioners = await Practitioner.find({ 
          medical_centers: medicalCenterId,
          isActive: true 
        }).limit(10); // Limit to avoid too many doctors
        
        console.log(`👨‍⚕️ Found ${practitioners.length} practitioners`);
        
        rollingSchedule.defaultDoctors = practitioners.map(practitioner => ({
          doctorId: practitioner._id,
          doctorName: practitioner.name,
          specializations: practitioner.specialization || ['general'],
          defaultSlots: [],
          availability: {},
          color: generateDoctorColor(practitioner._id.toString())
        }));
        
        await rollingSchedule.save();
        
      } catch (createError) {
        console.error('❌ Error creating schedule:', createError);
        return res.status(500).json({
          success: false,
          message: "Failed to create schedule",
          error: createError.message
        });
      }
    }
    
    // Ensure complete 21-day window
    rollingSchedule = await ensureCompleteWindow(rollingSchedule);
    
    // Move past days to historical
    rollingSchedule = await movePastDaysToHistorical(rollingSchedule);
    
    // Mark past dates as read-only
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    rollingSchedule.dailySchedules.forEach(day => {
      const dayDate = new Date(day.date);
      dayDate.setHours(0, 0, 0, 0);
      day.isReadOnly = dayDate < today;
    });
    
    rollingSchedule.updatedAt = new Date();
    await rollingSchedule.save();
    
    console.log(`📊 Returning schedule with ${rollingSchedule.dailySchedules.length} days`);
    
    res.status(200).json({
      success: true,
      data: rollingSchedule,
      windowInfo: {
        start: windowStart,
        end: windowEnd,
        totalDays: 21,
        today: new Date()
      }
    });
    
  } catch (error) {
    console.error("❌ getRollingWindow error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to load rolling window schedule",
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

/* -------------------------------------------------------------------------- */
/*                          UPDATE DAILY SCHEDULE                             */
/* -------------------------------------------------------------------------- */

const updateDailySchedule = async (req, res) => {
  try {
    const { scheduleId, date } = req.params;
    const updates = req.body;
    
    console.log('📝 Updating daily schedule:', { scheduleId, date, updates });
    
    // Parse date to ISO format
    const targetDate = new Date(date);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format"
      });
    }
    
    // Validate date is in rolling window
    if (!isInRollingWindow(targetDate)) {
      return res.status(400).json({
        success: false,
        message: "Cannot edit dates outside the 21-day rolling window"
      });
    }
    
    // Validate date is not in the past
    if (isPastDate(targetDate)) {
      return res.status(400).json({
        success: false,
        message: "Cannot edit past dates"
      });
    }
    
    const rollingSchedule = await RollingSchedule.findOne({
      _id: scheduleId,
      medical_center_id: req.medicalCenter._id,
      isActive: true
    });
    
    if (!rollingSchedule) {
      return res.status(404).json({ 
        success: false, 
        message: "Schedule not found" 
      });
    }
    
    // Find or create daily schedule for the specific date
    const dateStr = targetDate.toISOString().split('T')[0];
    let dayIndex = rollingSchedule.dailySchedules.findIndex(
      day => new Date(day.date).toISOString().split('T')[0] === dateStr
    );
    
    if (dayIndex === -1) {
      // Create new day
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const dayOfWeek = targetDate.getDay();
      const dayName = days[dayOfWeek];
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      
      const newDailySchedule = {
        date: targetDate,
        dayName,
        dayOfWeek,
        isWorking: !isWeekend,
        is24Hours: false,
        timeSlots: [],
        lunchBreaks: isWeekend ? [] : [{
          id: uuidv4(),
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
          morning: { 
            start: '09:00', 
            end: '12:00', 
            enabled: !isWeekend 
          },
          afternoon: { 
            start: '13:00', 
            end: '17:00', 
            enabled: !isWeekend 
          },
          night: { 
            start: '18:00', 
            end: '20:00', 
            enabled: false 
          }
        },
        totalCapacity: 0,
       
        assignedDoctors: [],
        availableSpecializations: ['general'],
        defaultSlotCapacity: 10,
        slotDuration: rollingSchedule.slotDuration || 30,
        bufferTime: 5,
        maxDoctorsPerSlot: 100,
        isReadOnly: false
      };
      
      rollingSchedule.dailySchedules.push(newDailySchedule);
      rollingSchedule.dailySchedules.sort((a, b) => new Date(a.date) - new Date(b.date));
      
      // Find the new index
      dayIndex = rollingSchedule.dailySchedules.findIndex(
        day => new Date(day.date).toISOString().split('T')[0] === dateStr
      );
    }
    
    // Apply updates
    const daySchedule = rollingSchedule.dailySchedules[dayIndex];
    
    // Handle slot duration change
    if (updates.slotDuration && updates.slotDuration !== daySchedule.slotDuration) {
      // Backup assignments
      const assignmentsBackup = daySchedule.timeSlots.map(slot => ({
        start: slot.start,
        end: slot.end,
        assignedDoctors: [...slot.assignedDoctors]
      }));
      
      // Update duration
      daySchedule.slotDuration = updates.slotDuration;
      
      // Regenerate slots
      daySchedule.timeSlots = generateTimeSlots(daySchedule, updates.slotDuration);
      
      // Restore assignments to matching slots
      daySchedule.timeSlots.forEach(newSlot => {
        const matchingOldSlot = assignmentsBackup.find(old => 
          old.start === newSlot.start && old.end === newSlot.end
        );
        if (matchingOldSlot) {
          newSlot.assignedDoctors = matchingOldSlot.assignedDoctors;
          newSlot.availableCapacity = newSlot.capacity - 
            matchingOldSlot.assignedDoctors.reduce((sum, doc) => sum + (doc.maxPatients || 1), 0);
        }
      });
    }
    
    // Handle other updates
    Object.keys(updates).forEach(key => {
      if (key !== 'slotDuration' && key !== 'timeSlots' && key !== 'assignedDoctors') {
        daySchedule[key] = updates[key];
      }
    });
    
    // If timeSlots are provided directly (e.g., from frontend generation)
    if (updates.timeSlots && Array.isArray(updates.timeSlots)) {
      daySchedule.timeSlots = updates.timeSlots;
    }
    
    // Recalculate totals
    recalculateDailyScheduleTotals(daySchedule);
    
    // Update global slot duration if changed
    if (updates.slotDuration && updates.slotDuration !== rollingSchedule.slotDuration) {
      rollingSchedule.slotDuration = updates.slotDuration;
    }
    
    rollingSchedule.updatedBy = req.medicalCenter._id;
    rollingSchedule.updatedAt = new Date();
    
    await rollingSchedule.save();
    
    // Return updated day
    res.status(200).json({
      success: true,
      message: "Daily schedule updated successfully",
      data: daySchedule
    });
    
  } catch (error) {
    console.error("❌ updateDailySchedule error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to update daily schedule",
      error: error.message 
    });
  }
};

/* -------------------------------------------------------------------------- */
/*                          ASSIGN DOCTOR TO SLOT                             */
/* -------------------------------------------------------------------------- */

const assignDoctorToSlot = async (req, res) => {
  try {
    const { scheduleId, date } = req.params;
    const { slotIndex, doctorId, doctorName, maxPatients = 1, specialization = ['general'] } = req.body;
    
    console.log('👨‍⚕️ Assigning doctor to slot:', { scheduleId, date, slotIndex, doctorId });
    
    // Validate date is in rolling window
    if (!isInRollingWindow(date)) {
      return res.status(400).json({
        success: false,
        message: "Cannot assign doctors to dates outside the 21-day rolling window"
      });
    }
    
    // Validate date is not in the past
    if (isPastDate(date)) {
      return res.status(400).json({
        success: false,
        message: "Cannot assign doctors to past dates"
      });
    }
    
    const rollingSchedule = await RollingSchedule.findOne({
      _id: scheduleId,
      medical_center_id: req.medicalCenter._id,
      isActive: true
    });
    
    if (!rollingSchedule) {
      return res.status(404).json({ 
        success: false, 
        message: "Schedule not found" 
      });
    }
    
    // Find the daily schedule for the specific date
    const dateStr = new Date(date).toISOString().split('T')[0];
    const dayIndex = rollingSchedule.dailySchedules.findIndex(
      day => new Date(day.date).toISOString().split('T')[0] === dateStr
    );
    
    if (dayIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: "Daily schedule not found for this date" 
      });
    }
    
    const daySchedule = rollingSchedule.dailySchedules[dayIndex];
    
    if (!daySchedule.isWorking) {
      return res.status(400).json({ 
        success: false, 
        message: "Cannot assign doctors to non-working days" 
      });
    }
    
    if (!daySchedule.timeSlots || slotIndex >= daySchedule.timeSlots.length) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid slot index" 
      });
    }
    
    const slot = daySchedule.timeSlots[slotIndex];
    
    // Check if doctor is already assigned
    const isAlreadyAssigned = slot.assignedDoctors.some(doc => 
      doc.doctorId && doc.doctorId.toString() === doctorId.toString()
    );
    
    if (isAlreadyAssigned) {
      return res.status(400).json({ 
        success: false, 
        message: "Doctor already assigned to this slot" 
      });
    }
    
    // Check max doctors per slot
    if (slot.assignedDoctors.length >= (daySchedule.maxDoctorsPerSlot || 100)) {
      return res.status(400).json({ 
        success: false, 
        message: "Maximum doctors per slot reached" 
      });
    }
    
    // Check available capacity
    const totalAssignedPatients = slot.assignedDoctors.reduce((sum, doc) => sum + (doc.maxPatients || 1), 0);
    const availableCapacity = slot.capacity - totalAssignedPatients;
    
    if (availableCapacity < (maxPatients || 1)) {
      return res.status(400).json({ 
        success: false, 
        message: "Not enough capacity in this slot" 
      });
    }
    
    // Add doctor assignment
    const doctorAssignment = {
      doctorId,
      doctorName: doctorName || 'Unknown Doctor',
      consultationType: 'face-to-face',
      specialization: Array.isArray(specialization) ? specialization : [specialization],
      maxPatients: maxPatients || 1,
      currentPatients: 0,
      isAvailable: true,
      colorCode: generateDoctorColor(doctorId)
    };
    
    slot.assignedDoctors.push(doctorAssignment);
    
    // Update slot capacity
    slot.availableCapacity = Math.max(0, slot.capacity - 
      slot.assignedDoctors.reduce((sum, doc) => sum + (doc.maxPatients || 1), 0));
    
    // Recalculate day totals
    recalculateDailyScheduleTotals(daySchedule);
    
    // Update schedule assignedDoctors array
    const allDoctorIds = rollingSchedule.dailySchedules.flatMap(day => 
      day.timeSlots.flatMap(slot => 
        slot.assignedDoctors.map(doc => doc.doctorId.toString()).filter(Boolean)
      )
    );
    
    rollingSchedule.assignedDoctors = [...new Set(allDoctorIds)];
    
    rollingSchedule.updatedBy = req.medicalCenter._id;
    rollingSchedule.updatedAt = new Date();
    
    await rollingSchedule.save();
    
    res.status(200).json({ 
      success: true, 
      message: "Doctor assigned successfully", 
      data: daySchedule 
    });
    
  } catch (error) {
    console.error("❌ assignDoctorToSlot error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to assign doctor to slot",
      error: error.message 
    });
  }
};

/* -------------------------------------------------------------------------- */
/*                          REMOVE DOCTOR FROM SLOT                           */
/* -------------------------------------------------------------------------- */

const removeDoctorFromSlot = async (req, res) => {
  try {
    const { scheduleId, date } = req.params;
    const { slotIndex, doctorId } = req.body;
    
    console.log('❌ Removing doctor from slot:', { scheduleId, date, slotIndex, doctorId });
    
    const rollingSchedule = await RollingSchedule.findOne({
      _id: scheduleId,
      medical_center_id: req.medicalCenter._id,
      isActive: true
    });
    
    if (!rollingSchedule) {
      return res.status(404).json({ 
        success: false, 
        message: "Schedule not found" 
      });
    }
    
    // Find the daily schedule for the specific date
    const dateStr = new Date(date).toISOString().split('T')[0];
    const dayIndex = rollingSchedule.dailySchedules.findIndex(
      day => new Date(day.date).toISOString().split('T')[0] === dateStr
    );
    
    if (dayIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: "Daily schedule not found for this date" 
      });
    }
    
    const daySchedule = rollingSchedule.dailySchedules[dayIndex];
    
    if (!daySchedule.timeSlots || slotIndex >= daySchedule.timeSlots.length) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid slot index" 
      });
    }
    
    const slot = daySchedule.timeSlots[slotIndex];
    
    // Find and remove doctor
    const initialCount = slot.assignedDoctors.length;
    slot.assignedDoctors = slot.assignedDoctors.filter(doc => 
      doc.doctorId && doc.doctorId.toString() !== doctorId.toString()
    );
    
    if (slot.assignedDoctors.length === initialCount) {
      return res.status(404).json({ 
        success: false, 
        message: "Doctor not found in this slot" 
      });
    }
    
    // Update slot capacity
    slot.availableCapacity = Math.max(0, slot.capacity - 
      slot.assignedDoctors.reduce((sum, doc) => sum + (doc.maxPatients || 1), 0));
    
    // Recalculate day totals
    recalculateDailyScheduleTotals(daySchedule);
    
    // Update schedule assignedDoctors array
    const allDoctorIds = rollingSchedule.dailySchedules.flatMap(day => 
      day.timeSlots.flatMap(slot => 
        slot.assignedDoctors.map(doc => doc.doctorId.toString()).filter(Boolean)
      )
    );
    
    rollingSchedule.assignedDoctors = [...new Set(allDoctorIds)];
    
    rollingSchedule.updatedBy = req.medicalCenter._id;
    rollingSchedule.updatedAt = new Date();
    
    await rollingSchedule.save();
    
    res.status(200).json({ 
      success: true, 
      message: "Doctor removed successfully", 
      data: daySchedule 
    });
    
  } catch (error) {
    console.error("❌ removeDoctorFromSlot error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to remove doctor from slot",
      error: error.message 
    });
  }
};

/* -------------------------------------------------------------------------- */
/*                          UPDATE SLOT DURATION                              */
/* -------------------------------------------------------------------------- */

const updateSlotDuration = async (req, res) => {
  try {
    const { scheduleId, date } = req.params;
    const { slotDuration } = req.body;
    
    console.log('⏱️ Updating slot duration:', { scheduleId, date, slotDuration });
    
    if (!slotDuration || slotDuration < 5 || slotDuration > 120) {
      return res.status(400).json({ 
        success: false, 
        message: "Slot duration must be between 5 and 120 minutes" 
      });
    }
    
    // Validate date is in rolling window
    if (!isInRollingWindow(date)) {
      return res.status(400).json({
        success: false,
        message: "Cannot modify dates outside the 21-day rolling window"
      });
    }
    
    // Validate date is not in the past
    if (isPastDate(date)) {
      return res.status(400).json({
        success: false,
        message: "Cannot edit past dates"
      });
    }
    
    const rollingSchedule = await RollingSchedule.findOne({
      _id: scheduleId,
      medical_center_id: req.medicalCenter._id,
      isActive: true
    });
    
    if (!rollingSchedule) {
      return res.status(404).json({ 
        success: false, 
        message: "Schedule not found" 
      });
    }
    
    // Find the daily schedule for the specific date
    const dateStr = new Date(date).toISOString().split('T')[0];
    const dayIndex = rollingSchedule.dailySchedules.findIndex(
      day => new Date(day.date).toISOString().split('T')[0] === dateStr
    );
    
    if (dayIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: "Daily schedule not found for this date" 
      });
    }
    
    const daySchedule = rollingSchedule.dailySchedules[dayIndex];

    // 🚫 BLOCK SLOT DURATION CHANGE IF APPOINTMENTS EXIST
const existingAppointments = await Appointment.countDocuments({
  schedule_id: rollingSchedule._id,
  date: dateStr,
  status: { $nin: ['cancelled', 'completed'] }
});

if (existingAppointments > 0) {
  return res.status(400).json({
    success: false,
    message: "Cannot change slot duration. Appointments already exist for this day."
  });
}

    
    // Backup existing assignments
    const assignmentsBackup = daySchedule.timeSlots.map(slot => ({
      start: slot.start,
      end: slot.end,
      assignedDoctors: [...slot.assignedDoctors]
    }));
    
    // Update slot duration
    daySchedule.slotDuration = slotDuration;
    
    // Regenerate time slots with new duration
    daySchedule.timeSlots = generateTimeSlots(daySchedule, slotDuration);
    
    // Restore doctor assignments to matching slots
    daySchedule.timeSlots.forEach(newSlot => {
      const matchingOldSlot = assignmentsBackup.find(old => 
        old.start === newSlot.start && old.end === newSlot.end
      );
      if (matchingOldSlot) {
        newSlot.assignedDoctors = matchingOldSlot.assignedDoctors;
        newSlot.availableCapacity = newSlot.capacity - 
          matchingOldSlot.assignedDoctors.reduce((sum, doc) => sum + (doc.maxPatients || 1), 0);
      }
    });
    
    // Recalculate totals
    recalculateDailyScheduleTotals(daySchedule);
    
    // Update global slot duration if this is the first day being edited
    if (!rollingSchedule.slotDuration || rollingSchedule.slotDuration !== slotDuration) {
      rollingSchedule.slotDuration = slotDuration;
    }
    
    rollingSchedule.updatedBy = req.medicalCenter._id;
    rollingSchedule.updatedAt = new Date();
    
    await rollingSchedule.save();
    
    res.status(200).json({ 
      success: true, 
      message: "Slot duration updated successfully", 
      data: daySchedule 
    });
    
  } catch (error) {
    console.error("❌ updateSlotDuration error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to update slot duration",
      error: error.message 
    });
  }
};
const canModifySlot = async (req, res) => {
  try {
    const { scheduleId, date, slotIndex } = req.params;
    
    const rollingSchedule = await RollingSchedule.findOne({
      _id: scheduleId,
      medical_center_id: req.medicalCenter._id,
      isActive: true
    });
    
    const dateStr = new Date(date).toISOString().split('T')[0];
    const daySchedule = rollingSchedule.dailySchedules.find(
      day => new Date(day.date).toISOString().split('T')[0] === dateStr
    );
    
    const slot = daySchedule.timeSlots[slotIndex];
    
    const Appointment = require('../models/Appointment');
    const appointmentCount = await Appointment.countDocuments({
      schedule_id: scheduleId,
      date: dateStr,
      startTime: slot.start,
      endTime: slot.end,
      status: { $nin: ['cancelled', 'completed'] }
    });
    
    res.status(200).json({
      success: true,
      data: {
        canModify: appointmentCount === 0,
        appointmentCount,
        slotDetails: {
          start: slot.start,
          end: slot.end,
          capacity: slot.capacity,
          assignedDoctors: slot.assignedDoctors.length
        }
      }
    });
    
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
/* -------------------------------------------------------------------------- */
/*                          ADD LUNCH BREAK                                   */
/* -------------------------------------------------------------------------- */

const addLunchBreak = async (req, res) => {
  try {
    const { scheduleId, date } = req.params;
    const lunchBreakData = req.body;
    
    console.log('🍽️ Adding lunch break:', { scheduleId, date, lunchBreakData });
    
    // Validate date is in rolling window
    if (!isInRollingWindow(date)) {
      return res.status(400).json({
        success: false,
        message: "Cannot modify dates outside the 21-day rolling window"
      });
    }
    
    // Validate date is not in the past
    if (isPastDate(date)) {
      return res.status(400).json({
        success: false,
        message: "Cannot edit past dates"
      });
    }
    
    const rollingSchedule = await RollingSchedule.findOne({
      _id: scheduleId,
      medical_center_id: req.medicalCenter._id,
      isActive: true
    });
    
    if (!rollingSchedule) {
      return res.status(404).json({ 
        success: false, 
        message: "Schedule not found" 
      });
    }
    
    // Find the daily schedule for the specific date
    const dateStr = new Date(date).toISOString().split('T')[0];
    const dayIndex = rollingSchedule.dailySchedules.findIndex(
      day => new Date(day.date).toISOString().split('T')[0] === dateStr
    );
    
    if (dayIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: "Daily schedule not found for this date" 
      });
    }
    
    const daySchedule = rollingSchedule.dailySchedules[dayIndex];
    
    // Validate lunch break times
    if (!lunchBreakData.start || !lunchBreakData.end) {
      return res.status(400).json({ 
        success: false, 
        message: "Start and end times are required" 
      });
    }
    
    // Add lunch break with ID
    const newLunchBreak = {
      id: uuidv4(),
      start: lunchBreakData.start,
      end: lunchBreakData.end,
      reason: lunchBreakData.reason || 'Lunch Break',
      duration: lunchBreakData.duration || 60,
      enabled: lunchBreakData.enabled !== undefined ? lunchBreakData.enabled : true,
      recurring: lunchBreakData.recurring || false,
      affectedStaff: lunchBreakData.affectedStaff || [],
      type: lunchBreakData.type || 'lunch'
    };
    
    if (!daySchedule.lunchBreaks) {
      daySchedule.lunchBreaks = [];
    }
    
    daySchedule.lunchBreaks.push(newLunchBreak);
    
    // Regenerate time slots to account for lunch break
    daySchedule.timeSlots = generateTimeSlots(daySchedule, daySchedule.slotDuration || 30);
    
    // Recalculate totals
    recalculateDailyScheduleTotals(daySchedule);
    
    rollingSchedule.updatedBy = req.medicalCenter._id;
    rollingSchedule.updatedAt = new Date();
    
    await rollingSchedule.save();
    
    res.status(200).json({ 
      success: true, 
      message: "Lunch break added successfully", 
      data: daySchedule 
    });
    
  } catch (error) {
    console.error("❌ addLunchBreak error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to add lunch break",
      error: error.message 
    });
  }
};

/* -------------------------------------------------------------------------- */
/*                          REMOVE LUNCH BREAK                                */
/* -------------------------------------------------------------------------- */

const removeLunchBreak = async (req, res) => {
  try {
    const { scheduleId, date } = req.params;
    const { breakId } = req.body;
    
    console.log('❌ Removing lunch break:', { scheduleId, date, breakId });
    
    // Validate date is in rolling window
    if (!isInRollingWindow(date)) {
      return res.status(400).json({
        success: false,
        message: "Cannot modify dates outside the 21-day rolling window"
      });
    }
    
    // Validate date is not in the past
    if (isPastDate(date)) {
      return res.status(400).json({
        success: false,
        message: "Cannot edit past dates"
      });
    }
    
    const rollingSchedule = await RollingSchedule.findOne({
      _id: scheduleId,
      medical_center_id: req.medicalCenter._id,
      isActive: true
    });
    
    if (!rollingSchedule) {
      return res.status(404).json({ 
        success: false, 
        message: "Schedule not found" 
      });
    }
    
    // Find the daily schedule for the specific date
    const dateStr = new Date(date).toISOString().split('T')[0];
    const dayIndex = rollingSchedule.dailySchedules.findIndex(
      day => new Date(day.date).toISOString().split('T')[0] === dateStr
    );
    
    if (dayIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: "Daily schedule not found for this date" 
      });
    }
    
    const daySchedule = rollingSchedule.dailySchedules[dayIndex];
    
    if (!daySchedule.lunchBreaks || daySchedule.lunchBreaks.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: "No lunch breaks found" 
      });
    }
    
    // Remove lunch break by ID
    const initialLength = daySchedule.lunchBreaks.length;
    daySchedule.lunchBreaks = daySchedule.lunchBreaks.filter(breakItem => breakItem.id !== breakId);
    
    if (daySchedule.lunchBreaks.length === initialLength) {
      return res.status(400).json({ 
        success: false, 
        message: "Lunch break not found" 
      });
    }
    
    // Regenerate time slots without the removed lunch break
    daySchedule.timeSlots = generateTimeSlots(daySchedule, daySchedule.slotDuration || 30);
    
    // Recalculate totals
    recalculateDailyScheduleTotals(daySchedule);
    
    rollingSchedule.updatedBy = req.medicalCenter._id;
    rollingSchedule.updatedAt = new Date();
    
    await rollingSchedule.save();
    
    res.status(200).json({ 
      success: true, 
      message: "Lunch break removed successfully", 
      data: daySchedule 
    });
    
  } catch (error) {
    console.error("❌ removeLunchBreak error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to remove lunch break",
      error: error.message 
    });
  }
};

/* -------------------------------------------------------------------------- */
/*                          UPDATE SESSION                                    */
/* -------------------------------------------------------------------------- */

const updateSession = async (req, res) => {
  try {
    const { scheduleId, date } = req.params;
    const { sessionKey, updates } = req.body;
    
    console.log('🔄 Updating session:', { scheduleId, date, sessionKey, updates });
    
    // Validate session key
    if (!['morning', 'afternoon', 'night'].includes(sessionKey)) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid session key. Must be 'morning', 'afternoon', or 'night'" 
      });
    }
    
    // Validate date is in rolling window
    if (!isInRollingWindow(date)) {
      return res.status(400).json({
        success: false,
        message: "Cannot modify dates outside the 21-day rolling window"
      });
    }
    
    // Validate date is not in the past
    if (isPastDate(date)) {
      return res.status(400).json({
        success: false,
        message: "Cannot edit past dates"
      });
    }
    
    const rollingSchedule = await RollingSchedule.findOne({
      _id: scheduleId,
      medical_center_id: req.medicalCenter._id,
      isActive: true
    });
    
    if (!rollingSchedule) {
      return res.status(404).json({ 
        success: false, 
        message: "Schedule not found" 
      });
    }
    
    // Find the daily schedule for the specific date
    const dateStr = new Date(date).toISOString().split('T')[0];
    const dayIndex = rollingSchedule.dailySchedules.findIndex(
      day => new Date(day.date).toISOString().split('T')[0] === dateStr
    );
    
    if (dayIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: "Daily schedule not found for this date" 
      });
    }
    
    const daySchedule = rollingSchedule.dailySchedules[dayIndex];
    
    // Apply session updates
    if (daySchedule.sessions[sessionKey]) {
      Object.keys(updates).forEach(key => {
        daySchedule.sessions[sessionKey][key] = updates[key];
      });
    } else {
      daySchedule.sessions[sessionKey] = updates;
    }
    
    // Backup existing assignments
    const assignmentsBackup = daySchedule.timeSlots.map(slot => ({
      start: slot.start,
      end: slot.end,
      assignedDoctors: [...slot.assignedDoctors]
    }));
    
    // Regenerate time slots with updated sessions
    daySchedule.timeSlots = generateTimeSlots(daySchedule, daySchedule.slotDuration || 30);
    
    // Restore doctor assignments to matching slots
    daySchedule.timeSlots.forEach(newSlot => {
      const matchingOldSlot = assignmentsBackup.find(old => 
        old.start === newSlot.start && old.end === newSlot.end
      );
      if (matchingOldSlot) {
        newSlot.assignedDoctors = matchingOldSlot.assignedDoctors;
        newSlot.availableCapacity = newSlot.capacity - 
          matchingOldSlot.assignedDoctors.reduce((sum, doc) => sum + (doc.maxPatients || 1), 0);
      }
    });
    
    // Recalculate totals
    recalculateDailyScheduleTotals(daySchedule);
    
    rollingSchedule.updatedBy = req.medicalCenter._id;
    rollingSchedule.updatedAt = new Date();
    
    await rollingSchedule.save();
    
    res.status(200).json({ 
      success: true, 
      message: "Session updated successfully", 
      data: daySchedule 
    });
    
  } catch (error) {
    console.error("❌ updateSession error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to update session",
      error: error.message 
    });
  }
};

/* -------------------------------------------------------------------------- */
/*                          TOGGLE WORKING DAY                                */
/* -------------------------------------------------------------------------- */

const toggleWorkingDay = async (req, res) => {
  try {
    const { scheduleId, date } = req.params;
    const { isWorking } = req.body;
    
    console.log('📅 Toggling working day:', { scheduleId, date, isWorking });
    
    // Validate date is in rolling window
    if (!isInRollingWindow(date)) {
      return res.status(400).json({
        success: false,
        message: "Cannot modify dates outside the 21-day rolling window"
      });
    }
    
    // Validate date is not in the past
    if (isPastDate(date)) {
      return res.status(400).json({
        success: false,
        message: "Cannot edit past dates"
      });
    }
    
    const rollingSchedule = await RollingSchedule.findOne({
      _id: scheduleId,
      medical_center_id: req.medicalCenter._id,
      isActive: true
    });
    
    if (!rollingSchedule) {
      return res.status(404).json({ 
        success: false, 
        message: "Schedule not found" 
      });
    }
    
    // Find the daily schedule for the specific date
    const dateStr = new Date(date).toISOString().split('T')[0];
    const dayIndex = rollingSchedule.dailySchedules.findIndex(
      day => new Date(day.date).toISOString().split('T')[0] === dateStr
    );
    
    if (dayIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: "Daily schedule not found for this date" 
      });
    }
    
    const daySchedule = rollingSchedule.dailySchedules[dayIndex];
    
    // Update working status
    daySchedule.isWorking = isWorking;
    
    if (!isWorking) {
      // Clear everything for non-working day
      daySchedule.timeSlots = [];
      daySchedule.lunchBreaks = [];
      daySchedule.totalCapacity = 0;
     
      daySchedule.assignedDoctors = [];
      
      // Disable all sessions
      daySchedule.sessions.morning.enabled = false;
      daySchedule.sessions.afternoon.enabled = false;
      daySchedule.sessions.night.enabled = false;
    } else {
      // Enable default sessions for working day
      const isWeekend = daySchedule.dayOfWeek === 0 || daySchedule.dayOfWeek === 6;
      daySchedule.sessions.morning.enabled = !isWeekend;
      daySchedule.sessions.afternoon.enabled = !isWeekend;
      daySchedule.sessions.night.enabled = false;
      
      // Add default lunch break
      if (!isWeekend) {
        daySchedule.lunchBreaks = [{
          id: uuidv4(),
          start: '12:00',
          end: '13:00',
          reason: 'Lunch Break',
          duration: 60,
          enabled: true,
          recurring: true,
          affectedStaff: [],
          type: 'lunch'
        }];
      }
      
      // Generate time slots
      daySchedule.timeSlots = generateTimeSlots(daySchedule, daySchedule.slotDuration || 30);
    }
    
    // Recalculate totals
    recalculateDailyScheduleTotals(daySchedule);
    
    rollingSchedule.updatedBy = req.medicalCenter._id;
    rollingSchedule.updatedAt = new Date();
    
    await rollingSchedule.save();
    
    res.status(200).json({ 
      success: true, 
      message: `Day marked as ${isWorking ? 'working' : 'non-working'} successfully`, 
      data: daySchedule 
    });
    
  } catch (error) {
    console.error("❌ toggleWorkingDay error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to toggle working day",
      error: error.message 
    });
  }
};

/* -------------------------------------------------------------------------- */
/*                          GET DOCTOR ASSIGNMENTS                            */
/* -------------------------------------------------------------------------- */

const getDoctorAssignments = async (req, res) => {
  try {
    const schedule = await RollingSchedule.findOne({
      _id: req.params.id,
      medical_center_id: req.medicalCenter._id,
      isActive: true
    })
    .populate({
      path: 'defaultDoctors.doctorId',
      model: 'Practitioner',
      select: 'name specialization'
    });
    
    if (!schedule) {
      return res.status(404).json({ 
        success: false, 
        message: "Schedule not found" 
      });
    }
    
    // Extract all doctor assignments from current window
    const doctorAssignments = schedule.dailySchedules.reduce((acc, daySchedule) => {
      const dayAssignments = daySchedule.timeSlots.flatMap(slot => 
        slot.assignedDoctors.map(assignment => ({
          ...assignment,
          date: daySchedule.date,
          dayName: daySchedule.dayName,
          slotTime: `${slot.start} - ${slot.end}`,
          slotType: slot.type,
          scheduleId: schedule._id
        }))
      );
      return [...acc, ...dayAssignments];
    }, []);
    
    res.status(200).json({ 
      success: true, 
      data: doctorAssignments 
    });
    
  } catch (error) {
    console.error("❌ getDoctorAssignments error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch doctor assignments",
      error: error.message 
    });
  }
};

/* -------------------------------------------------------------------------- */
/*                          ROLL WINDOW FORWARD                               */
/* -------------------------------------------------------------------------- */

const rollWindow = async (req, res) => {
  try {
    const medicalCenterId = req.medicalCenter._id;
    
    console.log('⏩ Rolling window forward for medical center:', medicalCenterId);
    
    let rollingSchedule = await RollingSchedule.findOne({
      medical_center_id: medicalCenterId,
      isActive: true
    });
    
    if (!rollingSchedule) {
      return res.status(404).json({ 
        success: false, 
        message: "Schedule not found" 
      });
    }
    
    // Move past days to historical data
    await movePastDaysToHistorical(rollingSchedule);
    
    // Ensure complete 21-day window
    await ensureCompleteWindow(rollingSchedule);
    
    // Update window dates
    const { windowStart, windowEnd } = getCurrentWindow();
    rollingSchedule.windowStart = windowStart;
    rollingSchedule.windowEnd = windowEnd;
    rollingSchedule.updatedAt = new Date();
    
    await rollingSchedule.save();
    
    // Populate before returning
    const updatedSchedule = await RollingSchedule.findById(rollingSchedule._id)
      .populate('assignedDoctors', 'name specialization')
      .populate({
        path: 'defaultDoctors.doctorId',
        model: 'Practitioner',
        select: 'name specialization'
      });
    
    res.status(200).json({
      success: true,
      message: "Window rolled forward successfully",
      data: updatedSchedule,
      windowInfo: {
        start: windowStart,
        end: windowEnd,
        totalDays: 21,
        today: new Date()
      }
    });
    
  } catch (error) {
    console.error("❌ rollWindow error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to roll window forward",
      error: error.message 
    });
  }
};

/* -------------------------------------------------------------------------- */
/*                          UPDATE TIME SLOT                                  */
/* -------------------------------------------------------------------------- */

const updateTimeSlot = async (req, res) => {
  try {
    const { scheduleId, date } = req.params;
    const { slotIndex, updates } = req.body;
    
    console.log('🔄 Updating time slot:', { scheduleId, date, slotIndex, updates });
    
    const rollingSchedule = await RollingSchedule.findOne({
      _id: scheduleId,
      medical_center_id: req.medicalCenter._id,
      isActive: true
    });
    
    if (!rollingSchedule) {
      return res.status(404).json({ 
        success: false, 
        message: "Schedule not found" 
      });
    }
    
    // Find the daily schedule for the specific date
    const dateStr = new Date(date).toISOString().split('T')[0];
    const dayIndex = rollingSchedule.dailySchedules.findIndex(
      day => new Date(day.date).toISOString().split('T')[0] === dateStr
    );
    
    if (dayIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: "Daily schedule not found for this date" 
      });
    }
    
    const daySchedule = rollingSchedule.dailySchedules[dayIndex];
    
    if (!daySchedule.timeSlots || slotIndex >= daySchedule.timeSlots.length) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid slot index" 
      });
    }
    
    const slot = daySchedule.timeSlots[slotIndex];
    
    // 🚫 CRITICAL: CHECK FOR EXISTING APPOINTMENTS BEFORE ALLOWING TIME CHANGES
    // Check if the update affects time (start or end)
    const isChangingTime = (updates.start && updates.start !== slot.start) || 
                          (updates.end && updates.end !== slot.end);
    
    if (isChangingTime) {
      // Check if there are existing appointments for this slot
      const Appointment = require('../models/Appointment'); // Add this import at top
      
      const existingAppointments = await Appointment.countDocuments({
        schedule_id: rollingSchedule._id,
        date: dateStr,
        startTime: slot.start,
        endTime: slot.end,
        status: { $nin: ['cancelled', 'completed'] }
      });
      
      if (existingAppointments > 0) {
        return res.status(400).json({
          success: false,
          message: "Cannot change time slot. Appointments already exist for this time slot."
        });
      }
    }
    
    // Check if capacity is being updated
    if (updates.capacity !== undefined) {
      const totalAssignedPatients = slot.assignedDoctors.reduce((sum, doc) => sum + (doc.maxPatients || 1), 0);
      
      // Check if capacity reduction affects existing appointments
      if (updates.capacity < slot.capacity) {
        const Appointment = require('../models/Appointment'); // Add this import at top
        
        const totalBookedAppointments = await Appointment.countDocuments({
          schedule_id: rollingSchedule._id,
          date: dateStr,
          startTime: slot.start,
          endTime: slot.end,
          status: { $nin: ['cancelled', 'completed'] }
        });
        
        if (totalBookedAppointments > updates.capacity) {
          return res.status(400).json({
            success: false,
            message: `Cannot reduce capacity to ${updates.capacity}. There are ${totalBookedAppointments} existing appointments.`
          });
        }
      }
      
      updates.availableCapacity = Math.max(0, updates.capacity - totalAssignedPatients);
    }
    
    // Apply updates
    Object.keys(updates).forEach(key => {
      slot[key] = updates[key];
    });
    
    // Recalculate day totals
    recalculateDailyScheduleTotals(daySchedule);
    
    rollingSchedule.updatedBy = req.medicalCenter._id;
    rollingSchedule.updatedAt = new Date();
    
    await rollingSchedule.save();
    
    res.status(200).json({ 
      success: true, 
      message: "Time slot updated successfully", 
      data: daySchedule 
    });
    
  } catch (error) {
    console.error("❌ updateTimeSlot error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to update time slot",
      error: error.message 
    });
  }
};

/* -------------------------------------------------------------------------- */
/*                     GET DOCTOR PERSONAL SCHEDULE                           */
/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
/*                     GET DOCTOR PERSONAL SCHEDULE                           */
/* -------------------------------------------------------------------------- */
const getDoctorPersonalSchedule = async (req, res) => {
  try {
    console.log('🔄 Doctor personal schedule endpoint called');
    
    // Check if practitioner is available
    if (!req.practitioner || !req.practitioner._id) {
      console.error('❌ Practitioner not found in request');
      return res.status(401).json({
        success: false,
        message: "Practitioner authentication required"
      });
    }

    const practitionerId = req.practitioner._id;
    
    // Find which medical center the practitioner belongs to
    // First check the session data (req.practitioner)
    let medicalCenters = req.practitioner.medical_center_ids;
    
    console.log('🏥 Medical centers from session:', {
      medical_center_ids: req.practitioner.medical_center_ids,
      medicalCenters,
      hasData: !!medicalCenters,
      length: medicalCenters?.length || 0
    });
    
    // If not in session, get from database
    if (!medicalCenters || medicalCenters.length === 0) {
      console.log('🔍 Fetching practitioner from database...');
      const practitionerDoc = await Practitioner.findById(practitionerId);
      
      if (!practitionerDoc) {
        return res.status(404).json({
          success: false,
          message: "Practitioner not found"
        });
      }
      
      medicalCenters = practitionerDoc.medical_center_ids;
      console.log('🏥 Medical centers from database:', {
        medical_center_ids: practitionerDoc.medical_center_ids,
        length: medicalCenters?.length || 0
      });
    }
    
    // Check if we have any medical centers
    if (!medicalCenters || medicalCenters.length === 0) {
      console.error('❌ Practitioner has no medical centers assigned:', {
        practitionerId,
        practitionerName: req.practitioner.name
      });
      return res.status(400).json({
        success: true, // Return success but with empty data
        message: "Practitioner is not associated with any medical center",
        data: {
          dailySchedules: [],
          doctorInfo: {
            id: practitionerId,
            name: req.practitioner.name,
            specialization: req.practitioner.specialization || 'General'
          }
        },
        windowInfo: {
          start: new Date(),
          end: new Date(),
          totalDays: 21,
          today: new Date()
        }
      });
    }

    const medicalCenterId = medicalCenters[0];
    const { windowStart, windowEnd } = getCurrentWindow();
    
    console.log(`👨‍⚕️ Getting personal schedule for practitioner: ${practitionerId}`);
    console.log(`🏥 Medical center: ${medicalCenterId}`);
    
    // Find the rolling schedule for the medical center
    let rollingSchedule = await RollingSchedule.findOne({
      medical_center_id: medicalCenterId,
      isActive: true
    });
    
    console.log('📅 Rolling schedule found:', !!rollingSchedule);
    
    if (!rollingSchedule) {
      console.log('📝 No schedule found, returning empty schedule');
      return res.status(200).json({
        success: true,
        data: {
          dailySchedules: [],
          doctorInfo: {
            id: practitionerId,
            name: req.practitioner.name,
            specialization: req.practitioner.specialization || 'General'
          }
        },
        windowInfo: {
          start: windowStart,
          end: windowEnd,
          totalDays: 21,
          today: new Date()
        }
      });
    }
    
    console.log(`📊 Schedule has ${rollingSchedule.dailySchedules?.length || 0} days`);
    
    // Filter schedule for this specific doctor
    const doctorSchedule = {
      dailySchedules: rollingSchedule.dailySchedules.map(day => {
        // Filter slots assigned to this practitioner
        const filteredSlots = day.timeSlots.filter(slot => {
          if (!slot.assignedDoctors || !Array.isArray(slot.assignedDoctors)) return false;
          
          return slot.assignedDoctors.some(doc => {
            const match = doc.doctorId && doc.doctorId.toString() === practitionerId.toString();
            if (match) {
              console.log(`✅ Found doctor ${practitionerId} in slot ${slot.id} at ${slot.start}-${slot.end}`);
            }
            return match;
          });
        });
        
        console.log(`📅 Day ${day.date}: ${filteredSlots.length} slots for this doctor`);
        
        return {
          date: day.date,
          dayName: day.dayName,
          dayOfWeek: day.dayOfWeek,
          isWorking: day.isWorking,
          timeSlots: filteredSlots.map(slot => {
            // Find this doctor's assignment
            const doctorAssignment = slot.assignedDoctors.find(doc => 
              doc.doctorId && doc.doctorId.toString() === practitionerId.toString()
            );
            
            return {
              id: slot.id || `${day.date}-${slot.start}-${slot.end}`,
              start: slot.start,
              end: slot.end,
              type: slot.type || 'working',
              slotType: slot.slotType || 'standard',
              capacity: slot.capacity || 10,
              availableCapacity: slot.availableCapacity || slot.capacity || 10,
              assignedDoctors: doctorAssignment ? [doctorAssignment] : [],
              consultationType: doctorAssignment?.consultationType || slot.consultationType || 'face-to-face',
              specialization: doctorAssignment?.specialization?.[0] || slot.specialization || 'general',
              isPeakHour: !!slot.isPeakHour,
              duration: slot.duration || 30,
              maxPatients: doctorAssignment?.maxPatients || 1,
              currentPatients: doctorAssignment?.currentPatients || 0,
              doctorId: practitionerId,
              doctorName: doctorAssignment?.doctorName || req.practitioner.name || 'Unknown Doctor'
            };
          }),
          totalAssignedSlots: filteredSlots.length,
          totalCapacity: filteredSlots.reduce((sum, slot) => sum + (slot.capacity || 0), 0),
         
        };
      }).filter(day => day.timeSlots.length > 0) // Only include days with assignments
    };
    
    console.log(`📊 Returning ${doctorSchedule.dailySchedules.length} days with appointments`);
    
    res.status(200).json({
      success: true,
      data: doctorSchedule,
      windowInfo: {
        start: windowStart,
        end: windowEnd,
        totalDays: 21,
        today: new Date()
      },
      doctorInfo: {
        id: practitionerId,
        name: req.practitioner.name,
        specialization: req.practitioner.specialization || 'General'
      }
    });
    
  } catch (error) {
    console.error("❌ getDoctorPersonalSchedule error:", error);
    console.error("❌ Error stack:", error.stack);
    res.status(500).json({ 
      success: false, 
      message: "Failed to load doctor schedule",
      error: error.message
    });
  }
};
/* -------------------------------------------------------------------------- */
/*                          EXPORTS                                           */
/* -------------------------------------------------------------------------- */

/**
 * @desc    Get public rolling window schedule for a specific medical center
 * @route   GET /api/editing-next-week/public/rolling-window/:medicalCenterId
 * @access  Public
 */
const getPublicRollingWindow = async (req, res) => {
  try {
    const { medicalCenterId } = req.params;
    
    if (!medicalCenterId) {
      return res.status(400).json({
        success: false,
        message: 'Medical center ID is required'
      });
    }

    const { windowStart, windowEnd } = getCurrentWindow();
    
    // Find the active rolling schedule for this medical center
    const rollingSchedule = await RollingSchedule.findOne({
      medical_center_id: medicalCenterId,
      isActive: true
    }).populate({
      path: 'dailySchedules.timeSlots.assignedDoctors.doctorId',
      select: 'full_name role specialties verification_status is_active',
      model: 'Practitioner'
    }).populate({
      path: 'defaultDoctors.doctorId',
      select: 'full_name role specialties',
      model: 'Practitioner'
    }).lean();

    if (!rollingSchedule) {
      return res.status(404).json({
        success: false,
        message: 'No active schedule found for this medical center'
      });
    }

    // Filter to only show schedules within the current window
    const currentSchedule = {
      ...rollingSchedule,
      dailySchedules: rollingSchedule.dailySchedules
        .filter(schedule => {
          const scheduleDate = new Date(schedule.date);
          return scheduleDate >= windowStart && scheduleDate < windowEnd;
        })
        .map(schedule => ({
          date: schedule.date,
          dayName: schedule.dayName,
          isWorking: schedule.isWorking,
          timeSlots: schedule.timeSlots.map(slot => ({
            id: slot.id,
            start: slot.start,
            end: slot.end,
            capacity: slot.capacity,
            availableCapacity: slot.availableCapacity,
            type: slot.type,
            isPeakHour: slot.isPeakHour,
            assignedDoctors: slot.assignedDoctors.map(doc => ({
              doctorId: doc.doctorId?._id || doc.doctorId,
              doctorName: doc.doctorName || doc.doctorId?.full_name,
              specialization: doc.specialization,
              consultationType: doc.consultationType,
              colorCode: doc.colorCode
            })).filter(doc => doc.doctorId), // Filter out empty doctor entries
            specialization: slot.specialization,
            specializations: slot.specializations,
            consultationType: slot.consultationType
          })),
          lunchBreaks: schedule.lunchBreaks,
          sessions: schedule.sessions
        }))
    };

    res.status(200).json({
      success: true,
      data: currentSchedule
    });

  } catch (error) {
    console.error('Error in getPublicRollingWindow:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

/**
 * @desc    Get public rolling window schedule by medical center ID query
 * @route   GET /api/editing-next-week/public/rolling-window?medicalCenterId=
 * @access  Public
 */
const getPublicRollingWindowByQuery = async (req, res) => {
  try {
    const { medicalCenterId } = req.query;
    
    if (!medicalCenterId) {
      return res.status(400).json({
        success: false,
        message: 'Medical center ID is required as query parameter'
      });
    }

    // Reuse the same logic as above
    req.params = { medicalCenterId };
    return getPublicRollingWindow(req, res);

  } catch (error) {
    console.error('Error in getPublicRollingWindowByQuery:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

module.exports = {
  // Main rolling window functions
  getRollingWindow,
  updateDailySchedule,
  assignDoctorToSlot,
  removeDoctorFromSlot,
  updateSlotDuration,
  addLunchBreak,
  removeLunchBreak,
  updateSession,
  toggleWorkingDay,
  getDoctorAssignments,
  rollWindow,
  updateTimeSlot,

  getPublicRollingWindow,
  getPublicRollingWindowByQuery,
 
 

  getDoctorPersonalSchedule,
  // Helper functions (for testing if needed)
  getCurrentWindow,
  isInRollingWindow,
  isPastDate,
  generateDoctorColor,
  generateTimeSlots,
  recalculateDailyScheduleTotals,
  
  // Legacy compatibility functions
  createWeeklySchedule: async (req, res) => {
    return getRollingWindow(req, res);
  },
  
  getWeeklySchedules: async (req, res) => {
    return getRollingWindow(req, res);
  },
  
  getWeeklySchedule: async (req, res) => {
    try {
      const schedule = await RollingSchedule.findOne({
        _id: req.params.id,
        medical_center_id: req.medicalCenter._id,
        isActive: true
      })
      .populate('assignedDoctors', 'name specialization email')
      .populate({
        path: 'defaultDoctors.doctorId',
        model: 'Practitioner',
        select: 'name specialization'
      });
      
      if (!schedule) {
        return res.status(404).json({ 
          success: false, 
          message: "Schedule not found" 
        });
      }
      
      res.status(200).json({ 
        success: true, 
        data: schedule 
      });
      
    } catch (error) {
      console.error("❌ getWeeklySchedule error:", error);
      res.status(500).json({ 
        success: false, 
        message: "Failed to fetch schedule",
        error: error.message 
      });
    }
  },
  
  updateWeeklySchedule: async (req, res) => {
    try {
      const { id } = req.params;
      const updateData = req.body;
      
      const schedule = await RollingSchedule.findOneAndUpdate(
        { 
          _id: id, 
          medical_center_id: req.medicalCenter._id 
        },
        {
          ...updateData,
          updatedBy: req.medicalCenter._id,
          updatedAt: new Date()
        },
        { 
          new: true, 
          runValidators: true 
        }
      )
      .populate('assignedDoctors', 'name specialization')
      .populate({
        path: 'defaultDoctors.doctorId',
        model: 'Practitioner',
        select: 'name specialization'
      });
      
      if (!schedule) {
        return res.status(404).json({ 
          success: false, 
          message: "Schedule not found" 
        });
      }
      
      res.status(200).json({
        success: true,
        message: "Schedule updated successfully",
        data: schedule
      });
      
    } catch (error) {
      console.error("❌ updateWeeklySchedule error:", error);
      res.status(500).json({ 
        success: false, 
        message: "Failed to update schedule",
        error: error.message 
      });
    }
  }
};