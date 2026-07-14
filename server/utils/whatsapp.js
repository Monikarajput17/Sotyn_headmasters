// WhatsApp deep-link generator.
//
// Mam (2026-05-21): the Complaints flow needs to send 3 WhatsApp
// messages — registration ack to client, assignment notice to the
// site engineer, and assignment + OTP to the client.  Until we
// provision a Business WhatsApp API (Twilio / Gupshup / Meta), we
// surface the messages as wa.me click-to-send links that mam (or her
// EA) clicks to actually fire from her own WhatsApp.
//
// Once an API is provisioned, swap `whatsappLink()` callers for an
// `await sendWhatsapp()` call here — every route already passes the
// phone + message string, so it's a one-place change.

// Normalise an Indian mobile number to E.164 without the '+' sign,
// because that's what wa.me expects:  https://wa.me/919876543210
//   '9876543210'           → '919876543210'
//   '09876543210'          → '919876543210'
//   '+91 9876-543-210'     → '919876543210'
//   '91-9876543210'        → '919876543210'
// Returns null if the input doesn't look like a valid 10-digit
// Indian mobile (so we don't generate broken links).
function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  // Strip a leading 0 if present (e.g. '09876543210' → '9876543210')
  let n = digits.replace(/^0+/, '');
  // Already prefixed with country code?
  if (n.length === 12 && n.startsWith('91')) return n;
  if (n.length === 11 && n.startsWith('1')) return n;  // unlikely IN format but keep
  // Bare 10-digit mobile → prepend 91
  if (n.length === 10) return '91' + n;
  // Anything else — caller can decide whether to use as-is
  return null;
}

function whatsappLink(phone, message) {
  const p = normalisePhone(phone);
  if (!p) return null;
  return `https://wa.me/${p}?text=${encodeURIComponent(message)}`;
}

// ── Message templates ──────────────────────────────────────────
// Centralised so wording stays consistent across endpoints + admin
// re-sends.  Each returns { phone, message, link }.

function complaintRegisterMsg({ client_name, complaint_number, company_name }) {
  const lines = [
    `Hello ${client_name},`,
    ``,
    `Your complaint *${complaint_number}* has been registered with Secured Engineers Pvt. Ltd.`,
    company_name ? `Site: ${company_name}` : null,
    ``,
    `Our team will contact you shortly to schedule a site visit.`,
    ``,
    `Thank you,`,
    `Secured Engineers Pvt. Ltd.`,
  ].filter(Boolean);
  return lines.join('\n');
}

function complaintAssignedToEngineerMsg({
  engineer_name, complaint_number, client_name, company_name, mobile_number, category, problem_detail,
}) {
  const lines = [
    `Hi ${engineer_name},`,
    ``,
    `You have been assigned complaint *${complaint_number}*.`,
    ``,
    `Client: ${client_name}`,
    company_name ? `Site / Company: ${company_name}` : null,
    category ? `Category: ${category}` : null,
    ``,
    `Problem:`,
    problem_detail,
    ``,
    mobile_number ? `Client contact: ${mobile_number}` : null,
    ``,
    `Please coordinate the site visit and update the ERP after work is complete.  The client will share a 4-digit resolution code with you — enter it in the Complaint Register to close the ticket.`,
    ``,
    `— Secured Engineers Pvt. Ltd.`,
  ].filter(Boolean);
  return lines.join('\n');
}

function complaintAssignedToClientMsg({
  client_name, complaint_number, engineer_name, engineer_phone, otp,
}) {
  const lines = [
    `Hello ${client_name},`,
    ``,
    `Your complaint *${complaint_number}* has been assigned to:`,
    ``,
    `${engineer_name}`,
    engineer_phone ? `📞 ${engineer_phone}` : null,
    ``,
    `Your resolution code is:  *${otp}*`,
    ``,
    `Please share this code with the engineer *only after* the work is completed to your satisfaction.  The engineer cannot close the ticket without it.`,
    ``,
    `Thank you,`,
    `Secured Engineers Pvt. Ltd.`,
  ].filter(Boolean);
  return lines.join('\n');
}

// 4-digit OTP — easy for a homeowner to read off WhatsApp without typos.
// Excludes 0000 / 1111 / 1234 / 9999 (too easy to guess / fat-finger).
function generateOtp() {
  const blocked = new Set(['0000', '1111', '1234', '9999', '2222', '3333', '4444', '5555', '6666', '7777', '8888']);
  for (let i = 0; i < 20; i += 1) {
    const n = String(Math.floor(1000 + Math.random() * 9000));
    if (!blocked.has(n)) return n;
  }
  return String(1000 + Math.floor(Math.random() * 9000));
}

module.exports = {
  normalisePhone,
  whatsappLink,
  generateOtp,
  complaintRegisterMsg,
  complaintAssignedToEngineerMsg,
  complaintAssignedToClientMsg,
};
