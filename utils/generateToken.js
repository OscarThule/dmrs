const jwt = require('jsonwebtoken');

const generateToken = (id, type = 'medicalCenter') => {
  return jwt.sign({ id, type }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE,
  });
};

module.exports = { generateToken };