const MedicalCenter = require('../models/MedicalCenter');
const bcrypt = require('bcryptjs');
const { generateToken } = require('../utils/generateToken');
const { createPaystackSubaccount } = require('../services/paystackSubaccountService');
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------
const cleanString = (value) => {
  return typeof value === 'string' ? value.trim() : value;
};

const cleanEmail = (value) => {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
};

const isValidNumber = (value) => {
  return typeof value === 'number' && Number.isFinite(value);
};

const buildCleanAddress = (address = {}) => {
  const hasLatLng =
    isValidNumber(address.lat) &&
    isValidNumber(address.lng);

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
    cleanString(address.line1) || '',
    cleanString(address.line2) || '',
    cleanString(address.city) || '',
    cleanString(address.province) || '',
    cleanString(address.postal) || '',
    'South Africa'
  ]
    .filter(Boolean)
    .join(', ');

  return {
    line1: cleanString(address.line1) || '',
    line2: cleanString(address.line2) || '',
    city: cleanString(address.city) || '',
    province: cleanString(address.province) || '',
    postal: cleanString(address.postal) || '',
    full_address: cleanString(address.full_address) || builtFullAddress,
    formatted_address: cleanString(address.formatted_address) || '',
    place_id: cleanString(address.place_id) || '',
    lat: hasLatLng ? address.lat : null,
    lng: hasLatLng ? address.lng : null,
    location_source: finalLocationSource,
    is_location_verified: hasGooglePlaceData || finalLocationSource === 'geolocation'
  };
};

const buildCleanBankDetails = (bankDetails = {}, fallbackAccountName = '') => {
  return {
    bank_name: cleanString(bankDetails.bank_name) || '',
    bank_code: cleanString(bankDetails.bank_code) || '',
    account_number: cleanString(bankDetails.account_number) || '',
    account_name: cleanString(bankDetails.account_name) || cleanString(fallbackAccountName) || ''
  };
};

