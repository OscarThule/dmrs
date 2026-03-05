const mongoose = require('mongoose');

const PaymentSchema = new mongoose.Schema({
  reference: { type: String, unique: true },
  appointment_id: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment" },
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: "Patient" },
  amount: Number,
  currency: { type: String, default: "ZAR" },
  status: {
    type: String,
    enum: ["pending", "success", "failed"],
    default: "pending"
  },
  metadata: Object
}, { timestamps: true });

module.exports = mongoose.model("Payment", PaymentSchema);
