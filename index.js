const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const connectDB = require('./config/db');
const medicalCenterRoutes = require('./routes/medicalCenter');
const patientRoutes = require('./routes/patient');
const practitionerRoutes = require('./routes/practitioner');

const bookingRoutes = require('./routes/bookingRoutes'); // ✅ Added

const editingScheduleRoutes = require('./routes/editingNextWeek');
const defaultOperationalHoursRoutes = require('./routes/defaultOperationalHours');
const { generalLimiter } = require('./middleware/rateLimiter');
const paymentRoutes = require("./routes/paymentRoutes");
const paymentWebhook = require("./services/paymentWebhook");
const cron = require("node-cron");
const runCleanup = require("./jobs/cleanupExpired");



// Run every 2 minutes
cron.schedule("*/2 * * * *", () => {
  runCleanup();
});


// Load env vars
dotenv.config();

// Connect to database
connectDB();

const app = express();

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000' ,'https://e79688333d13.ngrok-free.app'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With','X-Paystack-Signature']
}));

// Handle preflight requests
app.options('*', cors());

app.use("/api/payments", paymentRoutes);
app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  paymentWebhook.handleWebhook
);


// Body parser middleware with increased limits for complex data
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Apply rate limiting to all routes
app.use(generalLimiter);

// Log all requests for debugging
// Log only in development (NEVER under load tests / production)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
  });
}

// Routes
app.use('/api/medical-centers', medicalCenterRoutes);
app.use('/api/patients', patientRoutes);  // Updated patient routes
app.use('/api/practitioners', practitionerRoutes);

app.use('/api/bookings', require('./routes/bookingRoutes'));

app.use('/api/editing-schedules', editingScheduleRoutes);
app.use('/api/default-operational-hours', defaultOperationalHoursRoutes);

// Health check route with detailed information
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Medical Center API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    version: '1.0.0',
    services: {
      database: 'Connected',
      defaultOperationalHours: 'Active',
      scheduling: 'Active'
    }
  });
});

// Enhanced test endpoints
app.get('/api/test', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Backend is working!',
    timestamp: new Date().toISOString(),
    endpoints: {
      patientRegister: 'POST /api/patients/register',
      patientLogin: 'POST /api/patients/login',
      medicalCenterRegister: 'POST /api/medical-centers/register',
      medicalCenterLogin: 'POST /api/medical-centers/login',
      practitionerLogin: 'POST /api/practitioners/login',
      addPractitioner: 'POST /api/practitioners',
      
      editingSchedules: 'GET /api/editing-schedules',
      defaultOperationalHours: {
        get: 'GET /api/default-operational-hours',
        create: 'POST /api/default-operational-hours',
        update: 'PUT /api/default-operational-hours',
        reset: 'POST /api/default-operational-hours/reset',
        validate: 'GET /api/default-operational-hours/validate',
        health: 'GET /api/default-operational-hours/health'
      }
    }
  });
});

// Handle undefined routes
app.all('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
    suggestion: 'Check /api/test for available endpoints'
  });
});

// Enhanced error handling middleware
app.use((err, req, res, next) => {
  console.error('Error Stack:', err.stack);
  console.error('Error Details:', err);
  
  // Mongoose validation error
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation Error',
      error: Object.values(err.errors).map(e => e.message)
    });
  }
  
  // Mongoose duplicate key error
  if (err.code === 11000) {
    return res.status(400).json({
      success: false,
      message: 'Duplicate field value entered',
      error: 'A record with this value already exists'
    });
  }
  
  // Mongoose cast error (invalid ObjectId)
  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      message: 'Invalid ID format',
      error: 'Please provide a valid resource ID'
    });
  }

  // Default error
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || 'Something went wrong!',
    error: process.env.NODE_ENV === 'production' ? {} : err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
  console.log(`📍 Test endpoint: http://localhost:${PORT}/api/test`);
  console.log(`📍 Default Operational Hours: http://localhost:${PORT}/api/default-operational-hours/health`);
});