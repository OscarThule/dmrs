const axios = require('axios');

const paystack = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json'
  }
});

/**
 * Create Paystack Subaccount for Medical Center
 */
const createPaystackSubaccount = async ({
  business_name,
  settlement_bank,
  account_number,
  percentage_charge = 0
}) => {
  const response = await paystack.post('/subaccount', {
    business_name,
    settlement_bank,
    account_number,
    percentage_charge
  });

  if (!response.data.status) {
    throw new Error(response.data.message);
  }

  return response.data.data;
};

module.exports = {
  createPaystackSubaccount
};
