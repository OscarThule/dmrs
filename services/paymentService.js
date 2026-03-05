// services/paymentService.js
const axios = require("axios");
const crypto = require("crypto");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;
if (!process.env.PAYSTACK_CALLBACK_URL) {
  throw new Error("PAYSTACK_CALLBACK_URL is not defined");
}

const PAYSTACK_CALLBACK_URL = process.env.PAYSTACK_CALLBACK_URL;

// Create axios instance for Paystack
const paystack = axios.create({
  baseURL: "https://api.paystack.co",
  headers: {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
    "Cache-Control": "no-cache"
  },
  timeout: 30000 // 30 seconds timeout
});

/**
 * @desc    Initialize payment for appointment booking
 * @param   {Object} paymentData - Payment initialization data
 * @returns {Object} Payment initialization response
 */
const initializeAppointmentPayment = async (paymentData) => {
  try {
    const {
      email,
      amount,
      reference,
      metadata,
      subaccount_code,
      platform_fee = 50
    } = paymentData;

    if (!subaccount_code) {
      throw new Error("Medical center subaccount is required");
    }

    const payload = {
      email: email.toLowerCase(),
      amount: Math.round(amount * 100),
      currency: "ZAR",
      reference,
      callback_url: PAYSTACK_CALLBACK_URL,

      // 🔥 PAYSTACK SPLIT CONFIG
      subaccount: subaccount_code,
      transaction_charge: Math.round(platform_fee * 100),
      bearer: "subaccount",

      metadata
    };

    const response = await paystack.post("/transaction/initialize", payload);

    if (!response.data.status) {
      throw new Error(response.data.message);
    }

    return response.data.data;

  } catch (error) {
    console.error("Payment init failed:", error.response?.data || error.message);
    throw error;
  }
};


/**
 * @desc    Verify payment status with Paystack
 * @param   {String} reference - Payment reference
 * @returns {Object} Verified payment data
 */
const verifyPayment = async (reference) => {
  try {
    if (!reference) {
      throw new Error("Payment reference is required");
    }

    console.log(`Verifying payment for reference: ${reference}`);

    const response = await paystack.get(`/transaction/verify/${reference}`);

    if (response.data.status !== true) {
      throw new Error(`Payment verification failed: ${response.data.message}`);
    }

    const paymentData = response.data.data;

    // Format response
    return {
      success: true,
      verified: true,
      data: {
        reference: paymentData.reference,
        amount: paymentData.amount / 100, // Convert from kobo
        currency: paymentData.currency,
        status: paymentData.status,
        gateway_response: paymentData.gateway_response,
        paid_at: paymentData.paid_at,
        created_at: paymentData.created_at,
        channel: paymentData.channel,
        card_type: paymentData.authorization?.card_type,
        bank: paymentData.authorization?.bank,
        customer: {
          email: paymentData.customer?.email,
          customer_code: paymentData.customer?.customer_code
        },
        metadata: paymentData.metadata || {}
      }
    };

  } catch (error) {
    console.error("❌ Payment verification error:", {
      reference,
      message: error.message,
      response: error.response?.data
    });

    // Handle specific errors
    if (error.response?.status === 404) {
      return {
        success: false,
        verified: false,
        message: "Payment reference not found",
        reference: reference
      };
    }

    return {
      success: false,
      verified: false,
      message: `Payment verification failed: ${error.message}`,
      reference: reference
    };
  }
};

/**
 * @desc    Verify Paystack webhook signature
 * @param   {Object} requestBody - Raw request body
 * @param   {String} signature - X-Paystack-Signature header
 * @returns {Boolean} True if signature is valid
 */
const verifyWebhookSignature = (requestBody, signature) => {
  try {
    if (!signature) {
      console.error("Missing webhook signature");
      return false;
    }

    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(requestBody))
      .digest('hex');

    const isValid = hash === signature;
    
    if (!isValid) {
      console.error("Invalid webhook signature");
    }
    
    return isValid;
  } catch (error) {
    console.error("❌ Webhook signature verification error:", error);
    return false;
  }
};

/**
 * @desc    Process Paystack webhook event
 * @param   {Object} eventData - Webhook event data
 * @returns {Object} Processed event
 */
const processWebhookEvent = (eventData) => {
  try {
    const { event, data } = eventData;
    
    if (!event || !data) {
      throw new Error("Invalid webhook event data");
    }

    const eventHandlers = {
      'charge.success': () => ({
        type: 'payment_success',
        reference: data.reference,
        amount: data.amount / 100,
        currency: data.currency,
        status: 'success',
        metadata: data.metadata,
        timestamp: new Date(data.paid_at || new Date())
      }),
      
      'charge.failed': () => ({
        type: 'payment_failed',
        reference: data.reference,
        amount: data.amount / 100,
        currency: data.currency,
        status: 'failed',
        failure_reason: data.gateway_response || "Payment failed",
        metadata: data.metadata,
        timestamp: new Date()
      }),
      
      'transfer.success': () => ({
        type: 'transfer_success',
        reference: data.reference,
        amount: data.amount / 100,
        recipient: data.recipient,
        status: 'success',
        timestamp: new Date()
      }),
      
      'transfer.failed': () => ({
        type: 'transfer_failed',
        reference: data.reference,
        amount: data.amount / 100,
        recipient: data.recipient,
        status: 'failed',
        failure_reason: data.reason || "Transfer failed",
        timestamp: new Date()
      })
    };

    const handler = eventHandlers[event];
    if (!handler) {
      return {
        type: 'unknown_event',
        event: event,
        data: data,
        timestamp: new Date()
      };
    }

    return handler();

  } catch (error) {
    console.error("❌ Webhook event processing error:", error);
    throw error;
  }
};

