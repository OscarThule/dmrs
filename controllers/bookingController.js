// controllers/bookingController.js
const mongoose = require('mongoose');
const Appointment = require('../models/Appointments');
const { RollingSchedule } = require('../models/editingNextWeek');
const MedicalCenter = require('../models/MedicalCenter');
const Practitioner = require('../models/Practitioner');
const Patient = require('../models/Patient');
const Payment = require('../models/Payment');
const { initializeAppointmentPayment } = require('../services/paymentService');
const { v4: uuidv4 } = require('uuid');

/**
 * @desc    Create appointment with pending payment status (Holds slot)
 * @route   POST /api/bookings
 * @access  Patient
 */
const createPendingAppointment = async (req, res) => {
  try {
    if (!req.patient) {
      return res.status(401).json({
        success: false,
        message: "Patient authentication required"
      });
    }

    const {
      medical_center_id,
      schedule_id,
      date,
      slot_id,
      practitioner_id,
      reason_for_visit,
      symptoms,
      preferred_specialization,
      consultation_type = "face-to-face"
    } = req.body;

    // ================= VALIDATION =================
    const requiredFields = [
      "medical_center_id",
      "schedule_id",
      "date",
      "slot_id",
      "practitioner_id",
      "reason_for_visit"
    ];

    const missing = requiredFields.filter(f => !req.body[f]);
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(", ")}`
      });
    }

    const appointmentDate = new Date(date);
    
    const dayOnly = new Date(appointmentDate);
dayOnly.setHours(0,0,0,0);


    if (isNaN(appointmentDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format"
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (appointmentDate < today) {
      return res.status(400).json({
        success: false,
        message: "Cannot book appointments in the past"
      });
    }

    // ================= LOAD SCHEDULE =================
    const schedule = await RollingSchedule.findOne({
      _id: schedule_id,
      medical_center_id
    });

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Schedule not found"
      });
    }

    const dateStr = appointmentDate.toISOString().split("T")[0];

    const dayIndex = schedule.dailySchedules.findIndex(d =>
      new Date(d.date).toISOString().split("T")[0] === dateStr
    );

    if (dayIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "No schedule found for this date"
      });
    }

    const daySchedule = schedule.dailySchedules[dayIndex];

    if (!daySchedule.isWorking) {
      return res.status(400).json({
        success: false,
        message: "Medical center is not working on this day"
      });
    }

    // ================= SLOT CHECK =================
    let slot = daySchedule.timeSlots.find(s => s.id === slot_id);
    let isShiftedSlot = false;

    if (!slot) {
      slot = daySchedule.timeSlots.find(s => s.shiftedFrom === slot_id);
      if (slot) isShiftedSlot = true;
    }

    if (!slot) {
      return res.status(404).json({
        success: false,
        message: "Time slot not found"
      });
    }

    

    // ================= DOCTOR CHECK =================
    const doctorAssignment = slot.assignedDoctors.find(d =>
      d.doctorId && d.doctorId.toString() === practitioner_id.toString()
    );

    if (!doctorAssignment) {
      return res.status(404).json({
        success: false,
        message: "Selected doctor not available in this slot"
      });
    }

    if (
      preferred_specialization &&
      !doctorAssignment.specialization.includes(preferred_specialization) &&
      !doctorAssignment.specialization.includes("general")
    ) {
      return res.status(400).json({
  success: false,
  message: `Doctor does not specialize in ${preferred_specialization}`
}); 

    }

    // ================= DUPLICATE CHECK =================
    const existing = await Appointment.findOne({
      patient_id: req.patient._id,
      date: appointmentDate,
      slot_start: slot.start,
      status: { $in: ["pending", "confirmed"] }
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: "You already have an appointment at this time"
      });
    }

    const startOfDay = new Date(appointmentDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(appointmentDate);
    endOfDay.setHours(23, 59, 59, 999);

    const alreadyToday = await Appointment.findOne({
      patient_id: req.patient._id,
      date: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["pending", "confirmed"] }
    });

    if (alreadyToday) {
      return res.status(400).json({
        success: false,
        message: "You already have an appointment for this day"
      });
    }

    // ================= LOAD MAIN DATA =================
    const [patient, medicalCenter, practitioner] = await Promise.all([
      Patient.findById(req.patient._id),
      MedicalCenter.findById(medical_center_id),
      Practitioner.findById(practitioner_id)
    ]);

    if (!patient || !medicalCenter || !practitioner) {
      return res.status(404).json({
        success: false,
        message: "Patient, medical center or practitioner not found"
      });
    }

    // ================= PRICING LOGIC (DEPOSIT ONLY) =================
const paymentSettings = medicalCenter.paymentSettings;

const depositAmount = Number(paymentSettings?.bookingDeposit || 0);

if (!depositAmount || depositAmount <= 0) {
  return res.status(400).json({
    success: false,
    message: "Booking deposit not configured for this medical center"
  });
}

// Platform fee: 10% of deposit or minimum R50
const tenPercent = depositAmount * 0.10;
const platformFee = Math.max(50, tenPercent);

// User only pays deposit + platform fee
const totalAmount = depositAmount + platformFee;


    // ================= HOLD SLOT (ATOMIC) =================
const holdResult = await RollingSchedule.updateOne(
  {
    _id: schedule_id,
    medical_center_id,
    "dailySchedules.date": dayOnly,
    "dailySchedules.timeSlots.id": slot.id,
    "dailySchedules.timeSlots.availableCapacity": { $gt: 0 }
  },
  {
    $inc: {
      "dailySchedules.$[d].timeSlots.$[s].availableCapacity": -1
    }
  },
  {
    arrayFilters: [
      { "d.date": dayOnly },
      { "s.id": slot.id }
    ]
  }
);


if (holdResult.modifiedCount === 0) {
  return res.status(409).json({
    success: false,
    message: "This slot was just taken by another patient. Please choose another slot."
  });
}


    // ================= CREATE APPOINTMENT =================
    const appointment = new Appointment({
      appointment_id: `APT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      patient_id: req.patient._id,
      medical_center_id,
      practitioner_id,
      schedule_id,
      date: appointmentDate,
      slot_id: slot.id,
      original_slot_id: isShiftedSlot ? slot.shiftedFrom : null,
      slot_start: slot.start,
      slot_end: slot.end,
      doctor_name: practitioner.full_name || doctorAssignment.doctorName,
      doctor_specialization: doctorAssignment.specialization,
      patient_name: `${patient.firstName} ${patient.lastName}`,
      patient_email: patient.email,
      patient_phone: patient.phone,
      reason_for_visit,
      symptoms: symptoms || "",
      preferred_specialization: preferred_specialization || "general",
      consultation_type,
      status: "pending",
      payment_status: "pending",
      is_paid: false,
      appointment_duration: slot.duration || 30,
      is_shifted_slot: isShiftedSlot,
      shift_notes: isShiftedSlot ? "Shifted from original slot" : "",
      payment_reference: null
    });

    const paymentReference = `PAY-${uuidv4().replace(/-/g, "").substring(0, 16)}`;
    appointment.payment_reference = paymentReference;

    
    // ================= CREATE PAYMENT =================
    const payment = new Payment({
      reference: paymentReference,
      appointment_id: appointment._id,
      patient_id: req.patient._id,
      amount: totalAmount,
      currency: "ZAR",
      status: "pending",
      metadata: {
        appointment_id: appointment._id.toString(),
        patient_id: req.patient._id.toString(),
        medical_center_id,
        practitioner_id,
        slot_id: slot.id,
        date: dateStr,
        time: `${slot.start} - ${slot.end}`,
        reason_for_visit,
        consultation_type,
      deposit_amount: depositAmount,
platform_fee: platformFee,
total_paid: totalAmount
      }
    }); // ================= INIT PAYSTACK =================
    const subaccountCode = medicalCenter.paystack?.subaccount_code;

