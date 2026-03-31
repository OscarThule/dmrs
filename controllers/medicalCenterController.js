const MedicalCenter = require('../models/MedicalCenter');
const bcrypt = require('bcryptjs');
const { generateToken } = require('../utils/generateToken');
const { createPaystackSubaccount } = require('../services/paystackSubaccountService');
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------
const sanitizeString = (value) => {
  return typeof value === 'string' ? value.trim() : value;
};

const buildCleanAddress = (address = {}) => {
  const hasLatLng =
    typeof address.lat === 'number' &&
    Number.isFinite(address.lat) &&
    typeof address.lng === 'number' &&
    Number.isFinite(address.lng);

  const hasGooglePlaceData =
    typeof address.place_id === 'string' &&
    address.place_id.trim().length > 0 &&
    typeof address.formatted_address === 'string' &&
    address.formatted_address.trim().length > 0 &&
    hasLatLng;

  let finalLocationSource = 'address';

  if (address.location_source === 'address_and_geolocation') {
    finalLocationSource = 'address_and_geolocation';
  } else if (address.location_source === 'geolocation') {
    finalLocationSource = 'geolocation';
  }

  const builtFullAddress = [
    address.line1?.trim() || '',
    address.line2?.trim() || '',
    address.city?.trim() || '',
    address.province?.trim() || '',
    address.postal?.trim() || '',
    'South Africa'
  ]
    .filter(Boolean)
    .join(', ');

  return {
    line1: address.line1?.trim() || '',
    line2: address.line2?.trim() || '',
    city: address.city?.trim() || '',
    province: address.province?.trim() || '',
    postal: address.postal?.trim() || '',
    full_address: address.full_address?.trim() || builtFullAddress,
    formatted_address: address.formatted_address?.trim() || '',
    place_id: address.place_id?.trim() || '',
    lat: hasLatLng ? address.lat : null,
    lng: hasLatLng ? address.lng : null,
    location_source: finalLocationSource,
    is_location_verified: hasGooglePlaceData || finalLocationSource === 'geolocation'
  };
};

const buildCleanBankDetails = (bankDetails = {}, fallbackAccountName = '') => {
  return {
    bank_name: bankDetails?.bank_name?.trim() || '',
    bank_code: bankDetails?.bank_code?.trim() || '',
    account_number: bankDetails?.account_number?.trim() || '',
    account_name: bankDetails?.account_name?.trim() || fallbackAccountName || ''
  };
};

const shouldAttemptSubaccountCreation = (bankDetails) => {
  return (
    !!bankDetails.bank_name &&
    !!bankDetails.bank_code &&
    !!bankDetails.account_number &&
    !!bankDetails.account_name
  );
};

