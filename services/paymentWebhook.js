const crypto = require("crypto");
const Payment = require("../models/Payment");
const Appointment = require("../models/Appointments");
const { RollingSchedule } = require("../models/editingNextWeek");

exports.handleWebhook = async (req, res) => {
  console.log("🔥 PAYSTACK WEBHOOK HIT");
  console.log("Headers:", req.headers);
  console.log("Raw body:", req.body.toString());

  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const signature = req.headers["x-paystack-signature"];

    const hash = crypto
      .createHmac("sha512", secret)
      .update(req.body)
      .digest("hex");

    if (hash !== signature) {
      console.log("❌ Signature mismatch");
      return res.sendStatus(401);
    }

    const event = JSON.parse(req.body.toString());
    const reference = event?.data?.reference;
    if (!reference) return res.sendStatus(200);

    const payment = await Payment.findOne({ reference });
    if (!payment) return res.sendStatus(200);

    const appointment = await Appointment.findById(payment.appointment_id);
    if (!appointment) return res.sendStatus(200);

    // ===== SUCCESS =====
    if (event.event === "charge.success") {
      if (payment.status !== "success" && appointment.status === "pending") {
        payment.status = "success";

        appointment.status = "confirmed";
        appointment.payment_status = "success";
        appointment.is_paid = true;
        appointment.payment_reference = reference;

        await payment.save();
        await appointment.save();

        console.log("🎉 Appointment confirmed");
      }
    }

    // ===== FAILED =====
    if (event.event === "charge.failed") {
      if (appointment.status === "pending") {
        payment.status = "failed";

        appointment.status = "cancelled";
        appointment.payment_status = "failed";
        appointment.is_paid = false;
        appointment.payment_reference = reference;
        appointment.cancellation_reason =
          event.data.gateway_response || "Payment failed";
        appointment.cancelled_by = "system";
        appointment.cancelled_at = new Date();

        const schedule = await RollingSchedule.findById(
          appointment.schedule_id
        );

        if (schedule) {
          const dateStr = appointment.date.toISOString().split("T")[0];
          const day = schedule.dailySchedules.find(
            (d) => new Date(d.date).toISOString().split("T")[0] === dateStr
          );

          if (day) {
            const slot = day.timeSlots.find(
              (s) => s.id === appointment.slot_id
            );

            if (slot) {
              slot.availableCapacity += 1;

              const doctor = slot.assignedDoctors.find(
                (d) =>
                  d.doctorId?.toString() ===
                  appointment.practitioner_id.toString()
              );

              if (doctor) {
                doctor.currentPatients = Math.max(
                  0,
                  (doctor.currentPatients || 1) - 1
                );
              }
            }
          }

          await schedule.save();
        }

        await payment.save();
        await appointment.save();

        console.log("♻️ Appointment cancelled and slot released");
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(500);
  }
};