if (!subaccountCode) {
  return res.status(400).json({
    success: false,
    message: "Medical center has no active payout subaccount"
  });
}

    
    
    
    
    const paymentResponse = await initializeAppointmentPayment({
  email: patient.email,
  amount: totalAmount,
  reference: paymentReference,
  subaccount_code: subaccountCode,
  metadata: {
    appointment_id: appointment._id.toString(),
    patient_id: req.patient._id.toString(),
    medical_center_id: medical_center_id
  }
});
await Promise.all([
      appointment.save(),
      payment.save(),
      schedule.save()
    ]);

    return res.status(201).json({
      success: true,
      message: "Appointment created. Complete payment to confirm.",
      data: {
        appointment,
        payment: {
          reference: paymentReference,
          amount: totalAmount,
          authorization_url: paymentResponse.authorization_url,
          expires_at: new Date(Date.now() + 3 * 60 * 1000)
        }
      }
    });

  } catch (error) {
    console.error("❌ createPendingAppointment error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create appointment",
      code: "INTERNAL_ERROR"
    });
 
      }


   


  

};



/**
 * @desc    Confirm appointment after successful payment (Webhook handler)
 * @route   PUT /api/bookings/confirm
 * @access  Private (Webhook)
 */
const confirmAppointmentPayment = async (reference) => {
  try {
    const payment = await Payment.findOne({ reference });
    if (!payment) return;

    if (payment.status === "success") return;

    const appointment = await Appointment.findById(payment.appointment_id);
    if (!appointment) return;

    if (appointment.status !== "pending") return;

    // Update payment
    payment.status = "success";
    payment.metadata = {
      ...payment.metadata,
      confirmed_at: new Date(),
      confirmed_by: "paystack_webhook",
    };

    // Update appointment
    appointment.status = "confirmed";
appointment.payment_status = "success";
appointment.is_paid = true;
appointment.payment_reference = reference;


    await payment.save();
    await appointment.save();
  } catch (err) {
    console.error("Confirm payment error:", err);
  }
};