const hasCompleteBankDetails = (bankDetails = {}) => {
  return !!(
    bankDetails.bank_name &&
    bankDetails.bank_code &&
    bankDetails.account_number &&
    bankDetails.account_name
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
      !company_reg_number ||
      !healthcare_reg_number ||
      !facility_type ||
      !official_domain_email ||
      !phone ||
      !password ||
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
    const cleanedBankDetails = buildCleanBankDetails(bankDetails, facility_name);

    const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12;
    const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(saltRounds));

    const medicalCenter = await MedicalCenter.create({
      facility_name: cleanString(facility_name),
      company_reg_number: cleanString(company_reg_number),
      healthcare_reg_number: cleanString(healthcare_reg_number),
      facility_type: cleanString(facility_type),
      official_domain_email: cleanEmail(official_domain_email),
      phone: cleanString(phone),
      password: hashedPassword,
      address: cleanedAddress,
      paystack: {
        subaccount_code: null,
        is_subaccount_active: false,
        bank_details: cleanedBankDetails
      }
    });

    let subaccountMessage = null;

    if (hasCompleteBankDetails(cleanedBankDetails)) {
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
      } catch (err) {
        medicalCenter.paystack.subaccount_code = null;
        medicalCenter.paystack.is_subaccount_active = false;
        medicalCenter.paystack.updated_at = new Date();
        await medicalCenter.save();

        subaccountMessage =
          'Medical center registered, but payout setup failed. Please update valid bank details.';
      }
    } else {
      subaccountMessage =
        'Medical center registered without complete bank details. Payout setup is incomplete.';
    }

    const token = generateToken(medicalCenter._id);

    return res.status(201).json({
      success: true,
      message:
        subaccountMessage ||
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
        paymentSettings: medicalCenter.paymentSettings,
        paystack: medicalCenter.paystack
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
      official_domain_email: cleanEmail(email)
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

    medicalCenter.last_login = new Date();
    await medicalCenter.save();

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
// @desc    Update all allowed medical center settings
// @route   PUT /api/medical-centers/profile
// @access  Private
// ----------------------------------------------------------------------
const updateProfile = async (req, res) => {
  try {
    const medicalCenter = await MedicalCenter.findById(req.medicalCenter._id);

    if (!medicalCenter) {
      return res.status(404).json({
        success: false,
        message: 'Medical center not found'
      });
    }

    const {
      facility_name,
      company_reg_number,
      healthcare_reg_number,
      facility_type,
      description,
      website,
      official_domain_email,
      phone,
      address,
      bankDetails,
      paymentSettings,
      settings,
      admin_contact,
      billing,
      theme_colors,
      logo_url,
      defaultOperationalHours,
      parent_center_id,
      is_active
    } = req.body;

    // --------------------------------------------------
    // Protected fields: do not allow from this route
    // --------------------------------------------------
    delete req.body.password;
    delete req.body.medical_center_id;
    delete req.body.is_verified;
    delete req.body.verification_status;
    delete req.body.statistics;
    delete req.body.resetPasswordToken;
    delete req.body.resetPasswordExpire;
    delete req.body.practitioners;
    delete req.body.practitionerReferences;
    delete req.body.weeklySchedules;
    delete req.body.created_at;
    delete req.body.updated_at;
    delete req.body.last_login;
    delete req.body.verified_at;

    // --------------------------------------------------
    // Basic information
    // --------------------------------------------------
    if (facility_name !== undefined) medicalCenter.facility_name = cleanString(facility_name);
    if (company_reg_number !== undefined) medicalCenter.company_reg_number = cleanString(company_reg_number);
    if (healthcare_reg_number !== undefined) medicalCenter.healthcare_reg_number = cleanString(healthcare_reg_number);
    if (facility_type !== undefined) medicalCenter.facility_type = cleanString(facility_type);
    if (description !== undefined) medicalCenter.description = cleanString(description);
    if (website !== undefined) medicalCenter.website = cleanString(website);
    if (official_domain_email !== undefined) medicalCenter.official_domain_email = cleanEmail(official_domain_email);
    if (phone !== undefined) medicalCenter.phone = cleanString(phone);
    if (logo_url !== undefined) medicalCenter.logo_url = cleanString(logo_url);
    if (parent_center_id !== undefined) medicalCenter.parent_center_id = parent_center_id || null;
    if (is_active !== undefined) medicalCenter.is_active = !!is_active;

    // --------------------------------------------------
    // Address
    // --------------------------------------------------
    if (address !== undefined) {
      medicalCenter.address = buildCleanAddress(address);
    }

    // --------------------------------------------------
    // Admin contact
    // --------------------------------------------------
    if (admin_contact !== undefined) {
      medicalCenter.admin_contact = {
        name: cleanString(admin_contact?.name) || '',
        email: cleanEmail(admin_contact?.email) || '',
        phone: cleanString(admin_contact?.phone) || '',
        position: cleanString(admin_contact?.position) || ''
      };
    }

    // --------------------------------------------------
    // Theme colors
    // --------------------------------------------------
    if (theme_colors !== undefined) {
      medicalCenter.theme_colors = {
        primary: cleanString(theme_colors?.primary) || '#3B82F6',
        secondary: cleanString(theme_colors?.secondary) || '#10B981'
      };
    }

    // --------------------------------------------------
    // Billing
    // Block subscription_id and status from normal profile updates
    // --------------------------------------------------
    if (billing !== undefined) {
      medicalCenter.billing = {
        ...medicalCenter.billing?.toObject?.(),
        ...medicalCenter.billing,
        plan: billing.plan !== undefined ? cleanString(billing.plan) : medicalCenter.billing?.plan,
        next_billing_date: billing.next_billing_date !== undefined ? billing.next_billing_date : medicalCenter.billing?.next_billing_date,
        payment_method: billing.payment_method !== undefined ? cleanString(billing.payment_method) : medicalCenter.billing?.payment_method,
        is_shared_with_parent:
          billing.is_shared_with_parent !== undefined
            ? !!billing.is_shared_with_parent
            : medicalCenter.billing?.is_shared_with_parent
      };
    }

    // --------------------------------------------------
    // Center settings
    // --------------------------------------------------
    if (settings !== undefined) {
      medicalCenter.settings = {
        ...medicalCenter.settings?.toObject?.(),
        ...medicalCenter.settings,
        ...settings
      };
    }

    // --------------------------------------------------
    // Operational hours
    // --------------------------------------------------
    if (defaultOperationalHours !== undefined && Array.isArray(defaultOperationalHours)) {
      medicalCenter.defaultOperationalHours = defaultOperationalHours;
    }

    // --------------------------------------------------
    // Payment settings
    // --------------------------------------------------
    if (paymentSettings !== undefined) {
      const current = medicalCenter.paymentSettings || {};

      const nextConsultationFee =
        paymentSettings.consultationFee !== undefined
          ? Number(paymentSettings.consultationFee)
          : current.consultationFee || 0;

      const nextDepositPercentage =
        paymentSettings.depositPercentage !== undefined
          ? Number(paymentSettings.depositPercentage)
          : current.depositPercentage || 0;

      const nextBookingDeposit =
        paymentSettings.bookingDeposit !== undefined
          ? Number(paymentSettings.bookingDeposit)
          : current.bookingDeposit || 0;

      let finalBookingDeposit = nextBookingDeposit;

      if (paymentSettings.depositPercentage !== undefined && paymentSettings.bookingDeposit === undefined) {
        finalBookingDeposit = Math.round((nextConsultationFee * nextDepositPercentage) / 100);
      }

      const remainingAmount = Math.max(0, nextConsultationFee - finalBookingDeposit);

      medicalCenter.paymentSettings = {
        ...current.toObject?.(),
        ...current,
        enablePayments:
          paymentSettings.enablePayments !== undefined
            ? !!paymentSettings.enablePayments
            : current.enablePayments,
        consultationFee: nextConsultationFee,
        bookingDeposit: finalBookingDeposit,
        depositPercentage: nextDepositPercentage,
        remainingAmount,
        onlineConsultationFee:
          paymentSettings.onlineConsultationFee !== undefined
            ? Number(paymentSettings.onlineConsultationFee)
            : current.onlineConsultationFee || 0,
        allowPartialPayments:
          paymentSettings.allowPartialPayments !== undefined
            ? !!paymentSettings.allowPartialPayments
            : current.allowPartialPayments,
        paymentMethods:
          paymentSettings.paymentMethods !== undefined
            ? paymentSettings.paymentMethods
            : current.paymentMethods,
        currency:
          paymentSettings.currency !== undefined
            ? cleanString(paymentSettings.currency)
            : current.currency || 'ZAR',
        lastUpdated: new Date()
      };
    }

    // --------------------------------------------------
    // Bank details + Paystack
    // --------------------------------------------------
    if (bankDetails !== undefined) {
      const cleanedBankDetails = buildCleanBankDetails(
        bankDetails,
        medicalCenter.facility_name
      );

      medicalCenter.paystack = medicalCenter.paystack || {};
      medicalCenter.paystack.bank_details = cleanedBankDetails;
      medicalCenter.paystack.updated_at = new Date();

      if (hasCompleteBankDetails(cleanedBankDetails)) {
        try {
          const shouldCreateSubaccount =
            !medicalCenter.paystack.subaccount_code ||
            medicalCenter.paystack.is_subaccount_active !== true;

          if (shouldCreateSubaccount) {
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
          } else {
            medicalCenter.paystack.is_subaccount_active = true;
          }
        } catch (err) {
          console.error('Paystack subaccount update failed:', err?.response?.data || err.message);
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
      message: 'Medical center settings updated successfully',
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
      message: 'Error updating medical center settings',
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
    const center = await MedicalCenter.findById(req.medicalCenter._id)
      .select('paymentSettings facility_name medical_center_id');

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
// @desc    Update payment settings only
// @route   PUT /api/medical-centers/payment-settings
// @access  Private
// ----------------------------------------------------------------------
const updatePaymentSettings = async (req, res) => {
  try {
    const medicalCenter = await MedicalCenter.findById(req.medicalCenter._id);

    if (!medicalCenter) {
      return res.status(404).json({
        success: false,
        message: 'Medical center not found'
      });
    }

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

    const current = medicalCenter.paymentSettings || {};

    const nextConsultationFee =
      consultationFee !== undefined ? Number(consultationFee) : current.consultationFee || 0;

    const nextDepositPercentage =
      depositPercentage !== undefined ? Number(depositPercentage) : current.depositPercentage || 0;

    let nextBookingDeposit =
      bookingDeposit !== undefined ? Number(bookingDeposit) : current.bookingDeposit || 0;

    if (depositPercentage !== undefined && bookingDeposit === undefined) {
      nextBookingDeposit = Math.round((nextConsultationFee * nextDepositPercentage) / 100);
    }

    const remainingAmount = Math.max(0, nextConsultationFee - nextBookingDeposit);

    medicalCenter.paymentSettings = {
      ...current.toObject?.(),
      ...current,
      enablePayments: enablePayments !== undefined ? !!enablePayments : current.enablePayments,
      consultationFee: nextConsultationFee,
      bookingDeposit: nextBookingDeposit,
      depositPercentage: nextDepositPercentage,
      remainingAmount,
      onlineConsultationFee:
        onlineConsultationFee !== undefined
          ? Number(onlineConsultationFee)
          : current.onlineConsultationFee || 0,
      allowPartialPayments:
        allowPartialPayments !== undefined
          ? !!allowPartialPayments
          : current.allowPartialPayments,
      paymentMethods: paymentMethods !== undefined ? paymentMethods : current.paymentMethods,
      currency: currency !== undefined ? cleanString(currency) : current.currency || 'ZAR',
      lastUpdated: new Date()
    };

    await medicalCenter.save();

    return res.status(200).json({
      success: true,
      message: 'Payment settings updated successfully',
      data: medicalCenter.paymentSettings
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
// @desc    Update bank details only
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
      official_domain_email: cleanEmail(email)
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