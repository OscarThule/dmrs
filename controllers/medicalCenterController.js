const MedicalCenter = require('../models/MedicalCenter');
const bcrypt = require('bcryptjs');
const { generateToken } = require('../utils/generateToken');
const { v4: uuidv4 } = require('uuid');
const { createPaystackSubaccount } = require('../services/paystackSubaccountService');
const axios = require('axios');
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');


// @desc    Register medical center
// @route   POST /api/medical-centers/register
// @access  Public
const registerMedicalCenter = async (req, res) => {
  try {
  const {
  facility_name,
  company_reg_number,
  healthcare_reg_number,
  facility_type,
  official_domain_email,
  phone,
  address,
  practitioners = [],
  bankDetails,
  password
} = req.body;

const bank_name = bankDetails?.bank_name;
const account_number = bankDetails?.account_number;
const branch_code = bankDetails?.branch_code;


    // Basic validation
    if (!facility_name || !official_domain_email || !password || !healthcare_reg_number) {
      return res.status(400).json({
        success: false,
        message: 'Please provide facility name, email, password, and healthcare registration number'
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12);
    const hashedPassword = await bcrypt.hash(password, salt);

    // ===============================
    // CREATE MEDICAL CENTER
    // ===============================
    const medicalCenter = await MedicalCenter.create({
      facility_name,
      company_reg_number,
      healthcare_reg_number,
      facility_type,
      official_domain_email,
      phone,
      password: hashedPassword,
      address,
      practitioners,

      paystack: {
        bank_details: {
          bank_name,
          bank_code: branch_code,
          account_number,
          account_name: facility_name
        },
        subaccount_code: null,
        is_subaccount_active: false
      }
    });

    // ===============================
    // CREATE PAYSTACK SUBACCOUNT
    // ===============================
    if (branch_code && account_number) {
      try {
        const paystackRes = await axios.post(
          "https://api.paystack.co/subaccount",
          {
            business_name: facility_name,
            bank_code: branch_code,
            account_number: account_number,
            percentage_charge: 90
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
              "Content-Type": "application/json"
            }
          }
        );

        const subaccount_code = paystackRes.data.data.subaccount_code;

        medicalCenter.paystack.subaccount_code = subaccount_code;
        medicalCenter.paystack.is_subaccount_active = true;
        medicalCenter.paystack.created_at = new Date();

        await medicalCenter.save();
      } catch (err) {
        console.error(
          "Paystack Subaccount Creation Failed:",
          err.response?.data || err.message
        );
        // ❗Do not block registration if Paystack fails
      }
    }

    // Generate token
    const token = generateToken(medicalCenter._id);

    return res.status(201).json({
      success: true,
      message: 'Medical center registered successfully. Please wait for verification.',
      token,
      data: {
        medical_center_id: medicalCenter.medical_center_id,
        facility_name: medicalCenter.facility_name,
        official_domain_email: medicalCenter.official_domain_email,
        verification_status: medicalCenter.verification_status,
        is_subaccount_active: medicalCenter.paystack.is_subaccount_active
      }
    });

  } catch (error) {
    console.error('Registration error:', error);

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Medical center with this email, company registration, or healthcare license already exists'
      });
    }

    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Error registering medical center',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};


// @desc    Login medical center
// @route   POST /api/medical-centers/login
// @access  Public
const loginMedicalCenter = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate email & password
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password'
      });
    }

    // Check for medical center
    const medicalCenter = await MedicalCenter.findOne({ 
      official_domain_email: email 
    }).select('+password');

    if (!medicalCenter) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check password
    const isPasswordMatch = await bcrypt.compare(password, medicalCenter.password);
    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    if (!medicalCenter.is_active) {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated. Please contact support.'
      });
    }

    // Generate token
    const token = generateToken(medicalCenter._id);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      data: {
        medical_center_id: medicalCenter.medical_center_id,
        facility_name: medicalCenter.facility_name,
        official_domain_email: medicalCenter.official_domain_email,
        is_verified: medicalCenter.is_verified,
        verification_status: medicalCenter.verification_status
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Error logging in',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

// @route   GET /api/medical-centers/payment-settings
// @access  Private
const getPaymentSettings = async (req, res) => {
  try {
    const center = await MedicalCenter
      .findById(req.medicalCenter._id)
      .select('paymentSettings facility_name medical_center_id');

    if (!center) {
      return res.status(404).json({
        success: false,
        message: 'Medical center not found'
      });
    }

    res.status(200).json({
      success: true,
      data: center.paymentSettings
    });

  } catch (error) {
    console.error('Get payment settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment settings'
    });
  }
};