const cancelFailedPaymentAppointment = async (reference, reason = "Payment failed") => {
  try {
    if (!reference) return;

    const payment = await Payment.findOne({ reference });
    if (!payment) return;

    // If already processed, stop
    if (payment.status === "failed") return;

    const appointment = await Appointment.findById(payment.appointment_id);
    if (!appointment) return;

    // Only clean pending appointments
    if (appointment.status === "cancelled") return;

    // 1. Update payment
    payment.status = "failed";
    payment.metadata = {
      ...payment.metadata,
      failed_at: new Date(),
      failure_reason: reason
    };

    // 2. Update appointment
    appointment.status = "cancelled";
    appointment.payment_status = "failed";
    appointment.is_paid = false;
    appointment.cancellation_reason = reason;
    appointment.cancelled_by = "system";
    appointment.cancelled_at = new Date();
    appointment.payment_reference = reference;

    // 3. Release slot atomically
    await RollingSchedule.updateOne(
      {
        _id: appointment.schedule_id,
        medical_center_id: appointment.medical_center_id,
        "dailySchedules.date": appointment.date,
        "dailySchedules.timeSlots.id": appointment.slot_id
      },
      {
        $inc: {
          "dailySchedules.$[d].timeSlots.$[s].availableCapacity": 1
        }
      },
      {
        arrayFilters: [
          { "d.date": appointment.date },
          { "s.id": appointment.slot_id }
        ]
      }
    );

    // 4. Decrease doctor count atomically
    await RollingSchedule.updateOne(
      {
        _id: appointment.schedule_id,
        medical_center_id: appointment.medical_center_id,
        "dailySchedules.date": appointment.date,
        "dailySchedules.timeSlots.id": appointment.slot_id,
        "dailySchedules.timeSlots.assignedDoctors.doctorId": appointment.practitioner_id
      },
      {
        $inc: {
          "dailySchedules.$[d].timeSlots.$[s].assignedDoctors.$[doc].currentPatients": -1
        }
      },
      {
        arrayFilters: [
          { "d.date": appointment.date },
          { "s.id": appointment.slot_id },
          { "doc.doctorId": appointment.practitioner_id }
        ]
      }
    );

    await payment.save();
    await appointment.save();

    // Optional: hard delete unpaid expired bookings
    if (!appointment.is_paid) {
      await Appointment.deleteOne({ _id: appointment._id });
    }

  } catch (err) {
    console.error("❌ cancelFailedPaymentAppointment error:", err);
  }
};





/**
 * @desc    Get appointment payment status
 * @route   GET /api/bookings/:id/payment-status
 * @access  Patient
 */
const getAppointmentPaymentStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found"
      });
    }

    // Check ownership
    if (req.userType === 'patient' && appointment.patient_id.toString() !== req.patient._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Not authorized"
      });
    }

    const payment = await Payment.findOne({ appointment_id: id });
    
    return res.status(200).json({
      success: true,
      data: {
        appointment_status: appointment.status,
        payment_status: appointment.payment_status,
        payment_reference: appointment.payment_reference,
        is_paid: appointment.is_paid,
        payment_details: payment ? {
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status,
          created_at: payment.createdAt
        } : null
      }
    });

  } catch (error) {
    console.error("❌ getAppointmentPaymentStatus error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch payment status"
    });
  }
};

