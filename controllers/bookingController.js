// controllers/bookingController.js
const mongoose = require('mongoose');
const Appointment = require('../models/Appointments');
const { RollingSchedule } = require('../models/editingNextWeek');
const MedicalCenter = require('../models/MedicalCenter');
const Practitioner = require('../models/Practitioner');
const Patient = require('../models/Patient');
const Payment = require('../models/Payment');
const { initializeAppointmentPayment, verifyPayment } = require('../services/paymentService');
const { v4: uuidv4 } = require('uuid');

/**
 * Helper: Add minutes to time string (HH:MM)
 */
const addMinutesToTime = (timeString, minutesToAdd) => {
  const [hours, minutes] = timeString.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  date.setMinutes(date.getMinutes() + minutesToAdd);
  const newHours = date.getHours().toString().padStart(2, '0');
  const newMinutes = date.getMinutes().toString().padStart(2, '0');
  return `${newHours}:${newMinutes}`;
};

/**
 * @desc    Create appointment (handles both free and paid bookings)
 * @route   POST /api/bookings
 * @access  Patient
 */
const createPendingAppointment = async (req, res) => {
  // Start a session for potential transactions
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // ================= AUTHENTICATION =================
    if (!req.patient) {
      await session.abortTransaction();
      session.endSession();
      return res.status(401).json({
        success: false,
        message: "Patient authentication required"
      });
    }

    // ================= REQUEST BODY VALIDATION =================
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
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(", ")}`
      });
    }

    // ================= DATE VALIDATION =================
    const appointmentDate = new Date(date);
    if (isNaN(appointmentDate.getTime())) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Invalid date format"
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (appointmentDate < today) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Cannot book appointments in the past"
      });
    }

    const dayOnly = new Date(appointmentDate);
    dayOnly.setHours(0, 0, 0, 0);

    // ================= LOAD SCHEDULE =================
    const schedule = await RollingSchedule.findOne({
      _id: schedule_id,
      medical_center_id
    }).session(session);

    if (!schedule) {
      await session.abortTransaction();
      session.endSession();
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
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: "No schedule found for this date"
      });
    }

    const daySchedule = schedule.dailySchedules[dayIndex];
    if (!daySchedule.isWorking) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Medical center is not working on this day"
      });
    }

    // ================= SLOT RESOLUTION (original or shifted) =================
    let slot = daySchedule.timeSlots.find(s => s.id === slot_id);
    let isShiftedSlot = false;

    if (!slot) {
      slot = daySchedule.timeSlots.find(s => s.shiftedFrom === slot_id);
      if (slot) isShiftedSlot = true;
    }

    if (!slot) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: "Time slot not found"
      });
    }

    // ================= DOCTOR ASSIGNMENT VALIDATION =================
    const doctorAssignment = slot.assignedDoctors.find(d =>
      d.doctorId && d.doctorId.toString() === practitioner_id.toString()
    );

    if (!doctorAssignment) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: "Selected doctor not available in this slot"
      });
    }

    // Specialization check
    if (
      preferred_specialization &&
      !doctorAssignment.specialization.includes(preferred_specialization) &&
      !doctorAssignment.specialization.includes("general")
    ) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: `Doctor does not specialize in ${preferred_specialization}`
      });
    }

    // ================= DUPLICATE APPOINTMENT CHECKS =================
    const existingSameSlot = await Appointment.findOne({
      patient_id: req.patient._id,
      date: appointmentDate,
      slot_start: slot.start,
      status: { $in: ["pending", "confirmed"] }
    }).session(session);

    if (existingSameSlot) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "You already have an appointment at this time"
      });
    }

    const startOfDay = new Date(appointmentDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(appointmentDate);
    endOfDay.setHours(23, 59, 59, 999);

    const existingToday = await Appointment.findOne({
      patient_id: req.patient._id,
      date: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["pending", "confirmed"] }
    }).session(session);

    if (existingToday) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "You already have an appointment for this day"
      });
    }

    // ================= LOAD PATIENT, MEDICAL CENTER, PRACTITIONER =================
    const [patient, medicalCenter, practitioner] = await Promise.all([
      Patient.findById(req.patient._id).session(session),
      MedicalCenter.findById(medical_center_id).session(session),
      Practitioner.findById(practitioner_id).session(session)
    ]);

    if (!patient || !medicalCenter || !practitioner) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: "Patient, medical center or practitioner not found"
      });
    }

    // ================= PRICING & DEPOSIT LOGIC =================
    const paymentSettings = medicalCenter.paymentSettings || {};
    const consultationFee = Number(paymentSettings.consultationFee || 0);
    const depositAmount = Number(paymentSettings.bookingDeposit || 0);

    // Determine if this is a free booking (deposit = 0)
    const isFreeBooking = depositAmount <= 0;

    let platformFee = 0;
    let totalAmount = 0;

    if (!isFreeBooking) {
      // Platform fee: 10% of deposit or minimum R50
      const tenPercent = depositAmount * 0.10;
      platformFee = Math.max(50, tenPercent);
      totalAmount = depositAmount + platformFee;
    }

    // ================= HOLD SLOT & INCREMENT DOCTOR COUNT (ATOMIC) =================
    // We will do the hold inside a transaction, but first we need to verify that
    // both slot capacity and doctor capacity are available.
    // The updateOne with arrayFilters will ensure atomicity.

    // For free bookings we also need to hold capacity (but no payment)
    // For paid bookings we will hold capacity after Paystack init? Actually we'll hold it
    // inside the transaction, but we need to hold it before calling Paystack to avoid
    // double-booking? Better to hold after Paystack init to avoid holding capacity if Paystack fails.
    // However, we must hold capacity before we commit the transaction, so the order is:
    // 1. Validate everything
    // 2. If paid, call Paystack (if fails, return error without any DB change)
    // 3. Then in transaction: hold capacity, create appointment, create payment (if paid)
    // This ensures we only hold capacity when payment is guaranteed (from Paystack's perspective)
    // But there's a race: between step 2 and 3, the slot might be taken. That's okay, the
    // transaction will fail because capacity won't be available, and we'll respond accordingly.

    // For free bookings, we skip Paystack and go straight to transaction.

    let paymentReference = null;
    let paystackAuthorizationUrl = null;

    if (!isFreeBooking) {
      // ================= INITIALIZE PAYMENT WITH PAYSTACK =================
      const subaccountCode = medicalCenter.paystack?.subaccount_code;
      if (!subaccountCode) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: "Medical center has no active payout subaccount"
        });
      }

      paymentReference = `PAY-${uuidv4().replace(/-/g, "").substring(0, 16)}`;

      try {
        const paymentResponse = await initializeAppointmentPayment({
          email: patient.email,
          amount: totalAmount,
          reference: paymentReference,
          subaccount_code: subaccountCode,
          metadata: {
            appointment_id: "pending", // will be replaced after appointment creation
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
        });
        paystackAuthorizationUrl = paymentResponse.authorization_url;
      } catch (paystackError) {
        console.error("Paystack init error:", paystackError);
        await session.abortTransaction();
        session.endSession();
        return res.status(500).json({
          success: false,
          message: "Failed to initialize payment. Please try again."
        });
      }
    }

    // ================= ATOMIC DB OPERATIONS (CAPACITY HOLD, APPOINTMENT, PAYMENT) =================
    try {
      // First, try to hold the slot and increment doctor count.
      // We use a single update with arrayFilters to check both slot capacity and doctor capacity.
      // Note: For free booking, we still need to hold capacity (but no payment record).
      const updateFilter = {
        _id: schedule_id,
        medical_center_id,
        "dailySchedules.date": dayOnly,
        "dailySchedules.timeSlots.id": slot.id,
        "dailySchedules.timeSlots.availableCapacity": { $gt: 0 },
        // Additional filter for doctor capacity (must be less than max)
        "dailySchedules.timeSlots.assignedDoctors.doctorId": practitioner_id,
        "dailySchedules.timeSlots.assignedDoctors.currentPatients": { $lt: mongoose.Types.Decimal128 ? mongoose.Types.Decimal128(doctorAssignment.maxPatients) : doctorAssignment.maxPatients }
      };

      const updateInc = {
        $inc: {
          "dailySchedules.$[d].timeSlots.$[s].availableCapacity": -1,
          "dailySchedules.$[d].timeSlots.$[s].assignedDoctors.$[doc].currentPatients": 1
        }
      };

      const arrayFilters = [
        { "d.date": dayOnly },
        { "s.id": slot.id },
        { "doc.doctorId": practitioner_id }
      ];

      const holdResult = await RollingSchedule.updateOne(
        updateFilter,
        updateInc,
        { arrayFilters, session }
      );

      if (holdResult.modifiedCount === 0) {
        // Check if doctor capacity is full or slot capacity is zero
        // For better error message, we can inspect.
        const currentSlot = await RollingSchedule.findOne(
          { _id: schedule_id, "dailySchedules.date": dayOnly, "dailySchedules.timeSlots.id": slot.id },
          { "dailySchedules.timeSlots.$": 1 },
          { session }
        );
        if (currentSlot) {
          const foundSlot = currentSlot.dailySchedules[0].timeSlots[0];
          if (foundSlot.availableCapacity <= 0) {
            throw new Error("Slot is full");
          }
          const doctorInSlot = foundSlot.assignedDoctors.find(d => d.doctorId.toString() === practitioner_id.toString());
          if (doctorInSlot && doctorInSlot.currentPatients >= doctorInSlot.maxPatients) {
            throw new Error("Doctor is fully booked for this slot");
          }
        }
        throw new Error("Slot or doctor not available for booking");
      }

      // Create appointment object
      const appointmentData = {
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
        appointment_duration: slot.duration || 30,
        is_shifted_slot: isShiftedSlot,
        shift_notes: isShiftedSlot ? "Shifted from original slot" : "",
        consultation_fee: consultationFee,
        deposit_amount: depositAmount,
        platform_fee: platformFee,
        total_amount: totalAmount,
        currency: "ZAR"
      };

      if (isFreeBooking) {
        // Free booking: mark as confirmed directly (or pending, but we'll go with confirmed)
        appointmentData.status = "confirmed";
        appointmentData.payment_status = "not_required";
        appointmentData.is_paid = false;
        appointmentData.payment_required = false;
        appointmentData.payment_amount_paid = 0;
      } else {
        // Paid booking: pending payment
        appointmentData.status = "pending";
        appointmentData.payment_status = "pending";
        appointmentData.is_paid = false;
        appointmentData.payment_required = true;
        appointmentData.payment_reference = paymentReference;
        appointmentData.payment_amount_paid = 0;
      }

      const appointment = new Appointment(appointmentData);

      // Create payment record if paid
      let payment = null;
      if (!isFreeBooking) {
        payment = new Payment({
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
        });
      }

      // Save all in transaction
      await appointment.save({ session });
      if (payment) await payment.save({ session });

      await session.commitTransaction();
      session.endSession();

      // Return response based on booking type
      if (isFreeBooking) {
        return res.status(201).json({
          success: true,
          message: "Appointment created successfully.",
          data: {
            appointment,
            payment_required: false
          }
        });
      } else {
        return res.status(201).json({
          success: true,
          message: "Appointment created. Complete payment to confirm.",
          data: {
            appointment,
            payment: {
              reference: paymentReference,
              amount: totalAmount,
              authorization_url: paystackAuthorizationUrl,
              expires_at: new Date(Date.now() + 3 * 60 * 1000)
            }
          }
        });
      }
    } catch (holdError) {
      await session.abortTransaction();
      session.endSession();
      console.error("Atomic hold error:", holdError);
      return res.status(409).json({
        success: false,
        message: holdError.message || "This slot or doctor is no longer available. Please choose another slot."
      });
    }
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
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
    appointment.payment_amount_paid = payment.amount || appointment.total_amount || 0;

    await payment.save();
    await appointment.save();
  } catch (err) {
    console.error("Confirm payment error:", err);
  }
};

/**
 * @desc    Cancel appointment after payment failure (Webhook or scheduled cleanup)
 * @param   {string} reference - Payment reference
 * @param   {string} reason - Failure reason
 */
const cancelFailedPaymentAppointment = async (reference, reason = "Payment failed") => {
  try {
    if (!reference) return;

    const payment = await Payment.findOne({ reference });
    if (!payment) return;

    // Already processed
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

    // 3. Release slot capacity and doctor count atomically
    await RollingSchedule.updateOne(
      {
        _id: appointment.schedule_id,
        medical_center_id: appointment.medical_center_id,
        "dailySchedules.date": appointment.date,
        "dailySchedules.timeSlots.id": appointment.slot_id
      },
      {
        $inc: {
          "dailySchedules.$[d].timeSlots.$[s].availableCapacity": 1,
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
        pricing: {
          consultation_fee: appointment.consultation_fee,
          deposit_amount: appointment.deposit_amount,
          platform_fee: appointment.platform_fee,
          total_amount: appointment.total_amount,
          payment_amount_paid: appointment.payment_amount_paid,
          currency: appointment.currency
        },
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

/**
 * @desc    Clean up expired pending appointments (payment timeout)
 * @route   GET /api/bookings/cleanup-expired
 * @access  Admin/System
 */
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

/**
 * @desc    Get appointments for patient / practitioner / medical center
 * @route   GET /api/bookings/appointments
 * @access  Patient / Practitioner / MedicalCenter
 */
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

/**
 * @desc    Cancel an appointment (by patient, practitioner, or medical center)
 * @route   PUT /api/bookings/:id/cancel
 * @access  Patient / Practitioner / MedicalCenter
 */
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

    // Patient time restriction (>=2 hours before slot)
    if (req.userType === "patient") {
      const slotStart = new Date(appointment.date);
      const [h, m] = appointment.slot_start.split(":").map(Number);
      slotStart.setHours(h, m, 0, 0);
      const hoursDiff = (slotStart - new Date()) / (1000 * 60 * 60);

      if (hoursDiff < 2) {
        return res.status(400).json({
          success: false,
          message: "Patients must cancel at least 2 hours before appointment",
        });
      }
    }

    // Release slot capacity and doctor count atomically
    await RollingSchedule.updateOne(
      {
        _id: appointment.schedule_id,
        "dailySchedules.date": appointment.date,
        "dailySchedules.timeSlots.id": appointment.slot_id
      },
      {
        $inc: {
          "dailySchedules.$[d].timeSlots.$[s].availableCapacity": 1,
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

    // Update appointment status
    const paymentStatus = appointment.status === "pending" ? "failed" : "refunded";

    appointment.status = "cancelled";
    appointment.payment_status = paymentStatus;
    appointment.cancellation_reason = reason || `Cancelled by ${req.userType}`;
    appointment.cancelled_by = req.userType;
    appointment.cancelled_at = new Date();

    // Update payment record if exists
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

    if (start_from_slot_id) {
      const startSlotIndex = daySchedule.timeSlots.findIndex(s => s && s.id === start_from_slot_id);
      if (startSlotIndex === -1) {
        return res.status(404).json({
          success: false,
          message: "Start slot not found"
        });
      }

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
    const slotIds = doctorSlots.map(item => item.slot.id);
    if (slotIds.length > 0) {
      const startOfDay = new Date(appointmentDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(appointmentDate);
      endOfDay.setHours(23, 59, 59, 999);

      const existingAppointments = await Appointment.find({
        schedule_id: schedule_id,
        date: { $gte: startOfDay, $lte: endOfDay },
        practitioner_id: practitioner_id,
        slot_id: { $in: slotIds },
        status: { $in: ['pending', 'confirmed'] }
      });

      if (existingAppointments.length > 0) {
        const slotsWithAppointments = new Map();
        existingAppointments.forEach(appt => {
          if (!slotsWithAppointments.has(appt.slot_id)) {
            slotsWithAppointments.set(appt.slot_id, []);
          }
          slotsWithAppointments.get(appt.slot_id).push(appt);
        });

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

    const shiftedSlots = [];

    // Process valid slots (those that won't overflow)
    for (const { slot, index } of validDoctorSlots) {
      const originalStart = slot.start;
      const originalEnd = slot.end;
      const newStart = addMinutesToTime(originalStart, delay_minutes);
      const newEnd = addMinutesToTime(originalEnd, delay_minutes);

      const existingSlotAtNewTime = daySchedule.timeSlots.find(
        s => s && s.start === newStart && s.end === newEnd
      );

      if (existingSlotAtNewTime) {
        // Merge with existing slot
        const existingDoctor = existingSlotAtNewTime.assignedDoctors.find(doc => 
          doc.doctorId && doc.doctorId.toString() === practitioner_id.toString()
        );
        if (!existingDoctor) {
          const doctorAssignment = slot.assignedDoctors.find(doc => 
            doc.doctorId && doc.doctorId.toString() === practitioner_id.toString()
          );
          if (doctorAssignment) {
            existingSlotAtNewTime.assignedDoctors.push({
              ...doctorAssignment.toObject(),
              isShifted: true,
              shiftReason: reason || `Shifted from ${originalStart} due to delay`
            });
            existingSlotAtNewTime.capacity += doctorAssignment.maxPatients || 1;
            existingSlotAtNewTime.availableCapacity += (doctorAssignment.maxPatients || 1) - (doctorAssignment.currentPatients || 0);
          }
        }
        // Remove doctor from original slot
        slot.assignedDoctors = slot.assignedDoctors.filter(doc => 
          !doc.doctorId || doc.doctorId.toString() !== practitioner_id.toString()
        );
        if (slot.assignedDoctors.length === 0) {
          daySchedule.timeSlots[index] = null;
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
        daySchedule.timeSlots.push(shiftedSlot);
        daySchedule.timeSlots[index] = null;
      }
    }

    // Handle overflow slots (mark them as shifted but don't move)
    for (const { slot } of overflowDoctorSlots) {
      slot.isShifted = true;
      slot.shiftReason = 'Overflowed working hours – requires reschedule';
      slot.shiftHistory = slot.shiftHistory || [];
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

    // Remove null slots
    schedule.dailySchedules[dayIndex].timeSlots = daySchedule.timeSlots.filter(slot => slot !== null);

    // Recalculate totals (if function exists)
    const { recalculateDailyScheduleTotals } = require('../models/editingNextWeek');
    if (recalculateDailyScheduleTotals) {
      recalculateDailyScheduleTotals(schedule.dailySchedules[dayIndex]);
    }

    // Record late arrival
    schedule.lateArrivals = schedule.lateArrivals || [];
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
        slots_with_appointments: 0,
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

    if (date) {
      const filterDate = new Date(date);
      lateArrivals = lateArrivals.filter(arrival => 
        new Date(arrival.date).toISOString().split('T')[0] === 
        filterDate.toISOString().split('T')[0]
      );
    }

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

/**
 * @desc    Get all appointments (for medical center admin)
 * @route   GET /api/bookings/all
 * @access  Medical Center
 */
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

/**
 * @desc    Create payment for existing pending appointment (separate endpoint)
 * @route   POST /api/bookings/payment
 * @access  Patient
 */
exports.createPayment = async (req, res) => {
  try {
    const { appointment_id } = req.body;

    const appointment = await Appointment.findById(appointment_id).populate("medical_center");
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found" });
    }

    if (appointment.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending appointments can be paid",
      });
    }

    const medicalCenter = appointment.medical_center;
    if (!medicalCenter?.paystack?.subaccount_code) {
      return res.status(400).json({
        success: false,
        message: "Medical center payment setup incomplete",
      });
    }

    const settings = medicalCenter.paymentSettings || {};
    const depositAmount = Number(settings.bookingDeposit || 0);

    if (!depositAmount || depositAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Booking deposit not set for this medical center",
      });
    }

    const percentageFee = depositAmount * 0.1;
    const finalPlatformFee = Math.max(50, percentageFee);
    const totalAmount = depositAmount + finalPlatformFee;

    const reference = `PAY-${uuidv4().replace(/-/g, "").substring(0, 16)}`;

    await Payment.create({
      reference,
      appointment_id,
      patient_id: req.patient._id,
      amount: totalAmount,
      status: "pending",
      metadata: {
        deposit_amount: depositAmount,
        platform_fee: finalPlatformFee,
      },
    });

    await Appointment.findByIdAndUpdate(appointment_id, {
      payment_reference: reference,
      payment_status: "pending",
      is_paid: false,
    });

    const paystackData = await initializeAppointmentPayment({
      email: appointment.patient_email,
      amount: totalAmount,
      reference,
      subaccount_code: medicalCenter.paystack.subaccount_code,
      platform_fee: finalPlatformFee,
      metadata: {
        appointment_id,
        patient_id: appointment.patient_id,
        medical_center_id: medicalCenter._id,
        deposit_amount: depositAmount,
        platform_fee: finalPlatformFee,
      },
    });

    return res.status(200).json({
      success: true,
      authorization_url: paystackData.authorization_url,
      reference,
      breakdown: {
        deposit: depositAmount,
        platform_fee: finalPlatformFee,
        total_paid_now: totalAmount,
      },
    });
  } catch (error) {
    console.error("Payment Init Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to initialize payment",
    });
  }
};

module.exports = {
  createPendingAppointment,
  confirmAppointmentPayment,
  cancelFailedPaymentAppointment,
  getAppointmentPaymentStatus,
  cleanupExpiredAppointments,
  getPatientAppointments,
  cancelAppointment,
  getAvailableDoctorsForSlot,
  shiftDoctorSlots,
  getLateArrivals,
  getAllAppointments,
  createPayment: exports.createPayment // keep original name
};