// ----------------------------------------------------------------------
// @desc    Register medical center
// @route   POST /api/medical-centers/register
// @access  Public
// ----------------------------------------------------------------------
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
      bankDetails = {},
      password
    } = req.body;

    if (
      !facility_name ||
      !official_domain_email ||
      !password ||
      !healthcare_reg_number ||
      !company_reg_number ||
      !facility_type ||
      !phone ||
      !address?.line1 ||
      !address?.city ||
      !address?.province ||
      !address?.postal
    ) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required medical center registration fields'
      });
    }

    const cleanedAddress = buildCleanAddress(address);
    const cleanedBankDetails = buildCleanBankDetails(bankDetails, facility_name.trim());

    const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12;
    const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(saltRounds));

    const medicalCenter = await MedicalCenter.create({
      facility_name: facility_name.trim(),
      company_reg_number: company_reg_number.trim(),
      healthcare_reg_number: healthcare_reg_number.trim(),
      facility_type: facility_type.trim(),
      official_domain_email: official_domain_email.trim().toLowerCase(),
      phone: phone.trim(),
      password: hashedPassword,
      address: cleanedAddress,
      paystack: {
        subaccount_code: null,
        is_subaccount_active: false,
        bank_details: cleanedBankDetails
      }
    });

    let subaccountCreationMessage = null;

    if (shouldAttemptSubaccountCreation(cleanedBankDetails)) {
      try {
        const subaccount = await createPaystackSubaccount({
          business_name: medicalCenter.facility_name,
          settlement_bank: cleanedBankDetails.bank_code,
          account_number: cleanedBankDetails.account_number,
          percentage_charge: 0
        });

        medicalCenter.paystack.subaccount_code = subaccount.subaccount_code;
        medicalCenter.paystack.is_subaccount_active = true;
        medicalCenter.paystack.bank_details = cleanedBankDetails;
        medicalCenter.paystack.created_at = new Date();
        medicalCenter.paystack.updated_at = new Date();

        await medicalCenter.save();

        console.log('✅ Paystack subaccount created during registration:', {
          medicalCenterId: medicalCenter._id.toString(),
          subaccount_code: subaccount.subaccount_code
        });
      } catch (err) {
        const paystackError =
          err?.response?.data?.message ||
          err?.response?.data ||
          err?.message ||
          'Unknown Paystack error';

        console.error('❌ Paystack subaccount creation failed during registration:', {
          medicalCenterId: medicalCenter._id.toString(),
          facility_name: medicalCenter.facility_name,
          error: paystackError
        });

        medicalCenter.paystack.subaccount_code = null;
        medicalCenter.paystack.is_subaccount_active = false;
        medicalCenter.paystack.updated_at = new Date();
        await medicalCenter.save();

        subaccountCreationMessage =
          'Medical center registered, but payout setup failed. Please update valid bank details.';
      }
    } else {
      subaccountCreationMessage =
        'Medical center registered without complete bank details. Payout setup is incomplete.';
    }

    const token = generateToken(medicalCenter._id);

    return res.status(201).json({
      success: true,
      message:
        subaccountCreationMessage ||
        'Medical center registered successfully and payout setup completed.',
      token,
      data: {
        _id: medicalCenter._id,
        medical_center_id: medicalCenter.medical_center_id,
        facility_name: medicalCenter.facility_name,
        official_domain_email: medicalCenter.official_domain_email,
        verification_status: medicalCenter.verification_status,
        is_verified: medicalCenter.is_verified,
        address: medicalCenter.address,
        paystack: {
          subaccount_code: medicalCenter.paystack?.subaccount_code,
          is_subaccount_active: medicalCenter.paystack?.is_subaccount_active,
          bank_details: medicalCenter.paystack?.bank_details
        }
      }
    });
  } catch (error) {
    console.error('Registration error:', error);

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message:
          'Medical center with this email, company registration, or healthcare license already exists'
      });
    }

    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((val) => val.message);
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