const cleanupExpiredAppointments = async (req, res) => {
  try {
    const expiryMinutes = 10;
    const cutoffTime = new Date(Date.now() - expiryMinutes * 60 * 1000);

    const expiredAppointments = await Appointment.find({
      status: "pending",
      createdAt: { $lt: cutoffTime }
    });

    let cleanedCount = 0;

    for (const appointment of expiredAppointments) {
      await cancelFailedPaymentAppointment(
        appointment.payment_reference,
        "Payment timeout - expired"
      );
      cleanedCount++;
    }

    return res.status(200).json({
      success: true,
      message: `Cleaned up ${cleanedCount} expired appointments`,
      cleaned_count: cleanedCount
    });

  } catch (error) {
    console.error("❌ cleanupExpiredAppointments error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to clean up expired appointments"
    });
  }
};



// Keep your existing functions (with minor updates for consistency)
const getPatientAppointments = async (req, res) => {
  try {
    let query = {};

    if (req.userType === 'patient') {
      query.patient_id = req.patient._id;
    } else if (req.userType === 'practitioner') {
      query.practitioner_id = req.practitioner._id;
    } else if (req.userType === 'medicalCenter') {
      query.medical_center_id = req.medicalCenter._id;
    }

    const { status, limit = 10, page = 1 } = req.query;
    const skip = (page - 1) * limit;

    if (status) query.status = status;

    const appointments = await Appointment.find(query)
      .populate('patient_id', 'firstName lastName email phone')
      .populate('practitioner_id', 'full_name role specialties')
      .populate('medical_center_id', 'facility_name address phone')
      .sort({ date: 1, slot_start: 1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Appointment.countDocuments(query);

    return res.status(200).json({
      success: true,
      data: appointments,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error("❌ getPatientAppointments error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch appointments"
    });
  }
};

// Cancel appointment (atomic + safe)
const cancelAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found" });
    }

    // Authorization
    if (
      (req.userType === "patient" && appointment.patient_id.toString() !== req.patient._id.toString()) ||
      (req.userType === "practitioner" && appointment.practitioner_id.toString() !== req.practitioner._id.toString()) ||
      (req.userType === "medicalCenter" && appointment.medical_center_id.toString() !== req.medicalCenter._id.toString())
    ) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    if (!["pending", "confirmed"].includes(appointment.status)) {
      return res.status(400).json({
        success: false,
        message: `Appointment with status '${appointment.status}' cannot be cancelled`,
      });
    }

    // Patient time restriction
    if (req.userType === "patient") {
      const slotStart = new Date(appointment.date);
      const [h, m] = appointment.slot_start.split(":").map(Number);
      slotStart.setHours(h, m, 0, 0);
      const hoursDiff = (slotStart - new Date()) / (1000 * 60 * 60);

      if (hoursDiff < 2) {
        return res.status(400).json({
          success: false,
          message: "Patients must cancel at least 2 hours before",
        });
      }
    }

    // Release slot atomically
    await RollingSchedule.updateOne(
      {
        _id: appointment.schedule_id,
        "dailySchedules.date": appointment.date,
        "dailySchedules.timeSlots.id": appointment.slot_id
      },
      {
        $inc: {
          "dailySchedules.$[d].timeSlots.$[s].availableCapacity": 1
        }
      },
      {
        arrayFilters: [
          { "d.date": appointment.date },
          { "s.id": appointment.slot_id }
        ]
      }
    );

    // Release doctor count atomically
    await RollingSchedule.updateOne(
      {
        _id: appointment.schedule_id,
        "dailySchedules.date": appointment.date,
        "dailySchedules.timeSlots.id": appointment.slot_id,
        "dailySchedules.timeSlots.assignedDoctors.doctorId": appointment.practitioner_id
      },
      {
        $inc: {
          "dailySchedules.$[d].timeSlots.$[s].assignedDoctors.$[doc].currentPatients": -1
        }
      },
      {
        arrayFilters: [
          { "d.date": appointment.date },
          { "s.id": appointment.slot_id },
          { "doc.doctorId": appointment.practitioner_id }
        ]
      }
    );

    const paymentStatus = appointment.status === "pending" ? "failed" : "refunded";

    appointment.status = "cancelled";
    appointment.payment_status = paymentStatus;
    appointment.cancellation_reason = reason || `Cancelled by ${req.userType}`;
    appointment.cancelled_by = req.userType;
    appointment.cancelled_at = new Date();

    const payment = await Payment.findOne({ appointment_id: id });
    if (payment) {
      payment.status = paymentStatus;
      await payment.save();
    }

    await appointment.save();

    await MedicalCenter.findByIdAndUpdate(appointment.medical_center_id, {
      $inc: { "statistics.cancelled_appointments": 1 },
    });

    return res.status(200).json({
      success: true,
      message: "Appointment cancelled successfully",
      data: appointment,
    });
  } catch (error) {
    console.error("❌ cancelAppointment error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to cancel appointment",
    });
  }
};