// @route   PUT /api/medical-centers/payment-settings
// @access  Private
const updatePaymentSettings = async (req, res) => {
  try {
    const {
      enablePayments,
      consultationFee,
      bookingDeposit,
      depositPercentage,
      onlineConsultationFee,
      allowPartialPayments,
      paymentMethods,
      currency
    } = req.body;

    const updates = {};

    if (enablePayments !== undefined) updates["paymentSettings.enablePayments"] = enablePayments;
    if (consultationFee !== undefined) updates["paymentSettings.consultationFee"] = consultationFee;
    if (onlineConsultationFee !== undefined) updates["paymentSettings.onlineConsultationFee"] = onlineConsultationFee;
    if (allowPartialPayments !== undefined) updates["paymentSettings.allowPartialPayments"] = allowPartialPayments;
    if (paymentMethods?.length) updates["paymentSettings.paymentMethods"] = paymentMethods;
    if (currency) updates["paymentSettings.currency"] = currency;

    // Fixed deposit mode
    if (bookingDeposit !== undefined) {
      updates["paymentSettings.bookingDeposit"] = bookingDeposit;
      updates["paymentSettings.depositPercentage"] = 0;
    }

    // Percentage mode
    if (depositPercentage !== undefined) {
      updates["paymentSettings.depositPercentage"] = depositPercentage;
      if (consultationFee)
        updates["paymentSettings.bookingDeposit"] =
          Math.round((consultationFee * depositPercentage) / 100);
    }

    updates["paymentSettings.lastUpdated"] = new Date();

    const center = await MedicalCenter.findByIdAndUpdate(
      req.medicalCenter._id,
      { $set: updates },
      { new: true, runValidators: false }   // ⬅️ IMPORTANT
    ).select("paymentSettings");

    if (!center) {
      return res.status(404).json({
        success: false,
        message: "Medical center not found"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Payment settings updated successfully",
      data: center.paymentSettings
    });

  } catch (error) {
    console.error("Update payment settings error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update payment settings"
    });
  }
};