// ----------------------------------------------------------------------
// @desc    Login medical center
// @route   POST /api/medical-centers/login
// @access  Public
// ----------------------------------------------------------------------
const loginMedicalCenter = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password'
      });
    }

    const medicalCenter = await MedicalCenter.findOne({
      official_domain_email: email.trim().toLowerCase()
    }).select('+password');

    if (!medicalCenter) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

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

    const token = generateToken(medicalCenter._id);

    return res.status(200).json({
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
    return res.status(500).json({
      success: false,
      message: 'Error logging in',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

// ----------------------------------------------------------------------
// @desc    Get current medical center profile
// @route   GET /api/medical-centers/me
// @access  Private
// ----------------------------------------------------------------------
const getMe = async (req, res) => {
  try {
    const medicalCenter = await MedicalCenter.findById(req.medicalCenter._id).select('-password');

    return res.status(200).json({
      success: true,
      data: medicalCenter
    });
  } catch (error) {
    console.error('Get profile error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching profile',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

// ----------------------------------------------------------------------
// @desc    Get all medical centers
// @route   GET /api/medical-centers
// @access  Private/Admin
// ----------------------------------------------------------------------
const getAllMedicalCenters = async (req, res) => {
  try {
    const centers = await MedicalCenter.find().select('-password');

    return res.status(200).json({
      success: true,
      data: centers
    });
  } catch (error) {
    console.error('Get all centers error:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ----------------------------------------------------------------------
// @desc    Update medical center profile and settings
// @route   PUT /api/medical-centers/profile
// @access  Private
// ----------------------------------------------------------------------
const updateProfile = async (req, res) => {
  try {
    const {
      facility_name,
      company_reg_number,
      healthcare_reg_number,
      facility_type,
      official_domain_email,
      phone,
      address,
      bankDetails
    } = req.body;

    const medicalCenter = await MedicalCenter.findById(req.medicalCenter._id);

    if (!medicalCenter) {
      return res.status(404).json({
        success: false,
        message: 'Medical center not found'
      });
    }

    if (facility_name !== undefined) {
      medicalCenter.facility_name = sanitizeString(facility_name);
    }

    if (company_reg_number !== undefined) {
      medicalCenter.company_reg_number = sanitizeString(company_reg_number);
    }

    if (healthcare_reg_number !== undefined) {
      medicalCenter.healthcare_reg_number = sanitizeString(healthcare_reg_number);
    }

    if (facility_type !== undefined) {
      medicalCenter.facility_type = sanitizeString(facility_type);
    }

    if (official_domain_email !== undefined) {
      medicalCenter.official_domain_email = sanitizeString(official_domain_email)?.toLowerCase();
    }

    if (phone !== undefined) {
      medicalCenter.phone = sanitizeString(phone);
    }

    if (address !== undefined) {
      medicalCenter.address = buildCleanAddress(address);
    }

    let bankDetailsUpdated = false;

    if (bankDetails !== undefined) {
      const cleanedBankDetails = buildCleanBankDetails(
        bankDetails,
        medicalCenter.facility_name?.trim()
      );

      medicalCenter.paystack = medicalCenter.paystack || {};
      medicalCenter.paystack.bank_details = cleanedBankDetails;
      medicalCenter.paystack.updated_at = new Date();

      bankDetailsUpdated = true;

      if (shouldAttemptSubaccountCreation(cleanedBankDetails)) {
        try {
          const shouldCreateOrRecreateSubaccount =
            !medicalCenter.paystack?.subaccount_code ||
            medicalCenter.paystack?.is_subaccount_active !== true;

          if (shouldCreateOrRecreateSubaccount) {
            const subaccount = await createPaystackSubaccount({
              business_name: medicalCenter.facility_name,
              settlement_bank: cleanedBankDetails.bank_code,
              account_number: cleanedBankDetails.account_number,
              percentage_charge: 0
            });

            medicalCenter.paystack.subaccount_code = subaccount.subaccount_code;
            medicalCenter.paystack.is_subaccount_active = true;
            medicalCenter.paystack.created_at =
              medicalCenter.paystack.created_at || new Date();
            medicalCenter.paystack.updated_at = new Date();
          }
        } catch (err) {
          const paystackError =
            err?.response?.data?.message ||
            err?.response?.data ||
            err?.message ||
            'Unknown Paystack error';

          console.error('❌ Paystack subaccount update failed:', {
            medicalCenterId: medicalCenter._id.toString(),
            facility_name: medicalCenter.facility_name,
            error: paystackError
          });

          medicalCenter.paystack.is_subaccount_active = false;
          medicalCenter.paystack.updated_at = new Date();
        }
      } else {
        medicalCenter.paystack.subaccount_code = null;
        medicalCenter.paystack.is_subaccount_active = false;
        medicalCenter.paystack.updated_at = new Date();
      }
    }

    await medicalCenter.save();

    const updatedCenter = await MedicalCenter.findById(medicalCenter._id).select('-password');

    return res.status(200).json({
      success: true,
      message: bankDetailsUpdated
        ? 'Profile and bank details updated successfully'
        : 'Profile updated successfully',
      data: updatedCenter
    });
  } catch (error) {
    console.error('Update profile error:', error);

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message:
          'Medical center with this email, company registration, or healthcare license already exists'
      });
    }

    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((val) => val.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Error updating profile',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

// ----------------------------------------------------------------------
// @desc    Get payment settings
// @route   GET /api/medical-centers/payment-settings
// @access  Private
// ----------------------------------------------------------------------
const getPaymentSettings = async (req, res) => {
  try {
    const center = await MedicalCenter.findById(req.medicalCenter._id).select(
      'paymentSettings facility_name medical_center_id'
    );

    if (!center) {
      return res.status(404).json({
        success: false,
        message: 'Medical center not found'
      });
    }

    return res.status(200).json({
      success: true,
      data: center.paymentSettings
    });
  } catch (error) {
    console.error('Get payment settings error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch payment settings'
    });
  }
};

// ----------------------------------------------------------------------
// @desc    Update payment settings
// @route   PUT /api/medical-centers/payment-settings
// @access  Private
// ----------------------------------------------------------------------
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

    if (enablePayments !== undefined) {
      updates['paymentSettings.enablePayments'] = enablePayments;
    }

    if (consultationFee !== undefined) {
      updates['paymentSettings.consultationFee'] = consultationFee;
    }

    if (onlineConsultationFee !== undefined) {
      updates['paymentSettings.onlineConsultationFee'] = onlineConsultationFee;
    }

    if (allowPartialPayments !== undefined) {
      updates['paymentSettings.allowPartialPayments'] = allowPartialPayments;
    }

    if (paymentMethods !== undefined) {
      updates['paymentSettings.paymentMethods'] = paymentMethods;
    }

    if (currency !== undefined) {
      updates['paymentSettings.currency'] = currency;
    }

    if (bookingDeposit !== undefined) {
      updates['paymentSettings.bookingDeposit'] = bookingDeposit;
      updates['paymentSettings.depositPercentage'] = 0;
    }

    if (depositPercentage !== undefined) {
      updates['paymentSettings.depositPercentage'] = depositPercentage;

      const feeToUse =
        consultationFee !== undefined
          ? consultationFee
          : undefined;

      if (feeToUse !== undefined) {
        updates['paymentSettings.bookingDeposit'] = Math.round(
          (feeToUse * depositPercentage) / 100
        );
      }
    }

    updates['paymentSettings.lastUpdated'] = new Date();

    const center = await MedicalCenter.findByIdAndUpdate(
      req.medicalCenter._id,
      { $set: updates },
      { new: true, runValidators: false }
    ).select('paymentSettings');

    if (!center) {
      return res.status(404).json({
        success: false,
        message: 'Medical center not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Payment settings updated successfully',
      data: center.paymentSettings
    });
  } catch (error) {
    console.error('Update payment settings error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update payment settings'
    });
  }
};

// ----------------------------------------------------------------------
// @desc    Update bank details & create/refresh Paystack subaccount
// @route   PUT /api/medical-centers/bank-details
// @access  Private
// ----------------------------------------------------------------------
const updateBankDetails = async (req, res) => {
  try {
    const { bank_name, bank_code, account_number, account_name } = req.body;

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

    const cleanedBankDetails = buildCleanBankDetails(
      { bank_name, bank_code, account_number, account_name },
      medicalCenter.facility_name
    );

    const shouldCreateOrRecreateSubaccount =
      !medicalCenter.paystack?.subaccount_code ||
      medicalCenter.paystack?.is_subaccount_active !== true;

    if (shouldCreateOrRecreateSubaccount) {
      const subaccount = await createPaystackSubaccount({
        business_name: medicalCenter.facility_name,
        settlement_bank: cleanedBankDetails.bank_code,
        account_number: cleanedBankDetails.account_number,
        percentage_charge: 0
      });

      medicalCenter.paystack.subaccount_code = subaccount.subaccount_code;
      medicalCenter.paystack.is_subaccount_active = true;
      medicalCenter.paystack.bank_details = cleanedBankDetails;
      medicalCenter.paystack.created_at = medicalCenter.paystack.created_at || new Date();
      medicalCenter.paystack.updated_at = new Date();
    } else {
      medicalCenter.paystack.bank_details = cleanedBankDetails;
      medicalCenter.paystack.updated_at = new Date();
    }

    await medicalCenter.save();

    return res.status(200).json({
      success: true,
      message: 'Bank details saved successfully',
      data: {
        subaccount_code: medicalCenter.paystack.subaccount_code,
        is_subaccount_active: medicalCenter.paystack.is_subaccount_active,
        bank_details: medicalCenter.paystack.bank_details
      }
    });
  } catch (error) {
    console.error('Update bank details error:', {
      message: error.message,
      paystack: error.response?.data || null
    });

    return res.status(500).json({
      success: false,
      message: 'Failed to save bank details',
      error: process.env.NODE_ENV === 'production' ? {} : error.message
    });
  }
};

// ----------------------------------------------------------------------
// @desc    Forgot password
// @route   POST /api/medical-centers/forgot-password
// @access  Public
// ----------------------------------------------------------------------
const forgotPasswordMedicalCenter = async (req, res) => {
  try {
    const { email } = req.body;

    const center = await MedicalCenter.findOne({
      official_domain_email: email?.trim().toLowerCase()
    });

    if (!center) {
      return res.status(200).json({
        success: true,
        message: 'If email exists, reset link sent'
      });
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

    return res.json({
      success: true,
      message: 'Reset email sent'
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: 'Email failed'
    });
  }
};

// ----------------------------------------------------------------------
// @desc    Reset password
// @route   POST /api/medical-centers/reset-password/:token
// @access  Public
// ----------------------------------------------------------------------
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
      return res.status(400).json({
        success: false,
        message: 'Token invalid or expired'
      });
    }

    const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12;
    center.password = await bcrypt.hash(password, await bcrypt.genSalt(saltRounds));
    center.resetPasswordToken = undefined;
    center.resetPasswordExpire = undefined;

    await center.save({ validateBeforeSave: false });

    return res.json({
      success: true,
      message: 'Password reset successful'
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: 'Reset failed'
    });
  }
};

// ----------------------------------------------------------------------
// Exports
// ----------------------------------------------------------------------
module.exports = {
  registerMedicalCenter,
  loginMedicalCenter,
  getMe,
  getAllMedicalCenters,
  updateProfile,
  getPaymentSettings,
  updatePaymentSettings,
  updateBankDetails,
  forgotPasswordMedicalCenter,
  resetPasswordMedicalCenter
};