/**
 * @desc    Get available doctors for a slot
 * @route   GET /api/bookings/available-doctors
 * @access  Patient
 */
const getAvailableDoctorsForSlot = async (req, res) => {
  try {
    const { medical_center_id, schedule_id, date, slot_id } = req.query;

    if (!medical_center_id || !schedule_id || !date || !slot_id) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters"
      });
    }

    const schedule = await RollingSchedule.findOne({
      _id: schedule_id,
      medical_center_id: medical_center_id
    });

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Schedule not found"
      });
    }

    const appointmentDate = new Date(date);
    const dateStr = appointmentDate.toISOString().split('T')[0];
    const daySchedule = schedule.dailySchedules.find(day => 
      new Date(day.date).toISOString().split('T')[0] === dateStr
    );

    if (!daySchedule) {
      return res.status(404).json({
        success: false,
        message: "No schedule found for this date"
      });
    }

    const slot = daySchedule.timeSlots.find(s => s.id === slot_id);
    if (!slot) {
      return res.status(404).json({
        success: false,
        message: "Time slot not found"
      });
    }

    // Get detailed doctor information
    const availableDoctors = await Promise.all(
      slot.assignedDoctors.map(async (doctor) => {
        const practitioner = await Practitioner.findById(doctor.doctorId);
        return {
          doctorId: doctor.doctorId,
          doctorName: doctor.doctorName || practitioner?.full_name,
          specialization: doctor.specialization,
          maxPatients: doctor.maxPatients || 1,
          currentPatients: doctor.currentPatients || 0,
          availableSlots: (doctor.maxPatients || 1) - (doctor.currentPatients || 0),
          consultationType: doctor.consultationType,
          colorCode: doctor.colorCode,
          isShifted: doctor.isShifted || false,
          shiftReason: doctor.shiftReason || '',
          practitionerDetails: practitioner ? {
            professional_license_number: practitioner.professional_license_number,
            license_type: practitioner.license_type,
            contact_email: practitioner.contact_email,
            verification_status: practitioner.verification_status
          } : null
        };
      })
    );

    // Filter doctors with available slots
    const doctorsWithAvailability = availableDoctors.filter(
      doctor => doctor.availableSlots > 0
    );

    // Group by specialization
    const doctorsBySpecialization = {};
    doctorsWithAvailability.forEach(doctor => {
      doctor.specialization.forEach(spec => {
        if (!doctorsBySpecialization[spec]) {
          doctorsBySpecialization[spec] = [];
        }
        doctorsBySpecialization[spec].push(doctor);
      });
    });

    res.status(200).json({
      success: true,
      data: {
        slotInfo: {
          start: slot.start,
          end: slot.end,
          totalCapacity: slot.capacity,
          availableCapacity: slot.availableCapacity,
          isShifted: slot.isShifted || false,
          shiftedFrom: slot.shiftedFrom || null,
          originalTiming: slot.originalTiming || null
        },
        availableDoctors: doctorsWithAvailability,
        doctorsBySpecialization,
        totalAvailableDoctors: doctorsWithAvailability.length
      }
    });

  } catch (error) {
    console.error("❌ getAvailableDoctorsForSlot error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch available doctors",
      error: error.message
    });
  }
};

/**
 * @desc    Shift doctor's slots due to delay/arrival
 * @route   POST /api/bookings/shift-slots
 * @access  Practitioner, Medical Center
 */