/**
 * @desc    Create transfer recipient (for doctor/center payouts)
 * @param   {Object} recipientData - Recipient data
 * @returns {Object} Recipient creation response
 */
const createTransferRecipient = async (recipientData) => {
  try {
    const { type, name, account_number, bank_code, currency = "ZAR" } = recipientData;

    if (!type || !name || !account_number || !bank_code) {
      throw new Error("Missing required recipient fields");
    }

    const response = await paystack.post("/transferrecipient", {
      type,
      name,
      account_number,
      bank_code,
      currency
    });

    if (response.data.status !== true) {
      throw new Error(`Recipient creation failed: ${response.data.message}`);
    }

    return {
      success: true,
      recipient_code: response.data.data.recipient_code,
      details: response.data.data
    };

  } catch (error) {
    console.error("❌ Transfer recipient creation error:", error);
    
    if (error.response?.status === 400) {
      throw new Error(`Invalid recipient data: ${error.response.data?.message}`);
    }
    
    throw new Error(`Failed to create transfer recipient: ${error.message}`);
  }
};

/**
 * @desc    Initiate transfer to recipient
 * @param   {Object} transferData - Transfer data
 * @returns {Object} Transfer initiation response
 */
const initiateTransfer = async (transferData) => {
  try {
    const { recipient, amount, reason, reference } = transferData;

    if (!recipient || !amount || amount <= 0) {
      throw new Error("Invalid transfer data");
    }

    const payload = {
      source: "balance",
      amount: Math.round(amount * 100),
      recipient: recipient,
      reason: reason || "Payment for appointment",
      reference: reference || `TRF-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    const response = await paystack.post("/transfer", payload);

    if (response.data.status !== true) {
      throw new Error(`Transfer initiation failed: ${response.data.message}`);
    }

    return {
      success: true,
      transfer_code: response.data.data.transfer_code,
      reference: response.data.data.reference,
      amount: amount,
      status: response.data.data.status,
      created_at: response.data.data.createdAt
    };

  } catch (error) {
    console.error("❌ Transfer initiation error:", error);
    
    if (error.response?.data?.message?.includes("Insufficient balance")) {
      throw new Error("Insufficient balance to complete transfer");
    }
    
    throw new Error(`Failed to initiate transfer: ${error.message}`);
  }
};

/**
 * @desc    Get list of supported banks
 * @returns {Array} List of banks
 */
const getBanks = async () => {
  try {
    const response = await paystack.get("/bank", {
      params: {
        country: "south africa",
        currency: "ZAR"
      }
    });

    if (response.data.status !== true) {
      throw new Error(`Failed to fetch banks: ${response.data.message}`);
    }

    return {
      success: true,
      banks: response.data.data.map(bank => ({
        name: bank.name,
        code: bank.code,
        slug: bank.slug,
        country: bank.country
      }))
    };

  } catch (error) {
    console.error("❌ Get banks error:", error);
    throw new Error(`Failed to fetch banks: ${error.message}`);
  }
};

/**
 * @desc    Get payment transaction by ID
 * @param   {String} transactionId - Paystack transaction ID
 * @returns {Object} Transaction data
 */
const getTransaction = async (transactionId) => {
  try {
    if (!transactionId) {
      throw new Error("Transaction ID is required");
    }

    const response = await paystack.get(`/transaction/${transactionId}`);

    if (response.data.status !== true) {
      throw new Error(`Failed to fetch transaction: ${response.data.message}`);
    }

    const transaction = response.data.data;

    return {
      success: true,
      data: {
        id: transaction.id,
        reference: transaction.reference,
        amount: transaction.amount / 100,
        currency: transaction.currency,
        status: transaction.status,
        gateway_response: transaction.gateway_response,
        paid_at: transaction.paid_at,
        created_at: transaction.created_at,
        channel: transaction.channel,
        customer: transaction.customer,
        authorization: transaction.authorization,
        fees: transaction.fees,
        metadata: transaction.metadata
      }
    };

  } catch (error) {
    console.error("❌ Get transaction error:", error);
    throw new Error(`Failed to fetch transaction: ${error.message}`);
  }
};

module.exports = {
  initializePayment: initializeAppointmentPayment,
  initializeAppointmentPayment,
  verifyPayment,
  verifyWebhookSignature,
  processWebhookEvent,
  createTransferRecipient,
  initiateTransfer,
  getBanks,
  getTransaction
};