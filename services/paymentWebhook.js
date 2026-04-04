const crypto = require("crypto");
const Payment = require("../models/Payment");
const {
  confirmAppointmentPayment,
  cancelFailedPaymentAppointment,
} = require("../controllers/bookingController");

const SUPPORTED_EVENTS = new Set([
  "charge.success",
  "charge.failed",
]);

const getRawBodyBuffer = (body) => {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.from(JSON.stringify(body || {}), "utf8");
};

exports.handleWebhook = async (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const signature = req.headers["x-paystack-signature"];

    if (!secret) {
      console.error("❌ PAYSTACK_SECRET_KEY is missing");
      return res.sendStatus(500);
    }

    if (!signature) {
      console.warn("❌ Missing x-paystack-signature header");
      return res.sendStatus(401);
    }

    const rawBody = getRawBodyBuffer(req.body);

    const expectedSignature = crypto
      .createHmac("sha512", secret)
      .update(rawBody)
      .digest("hex");

    if (expectedSignature !== signature) {
      console.warn("❌ Invalid Paystack webhook signature");
      return res.sendStatus(401);
    }

    let event;

    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch (parseError) {
      console.error("❌ Failed to parse Paystack webhook JSON:", parseError);
      return res.sendStatus(400);
    }

    const eventName = event?.event;
    const reference = event?.data?.reference;

    console.log("🔥 PAYSTACK WEBHOOK HIT:", {
      event: eventName,
      reference,
    });

    if (!eventName || !reference) {
      console.warn("⚠️ Webhook missing event name or reference");
      return res.sendStatus(200);
    }

    if (!SUPPORTED_EVENTS.has(eventName)) {
      console.log(`ℹ️ Ignoring unsupported Paystack event: ${eventName}`);
      return res.sendStatus(200);
    }

    const payment = await Payment.findOne({ reference }).select("_id reference status appointment_id");

    if (!payment) {
      console.warn(`⚠️ No payment found for reference: ${reference}`);
      return res.sendStatus(200);
    }

    if (eventName === "charge.success") {
      await confirmAppointmentPayment(reference);
      console.log(`✅ Appointment/payment confirmed for reference: ${reference}`);
      return res.sendStatus(200);
    }

    if (eventName === "charge.failed") {
      const failureReason =
        event?.data?.gateway_response ||
        event?.data?.status ||
        "Payment failed";

      await cancelFailedPaymentAppointment(reference, failureReason);
      console.log(`♻️ Appointment/payment cancelled for reference: ${reference}`);
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("❌ Paystack webhook error:", error);
    return res.sendStatus(500);
  }
};