const shiftDoctorSlots = async (req, res) => {
  try {
    const {
      medical_center_id,
      schedule_id,
      date,
      practitioner_id,
      delay_minutes,
      reason,
      start_from_slot_id = null
    } = req.body;

    // Validate required fields
    if (!medical_center_id || !schedule_id || !date || !practitioner_id || !delay_minutes) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: medical_center_id, schedule_id, date, practitioner_id, delay_minutes"
      });
    }

    const getShiftedByType = (userType) => {
      if (userType === 'practitioner') return 'Practitioner';
      if (userType === 'medicalCenter') return 'medicalCenter';
      return 'system';
    };

    const shiftedByType = getShiftedByType(req.userType);

    // Authorization check - doctor can only shift their own slots
    if (req.userType === 'practitioner' && 
        req.practitioner._id.toString() !== practitioner_id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to shift another doctor's slots"
      });
    }

    // Find the schedule
    const schedule = await RollingSchedule.findOne({
      _id: schedule_id,
      medical_center_id: medical_center_id
    });

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Schedule not found"
      });
    }

    const appointmentDate = new Date(date);
    const dateStr = appointmentDate.toISOString().split('T')[0];
    const dayIndex = schedule.dailySchedules.findIndex(day => {
      const dayDate = new Date(day.date);
      const dayDateStr = dayDate.toISOString().split('T')[0];
      return dayDateStr === dateStr;
    });

    if (dayIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "No schedule found for this date"
      });
    }

    const daySchedule = schedule.dailySchedules[dayIndex];
    
    // Find all slots for this doctor on this day
    let doctorSlots = [];
    
    // If start_from_slot_id is provided, start shifting from that slot
    if (start_from_slot_id) {
      const startSlotIndex = daySchedule.timeSlots.findIndex(s => s && s.id === start_from_slot_id);
      if (startSlotIndex === -1) {
        return res.status(404).json({
          success: false,
          message: "Start slot not found"
        });
      }
      
      // Get all slots from the start slot onwards where doctor is assigned
      for (let i = startSlotIndex; i < daySchedule.timeSlots.length; i++) {
        const slot = daySchedule.timeSlots[i];
        if (!slot) continue;
        const doctorInSlot = slot.assignedDoctors.find(doc => 
          doc.doctorId && doc.doctorId.toString() === practitioner_id.toString()
        );
        if (doctorInSlot) {
          doctorSlots.push({ slot, index: i, doctorInSlot });
        }
      }
    } else {
      // Get all slots for this doctor on this day
      daySchedule.timeSlots.forEach((slot, index) => {
        if (!slot) return;
        const doctorInSlot = slot.assignedDoctors.find(doc => 
          doc.doctorId && doc.doctorId.toString() === practitioner_id.toString()
        );
        if (doctorInSlot) {
          doctorSlots.push({ slot, index, doctorInSlot });
        }
      });
    }

    if (doctorSlots.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No slots found for this doctor on this date"
      });
    }

    // CRITICAL: Check for existing appointments BEFORE processing slots
    // Get all slot IDs that would be affected
    const slotIds = doctorSlots.map(item => item.slot.id);
    
    if (slotIds.length > 0) {
      // Create date range for the entire day (for proper date comparison)
      const startOfDay = new Date(appointmentDate);
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date(appointmentDate);
      endOfDay.setHours(23, 59, 59, 999);
      
      // Query appointments for this doctor on this day with these slot IDs
      const existingAppointments = await Appointment.find({
        schedule_id: schedule_id,
        date: {
          $gte: startOfDay,
          $lte: endOfDay
        },
        practitioner_id: practitioner_id,
        slot_id: { $in: slotIds },
        status: { $in: ['pending', 'confirmed'] }
      });

      // If appointments exist, block the shift
      if (existingAppointments.length > 0) {
        // Find which specific slots have appointments
        const slotsWithAppointments = new Map();
        
        existingAppointments.forEach(appt => {
          if (!slotsWithAppointments.has(appt.slot_id)) {
            slotsWithAppointments.set(appt.slot_id, []);
          }
          slotsWithAppointments.get(appt.slot_id).push(appt);
        });

        // Get details of slots that have appointments
        const problematicSlots = doctorSlots
          .filter(item => slotsWithAppointments.has(item.slot.id))
          .map(item => {
            const appointments = slotsWithAppointments.get(item.slot.id);
            return {
              slot_id: item.slot.id,
              slot_time: `${item.slot.start} - ${item.slot.end}`,
              appointment_count: appointments.length,
              appointments: appointments.map(appt => ({
                patient_name: appt.patient_name,
                appointment_id: appt.appointment_id,
                status: appt.status,
                time: `${appt.slot_start} - ${appt.slot_end}`
              }))
            };
          });

        return res.status(409).json({
          success: false,
          message: `Cannot shift slots because ${existingAppointments.length} appointment(s) exist`,
          data: {
            total_appointments: existingAppointments.length,
            slots_with_appointments: problematicSlots,
            cannot_shift_slots: problematicSlots.map(s => s.slot_id),
            suggestion: "Please reschedule or cancel these appointments first before shifting these slots"
          }
        });
      }
    }

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

    const dayEndTime = daySchedule.sessions.night.enabled
      ? daySchedule.sessions.night.end
      : daySchedule.sessions.afternoon.enabled
      ? daySchedule.sessions.afternoon.end
      : daySchedule.sessions.morning.end;

    const validDoctorSlots = [];
    const overflowDoctorSlots = [];

    for (const item of doctorSlots) {
      const shiftedEnd = addMinutesToTime(item.slot.end, delay_minutes);

      if (shiftedEnd > dayEndTime) {
        overflowDoctorSlots.push(item);
      } else {
        validDoctorSlots.push(item);
      }
    }

    // Create new shifted slots and update existing ones
    const shiftedSlots = [];

    // Process only valid slots (those that won't overflow)
    for (const { slot, index } of validDoctorSlots) {
      const originalStart = slot.start;
      const originalEnd = slot.end;
      const newStart = addMinutesToTime(originalStart, delay_minutes);
      const newEnd = addMinutesToTime(originalEnd, delay_minutes);

      // Check if a slot already exists at the new time
      const existingSlotAtNewTime = daySchedule.timeSlots.find(
        s => s && s.start === newStart && s.end === newEnd
      );

      if (existingSlotAtNewTime) {
        // Merge with existing slot
        // Check if doctor is already in this slot
        const existingDoctor = existingSlotAtNewTime.assignedDoctors.find(doc => 
          doc.doctorId && doc.doctorId.toString() === practitioner_id.toString()
        );
        
        if (!existingDoctor) {
          // Add doctor to existing slot
          const doctorAssignment = slot.assignedDoctors.find(doc => 
            doc.doctorId && doc.doctorId.toString() === practitioner_id.toString()
          );
          
          if (doctorAssignment) {
            existingSlotAtNewTime.assignedDoctors.push({
              ...doctorAssignment.toObject(),
              isShifted: true,
              shiftReason: reason || `Shifted from ${originalStart} due to delay`
            });
            
            // Update slot capacity
            existingSlotAtNewTime.capacity += doctorAssignment.maxPatients || 1;
            existingSlotAtNewTime.availableCapacity += (doctorAssignment.maxPatients || 1) - (doctorAssignment.currentPatients || 0);
          }
        }
        
        // Mark original slot to be removed if empty
        slot.assignedDoctors = slot.assignedDoctors.filter(doc => 
          !doc.doctorId || doc.doctorId.toString() !== practitioner_id.toString()
        );
        
        if (slot.assignedDoctors.length === 0) {
          daySchedule.timeSlots[index] = null; // Mark for removal
        }
      } else {
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
          assignedDoctors: slot.assignedDoctors.map(doc => ({
            ...doc.toObject(),
            isShifted: doc.doctorId && doc.doctorId.toString() === practitioner_id.toString(),
            shiftReason: doc.doctorId && doc.doctorId.toString() === practitioner_id.toString() ? 
                        (reason || `Shifted from ${originalStart} due to delay`) : ''
          }))
        };
        
        // Add the new slot
        daySchedule.timeSlots.push(shiftedSlot);
        
        // Mark original slot to be removed
        daySchedule.timeSlots[index] = null;
      }
    }

    // Handle overflow slots (mark them as shifted but don't move them)
    for (const { slot } of overflowDoctorSlots) {
      slot.isShifted = true;
      slot.shiftReason = 'Overflowed working hours – requires reschedule';

      slot.shiftHistory.push({
        oldStart: slot.start,
        oldEnd: slot.end,
        newStart: null,
        newEnd: null,
        shiftedAt: new Date(),
        shiftedBy: req.userType === 'practitioner'
          ? req.practitioner._id
          : req.medicalCenter?._id,
        shiftedByType: shiftedByType,
        reason: reason || 'Exceeded working hours',
        delayMinutes: delay_minutes
      });
    }

    // Remove null slots (original slots that became empty)
    schedule.dailySchedules[dayIndex].timeSlots = daySchedule.timeSlots.filter(slot => slot !== null);

    // Recalculate totals
    const { recalculateDailyScheduleTotals } = require('../models/editingNextWeek');
    recalculateDailyScheduleTotals(schedule.dailySchedules[dayIndex]);

    // Record late arrival
    schedule.lateArrivals.push({
      doctorId: practitioner_id,
      doctorName: req.practitioner?.full_name || 'Unknown',
      date: appointmentDate,
      duration: delay_minutes,
      reason: reason || 'Doctor delayed',
      timestamp: new Date()
    });

    await schedule.save();

    res.status(200).json({
      success: true,
      message: `Successfully shifted ${validDoctorSlots.length} slot(s) by ${delay_minutes} minutes`,
      data: {
        total_slots_found: doctorSlots.length,
        slots_shifted: validDoctorSlots.length,
        slots_overflow: overflowDoctorSlots.length,
        slots_with_appointments: 0, // Since we blocked if appointments exist
        newSchedule: schedule.dailySchedules[dayIndex].timeSlots
          .filter(slot => slot.assignedDoctors.some(doc => 
            doc.doctorId && doc.doctorId.toString() === practitioner_id.toString()
          ))
          .map(slot => ({
            id: slot.id,
            start: slot.start,
            end: slot.end,
            isShifted: slot.isShifted || false,
            shiftReason: slot.shiftReason || ''
          }))
      }
    });

  } catch (error) {
    console.error("❌ shiftDoctorSlots error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to shift doctor slots",
      error: error.message
    });
  }
};

