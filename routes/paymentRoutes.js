const express = require("express");
const router = express.Router();

const { protect, requirePatient } = require("../middleware/auth");
const { createPayment } = require("../controllers/paymentController");
const { handleWebhook } = require("../services/paymentWebhook");

// Patient starts payment
router.post("/init", protect, requirePatient, createPayment);

// Paystack webhook (NO AUTH MIDDLEWARE!)
router.post("/webhook", express.raw({ type: "*/*" }), handleWebhook);

module.exports = router;
