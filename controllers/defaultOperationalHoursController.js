const DefaultOperationalHours = require('../models/DefaultOperationalHours');

// @desc    Get default operational hours for medical center
// @route   GET /api/default-operational-hours
// @access  Private
const getDefaultOperationalHours = async (req, res) => {
  try {
    console.log('Fetching default operational hours for medical center:', req.medicalCenter._id);
    
    let defaultHours = await DefaultOperationalHours.findOne({
      medical_center_id: req.medicalCenter._id
    }).populate('created_by', 'name email')
      .populate('last_updated_by', 'name email');

    // If no default hours exist, create with initial template
    if (!defaultHours) {
      console.log('No existing default hours found, creating new template...');
      
      const initialDefaultHours = {
        monday: {
          morning: { start: '08:00', end: '12:00', enabled: true },
          afternoon: { start: '13:00', end: '17:00', enabled: true },
          night: { start: '18:00', end: '22:00', enabled: false },
          lunches: [{
            id: 'lunch-1',
            start: '12:00',
            end: '13:00',
            reason: 'Lunch Break',
            duration: 60,
            enabled: true,
            recurring: true,
            affectedStaff: []
          }],
          nightLunches: []
        },
        tuesday: {
          morning: { start: '08:00', end: '12:00', enabled: true },
          afternoon: { start: '13:00', end: '17:00', enabled: true },
          night: { start: '18:00', end: '22:00', enabled: false },
          lunches: [{
            id: 'lunch-1',
            start: '12:00',
            end: '13:00',
            reason: 'Lunch Break',
            duration: 60,
            enabled: true,
            recurring: true,
            affectedStaff: []
          }],
          nightLunches: []
        },
        wednesday: {
          morning: { start: '08:00', end: '12:00', enabled: true },
          afternoon: { start: '13:00', end: '17:00', enabled: true },
          night: { start: '18:00', end: '22:00', enabled: false },
          lunches: [{
            id: 'lunch-1',
            start: '12:00',
            end: '13:00',
            reason: 'Lunch Break',
            duration: 60,
            enabled: true,
            recurring: true,
            affectedStaff: []
          }],
          nightLunches: []
        },
        thursday: {
          morning: { start: '08:00', end: '12:00', enabled: true },
          afternoon: { start: '13:00', end: '17:00', enabled: true },
          night: { start: '18:00', end: '22:00', enabled: false },
          lunches: [{
            id: 'lunch-1',
            start: '12:00',
            end: '13:00',
            reason: 'Lunch Break',
            duration: 60,
            enabled: true,
            recurring: true,
            affectedStaff: []
          }],
          nightLunches: []
        },
        friday: {
          morning: { start: '08:00', end: '12:00', enabled: true },
          afternoon: { start: '13:00', end: '17:00', enabled: true },
          night: { start: '18:00', end: '22:00', enabled: false },
          lunches: [{
            id: 'lunch-1',
            start: '12:00',
            end: '13:00',
            reason: 'Lunch Break',
            duration: 60,
            enabled: true,
            recurring: true,
            affectedStaff: []
          }],
          nightLunches: []
        },
        saturday: {
          morning: { start: '09:00', end: '13:00', enabled: true },
          afternoon: { start: '14:00', end: '18:00', enabled: true },
          night: { start: '19:00', end: '22:00', enabled: false },
          lunches: [{
            id: 'lunch-1',
            start: '13:00',
            end: '14:00',
            reason: 'Lunch Break',
            duration: 60,
            enabled: true,
            recurring: true,
            affectedStaff: []
          }],
          nightLunches: []
        },
        sunday: {
          morning: { start: '10:00', end: '14:00', enabled: false },
          afternoon: { start: '15:00', end: '19:00', enabled: false },
          night: { start: '20:00', end: '23:00', enabled: false },
          lunches: [],
          nightLunches: []
        }
      };

      defaultHours = await DefaultOperationalHours.create({
        medical_center_id: req.medicalCenter._id,
        defaultHours: initialDefaultHours,
        slotDuration: 30,
        bufferTime: 0,
       created_by: req.medicalCenter._id,
       last_updated_by: req.medicalCenter._id

      });

      await defaultHours.populate('created_by', 'name email');
      await defaultHours.populate('last_updated_by', 'name email');
      
      console.log('New default hours created successfully');
    } else {
      console.log('Found existing default hours');
    }

    res.status(200).json({
      success: true,
      data: defaultHours
    });
  } catch (error) {
    console.error('Get default operational hours error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching default operational hours',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

// @desc    Update default operational hours
// @route   PUT /api/default-operational-hours
// @access  Private
const updateDefaultOperationalHours = async (req, res) => {
  try {
    const { defaultHours, slotDuration, bufferTime } = req.body;

    console.log('Updating default operational hours for medical center:', req.medicalCenter._id);
    console.log('Received data:', { defaultHours: !!defaultHours, slotDuration, bufferTime });

    if (!defaultHours) {
      return res.status(400).json({
        success: false,
        message: 'Please provide defaultHours'
      });
    }

    // Validate the structure of defaultHours
    if (typeof defaultHours !== 'object' || Object.keys(defaultHours).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid defaultHours structure'
      });
    }

    let operationalHours = await DefaultOperationalHours.findOne({
      medical_center_id: req.medicalCenter._id
    });

    if (operationalHours) {
      // Update existing
      console.log('Updating existing operational hours');
      operationalHours.defaultHours = defaultHours;
      if (slotDuration !== undefined) operationalHours.slotDuration = slotDuration;
      if (bufferTime !== undefined) operationalHours.bufferTime = bufferTime;
      operationalHours.last_updated_by = req.medicalCenter._id;
      operationalHours.updated_at = new Date();
    } else {
      // Create new
      console.log('Creating new operational hours document');
      operationalHours = await DefaultOperationalHours.create({
        medical_center_id: req.medicalCenter._id,
        defaultHours,
        slotDuration: slotDuration || 30,
        bufferTime: bufferTime || 0,
        created_by: req.medicalCenter._id,
        last_updated_by: req.medicalCenter._id

      });
    }

    const savedHours = await operationalHours.save();
    
    await savedHours.populate('created_by', 'name email');
    await savedHours.populate('last_updated_by', 'name email');

    console.log('Default operational hours updated successfully');

    res.status(200).json({
      success: true,
      message: 'Default operational hours updated successfully',
      data: savedHours
    });
  } catch (error) {
    console.error('Update default operational hours error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating default operational hours',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

// @desc    Reset default operational hours to template
// @route   POST /api/default-operational-hours/reset
// @access  Private
const resetDefaultOperationalHours = async (req, res) => {
  try {
    console.log('Resetting default operational hours for medical center:', req.medicalCenter._id);

    const templateDefaultHours = {
      monday: {
        morning: { start: '08:00', end: '12:00', enabled: true },
        afternoon: { start: '13:00', end: '17:00', enabled: true },
        night: { start: '18:00', end: '22:00', enabled: false },
        lunches: [{
          id: 'lunch-1',
          start: '12:00',
          end: '13:00',
          reason: 'Lunch Break',
          duration: 60,
          enabled: true,
          recurring: true,
          affectedStaff: []
        }],
        nightLunches: []
      },
      tuesday: {
        morning: { start: '08:00', end: '12:00', enabled: true },
        afternoon: { start: '13:00', end: '17:00', enabled: true },
        night: { start: '18:00', end: '22:00', enabled: false },
        lunches: [{
          id: 'lunch-1',
          start: '12:00',
          end: '13:00',
          reason: 'Lunch Break',
          duration: 60,
          enabled: true,
          recurring: true,
          affectedStaff: []
        }],
        nightLunches: []
      },
      wednesday: {
        morning: { start: '08:00', end: '12:00', enabled: true },
        afternoon: { start: '13:00', end: '17:00', enabled: true },
        night: { start: '18:00', end: '22:00', enabled: false },
        lunches: [{
          id: 'lunch-1',
          start: '12:00',
          end: '13:00',
          reason: 'Lunch Break',
          duration: 60,
          enabled: true,
          recurring: true,
          affectedStaff: []
        }],
        nightLunches: []
      },
      thursday: {
        morning: { start: '08:00', end: '12:00', enabled: true },
        afternoon: { start: '13:00', end: '17:00', enabled: true },
        night: { start: '18:00', end: '22:00', enabled: false },
        lunches: [{
          id: 'lunch-1',
          start: '12:00',
          end: '13:00',
          reason: 'Lunch Break',
          duration: 60,
          enabled: true,
          recurring: true,
          affectedStaff: []
        }],
        nightLunches: []
      },
      friday: {
        morning: { start: '08:00', end: '12:00', enabled: true },
        afternoon: { start: '13:00', end: '17:00', enabled: true },
        night: { start: '18:00', end: '22:00', enabled: false },
        lunches: [{
          id: 'lunch-1',
          start: '12:00',
          end: '13:00',
          reason: 'Lunch Break',
          duration: 60,
          enabled: true,
          recurring: true,
          affectedStaff: []
        }],
        nightLunches: []
      },
      saturday: {
        morning: { start: '09:00', end: '13:00', enabled: true },
        afternoon: { start: '14:00', end: '18:00', enabled: true },
        night: { start: '19:00', end: '22:00', enabled: false },
        lunches: [{
          id: 'lunch-1',
          start: '13:00',
          end: '14:00',
          reason: 'Lunch Break',
          duration: 60,
          enabled: true,
          recurring: true,
          affectedStaff: []
        }],
        nightLunches: []
      },
      sunday: {
        morning: { start: '10:00', end: '14:00', enabled: false },
        afternoon: { start: '15:00', end: '19:00', enabled: false },
        night: { start: '20:00', end: '23:00', enabled: false },
        lunches: [],
        nightLunches: []
      }
    };

    let operationalHours = await DefaultOperationalHours.findOne({
      medical_center_id: req.medicalCenter._id
    });

    if (operationalHours) {
      console.log('Resetting existing operational hours to template');
      operationalHours.defaultHours = templateDefaultHours;
      operationalHours.slotDuration = 30;
      operationalHours.bufferTime = 0;
      operationalHours.last_updated_by = req.medicalCenter._id;
      operationalHours.updated_at = new Date();
    } else {
      console.log('Creating new operational hours with template');
      operationalHours = await DefaultOperationalHours.create({
        medical_center_id: req.medicalCenter._id,
        defaultHours: templateDefaultHours,
        slotDuration: 30,
        bufferTime: 0,
        created_by: req.medicalCenter._id,
        last_updated_by: req.medicalCenter._id

      });
    }

    const savedHours = await operationalHours.save();
    
    await savedHours.populate('created_by', 'name email');
    await savedHours.populate('last_updated_by', 'name email');

    console.log('Default operational hours reset successfully');

    res.status(200).json({
      success: true,
      message: 'Default operational hours reset to template successfully',
      data: savedHours
    });
  } catch (error) {
    console.error('Reset default operational hours error:', error);
    res.status(500).json({
      success: false,
      message: 'Error resetting default operational hours',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

module.exports = {
  getDefaultOperationalHours,
  updateDefaultOperationalHours,
  resetDefaultOperationalHours
};