/**
 * @desc    Get doctor's delayed slots history
 * @route   GET /api/bookings/late-arrivals
 * @access  Practitioner, Medical Center
 */
const getLateArrivals = async (req, res) => {
  try {
    const { medical_center_id, schedule_id, date, practitioner_id } = req.query;

    if (!medical_center_id || !schedule_id) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: medical_center_id, schedule_id"
      });
    }

    const schedule = await RollingSchedule.findOne({
      _id: schedule_id,
      medical_center_id: medical_center_id
    });

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Schedule not found"
      });
    }

    let lateArrivals = schedule.lateArrivals || [];

    // Filter by date if provided
    if (date) {
      const filterDate = new Date(date);
      lateArrivals = lateArrivals.filter(arrival => 
        new Date(arrival.date).toISOString().split('T')[0] === 
        filterDate.toISOString().split('T')[0]
      );
    }

    // Filter by practitioner if provided
    if (practitioner_id) {
      lateArrivals = lateArrivals.filter(arrival => 
        arrival.doctorId && arrival.doctorId.toString() === practitioner_id.toString()
      );
    }

    res.status(200).json({
      success: true,
      data: {
        lateArrivals,
        total: lateArrivals.length
      }
    });

  } catch (error) {
    console.error("❌ getLateArrivals error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch late arrivals",
      error: error.message
    });
  }
};
const getAllAppointments = async (req, res) => {
  try {
    const { medical_center_id } = req.query;

    if (!medical_center_id) {
      return res.status(400).json({
        success: false,
        message: 'medical_center_id is required'
      });
    }

    const appointments = await Appointment.find({
      medical_center_id
    });

    res.status(200).json({
      success: true,
      data: appointments
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch appointments'
    });
  }
};
// Helper functions


const sendAppointmentConfirmation = async (appointment) => {
  // Implementation for sending email/SMS
  console.log(`Confirmation sent for appointment: ${appointment.appointment_id}`);
  return true;
};




module.exports = {
  createPendingAppointment, // Main booking function
  confirmAppointmentPayment, // Webhook confirmation
  cancelFailedPaymentAppointment, // Webhook cancellation
  getAppointmentPaymentStatus,
  cleanupExpiredAppointments,
  getPatientAppointments,
  cancelAppointment,
  getAvailableDoctorsForSlot,
  shiftDoctorSlots,
  getLateArrivals, 
  getAllAppointments 
};