// @desc    Update bank details & create Paystack subaccount
// @route   PUT /api/medical-centers/bank-details
// @access  Private
const updateBankDetails = async (req, res) => {
  try {
    const {
      bank_name,
      bank_code,
      account_number,
      account_name
    } = req.body;

    if (!bank_name || !bank_code || !account_number || !account_name) {
      return res.status(400).json({
        success: false,
        message: 'All bank details are required'
      });
    }

    const medicalCenter = await MedicalCenter.findById(req.medicalCenter._id);

    if (!medicalCenter) {
      return res.status(404).json({
        success: false,
        message: 'Medical center not found'
      });
    }

    // 🔒 Prevent duplicate subaccounts
    if (!medicalCenter.paystack?.subaccount_code) {
      const subaccount = await createPaystackSubaccount({
        business_name: medicalCenter.facility_name,
        settlement_bank: bank_code,
        account_number,
        percentage_charge: 0 // you control fees yourself
      });

      medicalCenter.paystack = {
        subaccount_code: subaccount.subaccount_code,
        is_subaccount_active: true,
        bank_details: {
          bank_name,
          bank_code,
          account_number,
          account_name
        },
        created_at: new Date()
      };
    } else {
      // Update bank details only
      medicalCenter.paystack.bank_details = {
        bank_name,
        bank_code,
        account_number,
        account_name
      };
      medicalCenter.paystack.updated_at = new Date();
    }

    await medicalCenter.save();

    return res.status(200).json({
      success: true,
      message: 'Bank details saved successfully',
      data: {
        subaccount_code: medicalCenter.paystack.subaccount_code
      }
    });

  } catch (error) {
    console.error('Update bank details error:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to save bank details',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};



const getAllMedicalCenters = async (req, res) => {
  try {
    const centers = await MedicalCenter.find().select('-password');
    res.status(200).json({
      success: true,
      data: centers
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// @desc    Get current medical center profile
// @route   GET /api/medical-centers/me
// @access  Private
const getMe = async (req, res) => {
  try {
    const medicalCenter = await MedicalCenter.findById(req.medicalCenter._id)
      .select('-password');

    res.status(200).json({
      success: true,
      data: medicalCenter
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching profile',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};


// @desc    Add practitioner to medical center
// @route   POST /api/medical-centers/practitioners
// @access  Private
const addPractitioner = async (req, res) => {
  try {
    const {
      full_name,
      role,
      professional_license_number,
      license_type = 'HPCSA',
      contact_email,
      contact_phone,
      branch_id = null // optional - if adding to specific branch
    } = req.body;

    if (!full_name || !role || !contact_email) {
      return res.status(400).json({
        success: false,
        message: 'Please provide full name, role, and contact email'
      });
    }

    const medicalCenter = await MedicalCenter.findById(req.medicalCenter._id);

    const newPractitioner = {
      practitioner_id: uuidv4(),
      full_name,
      role,
      professional_license_number,
      license_type,
      contact_email,
      contact_phone,
      verification_status: 'unverified'
    };

    if (branch_id) {
      // Add to specific branch
      const branch = medicalCenter.branches.id(branch_id);
      if (branch) {
        branch.practitioners.push(newPractitioner);
      } else {
        return res.status(404).json({
          success: false,
          message: 'Branch not found'
        });
      }
    } else {
      // Add to main center
      medicalCenter.practitioners.push(newPractitioner);
    }

    await medicalCenter.save();

    res.status(201).json({
      success: true,
      message: 'Practitioner added successfully',
      data: newPractitioner
    });
  } catch (error) {
    console.error('Add practitioner error:', error);
    res.status(500).json({
      success: false,
      message: 'Error adding practitioner',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

const forgotPasswordMedicalCenter = async (req, res) => {
  try {
    const { email } = req.body;

    const center = await MedicalCenter.findOne({ official_domain_email: email });
    if (!center) {
      return res.status(200).json({ success: true, message: 'If email exists, reset link sent' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    center.resetPasswordToken = hashedToken;
    center.resetPasswordExpire = Date.now() + 120 * 60 * 1000;
    await center.save({ validateBeforeSave: false });

    const resetUrl = `${process.env.APP_URL}/reset-password/${resetToken}`;

    await sendEmail({
      to: center.official_domain_email,
      subject: 'Reset Password',
      html: `<p>Click to reset password:</p><a href="${resetUrl}">${resetUrl}</a>`
    });

    res.json({ success: true, message: 'Reset email sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Email failed' });
  }
};


// @desc    Update medical center profile
// @route   PUT /api/medical-centers/profile
// @access  Private
const updateProfile = async (req, res) => {
  try {
    const updates = req.body;
    
    // Remove fields that shouldn't be updated
    delete updates.password;
    delete updates.medical_center_id;
    delete updates.verification_status;
    delete updates.is_verified;

    const medicalCenter = await MedicalCenter.findByIdAndUpdate(
      req.medicalCenter._id,
      updates,
      { new: true, runValidators: true }
    ).select('-password');

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: medicalCenter
    });
  } catch (error) {
    console.error('Update profile error:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Medical center with this email, company registration, or healthcare license already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error updating profile',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};
const resetPasswordMedicalCenter = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const center = await MedicalCenter.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() }
    }).select('+password');

    if (!center) {
      return res.status(400).json({ success: false, message: 'Token invalid or expired' });
    }

    const salt = await bcrypt.genSalt(12);
    center.password = await bcrypt.hash(password, salt);
    center.resetPasswordToken = undefined;
    center.resetPasswordExpire = undefined;
    await center.save({ validateBeforeSave: false });

    res.json({ success: true, message: 'Password reset successful' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Reset failed' });
  }
};

module.exports = {
  registerMedicalCenter,
  loginMedicalCenter,
  getMe,
 getAllMedicalCenters,
  addPractitioner,
  updateProfile,
getPaymentSettings,
  updatePaymentSettings,
  updateBankDetails,
  forgotPasswordMedicalCenter,
  resetPasswordMedicalCenter
};