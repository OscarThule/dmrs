// Validation middleware for default operational hours
const validateDefaultOperationalHours = (req, res, next) => {
  const { defaultHours, slotDuration, bufferTime } = req.body;

  // Validate slotDuration
  if (slotDuration !== undefined) {
    if (typeof slotDuration !== 'number' || slotDuration < 5 || slotDuration > 120) {
      return res.status(400).json({
        success: false,
        message: 'slotDuration must be a number between 5 and 120 minutes'
      });
    }
  }

  // Validate bufferTime
  if (bufferTime !== undefined) {
    if (typeof bufferTime !== 'number' || bufferTime < 0 || bufferTime > 60) {
      return res.status(400).json({
        success: false,
        message: 'bufferTime must be a number between 0 and 60 minutes'
      });
    }
  }

  // Validate defaultHours structure if provided
  if (defaultHours) {
    if (typeof defaultHours !== 'object' || Array.isArray(defaultHours)) {
      return res.status(400).json({
        success: false,
        message: 'defaultHours must be an object'
      });
    }

    const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const providedDays = Object.keys(defaultHours);

    // Check for invalid days
    const invalidDays = providedDays.filter(day => !validDays.includes(day));
    if (invalidDays.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Invalid days provided: ${invalidDays.join(', ')}. Valid days are: ${validDays.join(', ')}`
      });
    }

    // Validate each day's structure
    for (const day of providedDays) {
      const dayData = defaultHours[day];
      
      if (typeof dayData !== 'object') {
        return res.status(400).json({
          success: false,
          message: `Invalid structure for ${day}. Must be an object.`
        });
      }

      // Validate sessions
      const sessions = ['morning', 'afternoon', 'night'];
      for (const session of sessions) {
        if (dayData[session]) {
          const sessionData = dayData[session];
          
          if (typeof sessionData !== 'object') {
            return res.status(400).json({
              success: false,
              message: `Invalid ${session} session structure for ${day}. Must be an object.`
            });
          }

          // Validate session times
          if (sessionData.start && !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(sessionData.start)) {
            return res.status(400).json({
              success: false,
              message: `Invalid start time format for ${day} ${session}. Use HH:MM format.`
            });
          }

          if (sessionData.end && !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(sessionData.end)) {
            return res.status(400).json({
              success: false,
              message: `Invalid end time format for ${day} ${session}. Use HH:MM format.`
            });
          }
        }
      }
    }
  }

  next();
};

module.exports = {
  validateDefaultOperationalHours
};