const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const sendEmail = async ({ to, subject, html }) => {
  try {
    const msg = {
      to,
      from: process.env.FROM_EMAIL,
      subject,
      html
    };

    const res = await sgMail.send(msg);
    console.log('SendGrid success:', res[0].statusCode);
  } catch (err) {
    console.error('SendGrid error:', err.response?.body || err.message);
    throw err;
  }
};

module.exports = sendEmail;
