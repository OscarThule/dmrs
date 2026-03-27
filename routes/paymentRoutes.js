const express = require("express");
const router = express.Router();

const { protect, requirePatient } = require("../middleware/auth");
const {
  createPayment,
  verifyPaymentController,
} = require("../controllers/paymentController");
const { handleWebhook } = require("../services/paymentWebhook");

// Patient starts payment
router.post("/init", protect, requirePatient, createPayment);

// Verify payment after Paystack redirect
router.get("/verify/:reference", verifyPaymentController);

// Paystack webhook
router.post("/webhook", express.raw({ type: "*/*" }), handleWebhook);

module.exports = router;