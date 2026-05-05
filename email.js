require('dotenv').config();
const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.FROM_EMAIL || 'WorkNest <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

async function sendInviteEmail({ toEmail, toName, inviterName, role, dept, token }) {
  if (!resend) {
    console.log(`[email] RESEND_API_KEY not set — invite link: ${APP_URL}/invite.html?token=${token}`);
    return { skipped: true };
  }

  const inviteUrl = `${APP_URL}/invite.html?token=${token}`;
  const roleText = role ? ` as <strong>${role}</strong>` : '';
  const deptText = dept ? ` in ${dept}` : '';

  const { data, error } = await resend.emails.send({
    from: FROM,
    to: toEmail,
    subject: `${inviterName} invited you to WorkNest`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#111827">
        <div style="margin-bottom:28px">
          <span style="font-size:20px;font-weight:800;color:#1d4ed8">WorkNest</span>
          <span style="font-size:12px;color:#9ca3af;margin-left:8px">Work Management</span>
        </div>

        <h2 style="font-size:22px;font-weight:700;margin:0 0 8px">You're invited, ${toName.split(' ')[0]}!</h2>
        <p style="color:#4b5563;margin:0 0 24px;line-height:1.6">
          <strong>${inviterName}</strong> has invited you to join their team on WorkNest${roleText}${deptText}.
        </p>

        <a href="${inviteUrl}"
           style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;
                  padding:12px 28px;border-radius:10px;font-weight:600;font-size:14px">
          Accept Invitation
        </a>

        <p style="margin:24px 0 0;font-size:12px;color:#9ca3af">
          Or copy this link: <a href="${inviteUrl}" style="color:#2563eb">${inviteUrl}</a><br>
          This invitation expires in 7 days.
        </p>
      </div>
    `,
  });

  if (error) throw new Error(error.message);
  return data;
}

module.exports = { sendInviteEmail };
