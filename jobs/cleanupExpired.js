const Appointment = require("../models/Appointments");
const { cancelFailedPaymentAppointment } = require("../controllers/bookingController");

const runCleanup = async () => {
  const expiryMinutes = 3; // give user time to pay
  const cutoffTime = new Date(Date.now() - expiryMinutes * 60 * 1000);

  const expired = await Appointment.find({
    status: "pending",
    payment_status: "pending",
    createdAt: { $lt: cutoffTime }
  });

  for (const appt of expired) {
    if (appt.payment_reference) {
      await cancelFailedPaymentAppointment(
        appt.payment_reference,
        "Payment timeout - expired"
      );
    } else {
      await Appointment.deleteOne({ _id: appt._id });
    }
  }

  console.log(`[CLEANUP] Removed ${expired.length} expired appointments`);
};

module.exports = runCleanup;
