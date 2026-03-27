const Payment = require("../models/Payment");
const Appointment = require("../models/Appointments");
const MedicalCenter = require("../models/MedicalCenter");
const { initializeAppointmentPayment } = require("../services/paymentService");
const { v4: uuid } = require("uuid");

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

    // ===== FORCE BOOKING DEPOSIT ONLY =====
    const settings = medicalCenter.paymentSettings || {};
    const depositAmount = Number(settings.bookingDeposit || 0);

    if (!depositAmount || depositAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Booking deposit not set for this medical center",
      });
    }

    // ===== PLATFORM FEE (10% OR R50 MIN) =====
    const percentageFee = depositAmount * 0.1;
    const finalPlatformFee = Math.max(50, percentageFee);

    // ===== TOTAL USER PAYS =====
    const totalAmount = depositAmount + finalPlatformFee;

    console.log("PAYMENT DEBUG:", {
      bookingDeposit: depositAmount,
      platformFee: finalPlatformFee,
      sentToPaystack: totalAmount,
    });

    const reference = `PAY-${uuid()}`;

    // ===== CREATE PAYMENT RECORD =====
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

    // ===== UPDATE APPOINTMENT =====
    await Appointment.findByIdAndUpdate(appointment_id, {
      payment_reference: reference,
      payment_status: "pending",
      is_paid: false,
    });

    // ===== INIT PAYSTACK =====
    const paystackData = await initializeAppointmentPayment({
      email: appointment.patient_email,
      amount: totalAmount, // ONLY deposit + platform fee
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

exports.verifyPaymentController = async (req, res) => {
  try {
    const { reference } = req.params;

    const result = await verifyPayment(reference);

    if (!result.success) {
      return res.status(200).json(result);
    }

    if (result.data?.status === "success") {
      const payment = await Payment.findOne({ reference });

      if (payment && payment.status !== "success") {
        payment.status = "success";
        await payment.save();
      }

      if (payment) {
        const appointment = await Appointment.findById(payment.appointment_id);

        if (appointment && appointment.status === "pending") {
          appointment.status = "confirmed";
          appointment.payment_status = "success";
          appointment.is_paid = true;
          appointment.payment_reference = reference;
          await appointment.save();
        }
      }
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("Verify controller error:", error);
    return res.status(500).json({
      success: false,
      message: "Verification failed",
    });
  }
};