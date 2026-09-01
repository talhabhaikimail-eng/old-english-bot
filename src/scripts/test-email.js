const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from the root .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

async function sendTestEmail() {
  const { EMAIL_USER, EMAIL_PASS, SMTP_HOST, SMTP_PORT, SENDER_EMAIL } = process.env;

  if (!EMAIL_USER || !EMAIL_PASS || !SMTP_HOST || !SMTP_PORT || !SENDER_EMAIL) {
    console.error('Missing required email configuration in .env');
    return;
  }

  // Create a transporter using SMTP
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: parseInt(SMTP_PORT, 10) === 465, // true for 465, false for other ports
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });

  try {
    // Send mail with defined transport object
    const info = await transporter.sendMail({
      from: `"Talha Codes" <${SENDER_EMAIL}>`, // Sender address must match the authenticated domain to avoid spam
      to: 'talhariaz5425869@gmail.com', // List of receivers
      subject: 'Test Email Notification from Your Bridge App', // Subject line
      text: 'Hello! This is a test email sent from the discord-whatsapp bridge to verify the SMTP configuration. Have a great day!', // plain text body
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
          <h2 style="color: #2c3e50;">Hello!</h2>
          <p style="font-size: 16px; line-height: 1.6;">
            This is a test email sent from your <strong>discord-whatsapp bridge</strong> to verify the SMTP configuration.
          </p>
          <p style="font-size: 16px; line-height: 1.6;">
            We've ensured the 'from' address matches your verified domain and formatted the email correctly with text and HTML parts to ensure it <strong>does not go to spam</strong>.
          </p>
          <br/>
          <p style="font-size: 14px; color: #7f8c8d; border-top: 1px solid #eee; padding-top: 10px;">
            Best regards,<br/>
            Talha Codes Bridge System
          </p>
        </div>
      `, // html body
      // Including a replyTo can also help with spam scores
      replyTo: SENDER_EMAIL,
    });

    console.log('Message sent successfully! Message ID: %s', info.messageId);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

sendTestEmail();
