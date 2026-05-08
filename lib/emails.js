import { Resend } from 'resend';

const FROM = 'TreeSnap <noreply@treesnap.cloud>';
const REPLY_TO = 'hello@treesnap.cloud';

const TIER_PRICES = { starter: 79, pro: 129, proplus: 179 };

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

function fmtDate(date) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function fmtMoney(n) {
  return '$' + Number(n).toLocaleString('en-US');
}

function tierLabel(tier) {
  return { starter: 'Starter', pro: 'Pro', proplus: 'Pro+' }[tier] ?? tier;
}

function wrap(content) {
  return `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#111;">
  <div style="background:#166534;padding:20px 32px;">
    <span style="color:#fff;font-weight:700;font-size:18px;">TreeSnap</span>
  </div>
  <div style="padding:28px 32px;background:#fff;border:1px solid #e5e7eb;border-top:none;">
    ${content}
  </div>
  <div style="padding:14px 32px;background:#f9fafb;border:1px solid #e5e7eb;border-top:none;font-size:12px;color:#9ca3af;">
    TreeSnap &bull; AI-powered tree estimate tools for tree service companies
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Lifecycle emails
// ---------------------------------------------------------------------------

export async function sendWelcomeEmail(customer) {
  const tierPrice = TIER_PRICES[customer.tier] ?? 79;
  return getResend().emails.send({
    from: FROM,
    to: customer.email,
    replyTo: REPLY_TO,
    subject: 'Welcome to TreeSnap — your trial starts now',
    html: wrap(`
      <h2 style="margin:0 0 16px;">Welcome, ${customer.owner_name}!</h2>
      <p>Your TreeSnap tree estimate tool is being set up. Here's everything you need to know:</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px 20px;margin:20px 0;">
        <strong style="color:#166534;">Your tool URL:</strong><br>
        <a href="https://${customer.subdomain}.treesnap.cloud" style="color:#166534;font-size:16px;">
          https://${customer.subdomain}.treesnap.cloud
        </a>
      </div>
      <p><strong>Your plan: ${tierLabel(customer.tier)}</strong></p>
      <p>Your 14-day free trial runs until <strong>${fmtDate(customer.trial_end)}</strong>. After that,
         you'll be automatically charged <strong>${fmtMoney(tierPrice)}/month</strong> — no action needed.</p>
      <p>To cancel before your trial ends, reply to this email. No questions asked.</p>
      <p>We'll send you a heads-up 2 days before your trial ends.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
      <p style="color:#6b7280;font-size:14px;">Questions? Just reply to this email.</p>
    `),
  });
}

export async function sendActivationEmail(customer) {
  return getResend().emails.send({
    from: FROM,
    to: customer.email,
    replyTo: REPLY_TO,
    subject: 'Your TreeSnap tool is live',
    html: wrap(`
      <h2 style="margin:0 0 16px;">Your tool is live!</h2>
      <p>Your tree estimate tool is ready at:</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px 20px;margin:20px 0;">
        <a href="https://${customer.subdomain}.treesnap.cloud" style="color:#166534;font-size:18px;font-weight:700;">
          https://${customer.subdomain}.treesnap.cloud
        </a>
      </div>
      <p><strong>How it works:</strong></p>
      <ul>
        <li>Share the link with homeowners or add it to your website</li>
        <li>Homeowners upload 1–3 photos of their tree and get an instant AI-generated estimate</li>
        <li>You'll receive an email for every submission with the homeowner's contact info and the estimate shown to them</li>
      </ul>
      <p>Estimates are preliminary — designed to qualify the lead and set price expectations before your on-site visit.</p>
    `),
  });
}

export async function sendTrialEndingEmail(customer) {
  const tierPrice = TIER_PRICES[customer.tier] ?? 79;
  return getResend().emails.send({
    from: FROM,
    to: customer.email,
    replyTo: REPLY_TO,
    subject: 'Your TreeSnap trial ends in 2 days',
    html: wrap(`
      <h2 style="margin:0 0 16px;">Your trial ends ${fmtDate(customer.trial_end)}</h2>
      <p>Your free trial expires in 2 days. Here's what happens next:</p>
      <div style="background:#fefce8;border:1px solid #fde68a;border-radius:6px;padding:16px 20px;margin:20px 0;">
        You'll be charged <strong>${fmtMoney(tierPrice)}/month</strong> on ${fmtDate(customer.trial_end)}
        for your ${tierLabel(customer.tier)} plan — unless you cancel before then.
      </div>
      <p>To cancel, reply to this email before ${fmtDate(customer.trial_end)}. No hard feelings.</p>
      <p style="margin-top:24px;padding-top:20px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:14px;">
        <strong>Haven't had enough traffic to get a real feel for the product?</strong><br>
        Reply to this email and we'll extend your trial by 7 days — one time, no questions asked.
      </p>
    `),
  });
}

export async function sendTrialExtendedEmail(customer) {
  const tierPrice = TIER_PRICES[customer.tier] ?? 79;
  return getResend().emails.send({
    from: FROM,
    to: customer.email,
    replyTo: REPLY_TO,
    subject: 'Your TreeSnap trial has been extended',
    html: wrap(`
      <h2 style="margin:0 0 16px;">Trial extended!</h2>
      <p>Your TreeSnap trial has been extended. Your new end date is:</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px 20px;margin:20px 0;">
        <strong style="font-size:18px;">${fmtDate(customer.trial_end)}</strong>
      </div>
      <p>After that, you'll be automatically charged <strong>${fmtMoney(tierPrice)}/month</strong>
         for your ${tierLabel(customer.tier)} plan. To cancel before the trial ends, reply to this email.</p>
    `),
  });
}

export async function sendSubscriptionStartedEmail(customer, amount) {
  return getResend().emails.send({
    from: FROM,
    to: customer.email,
    replyTo: REPLY_TO,
    subject: `TreeSnap — you're now on ${tierLabel(customer.tier)}`,
    html: wrap(`
      <h2 style="margin:0 0 16px;">You're now a TreeSnap subscriber!</h2>
      <p>Your trial has converted and you've been charged:</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px 20px;margin:20px 0;">
        <strong style="font-size:24px;">${fmtMoney(amount)}</strong>
        <span style="color:#6b7280;font-size:14px;"> for ${tierLabel(customer.tier)} plan</span>
      </div>
      <p>Your tool continues to run at
        <a href="https://${customer.subdomain}.treesnap.cloud" style="color:#166534;">
          ${customer.subdomain}.treesnap.cloud
        </a>
      </p>
      ${customer.current_period_end
        ? `<p>Next billing date: <strong>${fmtDate(customer.current_period_end)}</strong></p>`
        : ''}
      <p style="color:#6b7280;font-size:14px;">To manage your subscription or cancel, reply to this email.</p>
    `),
  });
}

export async function sendPaymentFailedEmail(customer) {
  return getResend().emails.send({
    from: FROM,
    to: customer.email,
    replyTo: REPLY_TO,
    subject: 'TreeSnap — payment failed',
    html: wrap(`
      <h2 style="margin:0 0 16px;color:#dc2626;">Payment failed</h2>
      <p>We weren't able to process your TreeSnap subscription payment. This can happen if your card expired or has insufficient funds.</p>
      <p>To keep your tool running, please reply to this email and we'll send you a secure payment update link.</p>
      <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:16px 20px;margin:20px 0;">
        <strong>You have a 5-day grace period.</strong> Your tool will continue to work.
        If payment is not updated within 5 days, your tool will be paused.
      </div>
      <p>Questions? Just reply to this email.</p>
    `),
  });
}

export async function sendPaymentFailedFinalEmail(customer) {
  return getResend().emails.send({
    from: FROM,
    to: customer.email,
    replyTo: REPLY_TO,
    subject: 'TreeSnap — your tool will be paused tomorrow',
    html: wrap(`
      <h2 style="margin:0 0 16px;color:#dc2626;">Action required: payment still outstanding</h2>
      <p>This is a final notice. Your TreeSnap payment is still outstanding and your tool will be
         <strong>paused tomorrow</strong> if we cannot process payment.</p>
      <p>Reply to this email immediately so we can send you a secure payment link.</p>
      <p>Once payment is processed, your tool will be reactivated right away.</p>
    `),
  });
}

export async function sendToolPausedEmail(customer) {
  return getResend().emails.send({
    from: FROM,
    to: customer.email,
    replyTo: REPLY_TO,
    subject: 'TreeSnap — your tool has been paused',
    html: wrap(`
      <h2 style="margin:0 0 16px;">Your tool has been paused</h2>
      <p>Due to outstanding payment, your TreeSnap tool at
         <strong>${customer.subdomain}.treesnap.cloud</strong> has been temporarily paused.
      </p>
      <p>Homeowners visiting your tool will see a message that the service is temporarily unavailable.</p>
      <p><strong>To reactivate:</strong> Reply to this email and we'll send you a secure payment link.
         Your tool will be restored within minutes of payment.</p>
    `),
  });
}

export async function sendCancellationEmail(customer) {
  return getResend().emails.send({
    from: FROM,
    to: customer.email,
    replyTo: REPLY_TO,
    subject: 'TreeSnap — your account has been canceled',
    html: wrap(`
      <h2 style="margin:0 0 16px;">Your account has been canceled</h2>
      <p>Your TreeSnap subscription has been canceled. We're sorry to see you go.</p>
      ${customer.current_period_end
        ? `<p>Your tool will remain active until <strong>${fmtDate(customer.current_period_end)}</strong>, then be taken offline.</p>`
        : ''}
      <p>Your estimate history and lead data will be retained for 90 days after cancellation.</p>
      <p>If you change your mind, you can restart at any time by replying to this email.</p>
      <p style="color:#6b7280;font-size:14px;">Thank you for giving TreeSnap a try.</p>
    `),
  });
}

export async function sendBillingReminderEmail(customer, amount, date) {
  return getResend().emails.send({
    from: FROM,
    to: customer.email,
    replyTo: REPLY_TO,
    subject: 'TreeSnap — upcoming renewal reminder',
    html: wrap(`
      <h2 style="margin:0 0 16px;">Renewal reminder</h2>
      <p>Your TreeSnap subscription will renew in 2 days:</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px 20px;margin:20px 0;">
        <strong>${fmtMoney(amount)}</strong> on <strong>${fmtDate(date)}</strong>
      </div>
      <p>To manage your subscription or update payment details, reply to this email.</p>
    `),
  });
}

// ---------------------------------------------------------------------------
// Lead / estimate emails
// ---------------------------------------------------------------------------

export async function sendLeadNotificationEmail(customer, lead, estimate, photoUrls = []) {
  const serviceLabels = {
    removal: 'Tree Removal', trimming: 'Trimming / Pruning',
    storm_damage: 'Storm Damage Cleanup', emergency: 'Emergency Service',
  };
  const serviceLabel = serviceLabels[lead.serviceType] || lead.serviceType;

  const lineItemsHtml = (estimate.line_items || []).map(item => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${item.description}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;">
        ${fmtMoney(item.price_low ?? item.low)} – ${fmtMoney(item.price_high ?? item.high)}
      </td>
    </tr>`).join('');

  const photosHtml = photoUrls.length > 0 ? `
  <div style="margin-top:24px;">
    <p style="font-weight:600;margin:0 0 12px;">Submitted Photos</p>
    <div style="display:flex;gap:12px;flex-wrap:wrap;">
      ${photoUrls.map((url, i) => `
        <a href="${url}" target="_blank" style="display:block;">
          <img src="${url}" alt="Photo ${i + 1}"
               style="width:160px;height:120px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;" />
        </a>
      `).join('')}
    </div>
    <p style="font-size:12px;color:#9ca3af;margin:8px 0 0;">
      Photo links expire in 7 days. Click any photo to view full size.
    </p>
  </div>` : '';

  const businessName = customer.business_name || customer.company_name;

  return getResend().emails.send({
    from: FROM,
    to: customer.email,
    replyTo: lead.email,
    subject: `New lead: ${lead.name} — ${serviceLabel}`,
    html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#111;">
  <div style="background:#166534;padding:20px 32px;">
    <span style="color:#fff;font-weight:700;font-size:18px;">New Lead — ${businessName}</span>
  </div>
  <div style="padding:28px 32px;background:#fff;border:1px solid #e5e7eb;border-top:none;">
    <h2 style="margin:0 0 16px;font-size:16px;">Customer Info</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr><td style="padding:6px 0;color:#6b7280;width:120px;">Name</td><td style="padding:6px 0;font-weight:600;">${lead.name}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Phone</td><td style="padding:6px 0;"><a href="tel:${lead.phone}" style="color:#166534;font-weight:600;">${lead.phone}</a></td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Email</td><td style="padding:6px 0;"><a href="mailto:${lead.email}" style="color:#166534;">${lead.email}</a></td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Zip Code</td><td style="padding:6px 0;">${lead.zip}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Service</td><td style="padding:6px 0;">${serviceLabel}</td></tr>
    </table>
    <h2 style="margin:0 0 16px;font-size:16px;">Estimate Shown to Customer</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:8px;border:1px solid #e5e7eb;border-radius:6px;">
      ${lineItemsHtml}
      <tr style="background:#f0fdf4;">
        <td style="padding:10px 12px;font-weight:700;">Total Estimate</td>
        <td style="padding:10px 12px;font-weight:700;text-align:right;color:#166534;">
          ${fmtMoney(estimate.total_low)} – ${fmtMoney(estimate.total_high)}
        </td>
      </tr>
    </table>
    <p style="font-size:13px;color:#6b7280;margin:8px 0 24px;">
      ${estimate.species} | ${estimate.estimated_height} | Condition: ${estimate.condition} | Complexity: ${estimate.complexity}
    </p>
    ${estimate.safety_concerns?.length ? `
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:12px 16px;margin-bottom:20px;">
      <strong style="color:#dc2626;">Safety Concerns:</strong>
      <ul style="margin:8px 0 0;padding-left:20px;color:#dc2626;">
        ${estimate.safety_concerns.map(c => `<li>${c}</li>`).join('')}
      </ul>
    </div>` : ''}
    <p style="color:#374151;"><strong>AI Notes:</strong> ${estimate.notes}</p>
    ${photosHtml}
  </div>
  <div style="padding:14px 32px;background:#f9fafb;border:1px solid #e5e7eb;border-top:none;font-size:12px;color:#9ca3af;">
    Sent by TreeSnap &bull; Preliminary estimate only — subject to in-person assessment
  </div>
</div>`,
  });
}

// ---------------------------------------------------------------------------
// Provisioning / lead flow emails
// ---------------------------------------------------------------------------

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'hello@treesnap.cloud';
const SETUP_FEES  = { starter: 299, pro: 399, proplus: 499 };

export async function sendLeadAcknowledgmentEmail(lead) {
  return getResend().emails.send({
    from:    FROM,
    to:      lead.email,
    replyTo: REPLY_TO,
    subject: 'We received your TreeSnap application',
    html: wrap(`
      <h2 style="margin:0 0 16px;">Thanks for applying, ${lead.name.split(' ')[0]}!</h2>
      <p>We've received your application for a TreeSnap tree estimate tool.</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px 20px;margin:20px 0;">
        <strong>Requested subdomain:</strong> ${lead.subdomain}.treesnap.cloud<br>
        <strong>Plan:</strong> ${tierLabel(lead.tier)}
      </div>
      <p>We typically review applications within 1 business day. You'll receive an email with next steps shortly.</p>
      <p style="color:#6b7280;font-size:14px;">Questions? Reply to this email.</p>
    `),
  });
}

export async function sendLeadNotificationToAdmin(lead) {
  return getResend().emails.send({
    from:    FROM,
    to:      ADMIN_EMAIL,
    subject: `New TreeSnap application: ${lead.company} (${tierLabel(lead.tier)})`,
    html: wrap(`
      <h2 style="margin:0 0 16px;">New Lead</h2>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:6px 0;color:#6b7280;width:140px;">Name</td><td style="padding:6px 0;font-weight:600;">${lead.name}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Company</td><td style="padding:6px 0;">${lead.company}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Email</td><td style="padding:6px 0;">${lead.email}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Phone</td><td style="padding:6px 0;">${lead.phone}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Subdomain</td><td style="padding:6px 0;">${lead.subdomain}.treesnap.cloud</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Tier</td><td style="padding:6px 0;">${tierLabel(lead.tier)} ($${SETUP_FEES[lead.tier] ?? 299} setup)</td></tr>
        ${lead.zip ? `<tr><td style="padding:6px 0;color:#6b7280;">Zip</td><td style="padding:6px 0;">${lead.zip}</td></tr>` : ''}
      </table>
      <p style="margin-top:20px;color:#6b7280;font-size:13px;">
        Review in the <a href="https://treesnap.cloud/admin.html" style="color:#166534;">admin panel</a>.
      </p>
    `),
  });
}

export async function sendApprovalEmail(lead, checkoutUrl) {
  const setupFee   = SETUP_FEES[lead.tier] ?? 299;
  const monthly    = TIER_PRICES[lead.tier] ?? 79;
  return getResend().emails.send({
    from:    FROM,
    to:      lead.email,
    replyTo: REPLY_TO,
    subject: 'Your TreeSnap application is approved — complete setup',
    html: wrap(`
      <h2 style="margin:0 0 16px;">You're approved!</h2>
      <p>Your TreeSnap application has been reviewed and approved. To activate your tool, complete the one-time setup payment:</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px 20px;margin:20px 0;">
        <strong>One-time setup fee:</strong> ${fmtMoney(setupFee)}<br>
        <strong>Plan:</strong> ${tierLabel(lead.tier)} — ${fmtMoney(monthly)}/month after 30-day free trial<br>
        <strong>Your URL:</strong> ${lead.subdomain}.treesnap.cloud
      </div>
      <div style="text-align:center;margin:28px 0;">
        <a href="${checkoutUrl}"
           style="display:inline-block;background:#166534;color:#fff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:700;font-size:16px;">
          Complete Setup →
        </a>
      </div>
      <p style="font-size:13px;color:#6b7280;">This link expires in 24 hours. Reply to this email if you need a new one.</p>
    `),
  });
}

export async function sendRejectionEmail(lead, reason) {
  return getResend().emails.send({
    from:    FROM,
    to:      lead.email,
    replyTo: REPLY_TO,
    subject: 'Update on your TreeSnap application',
    html: wrap(`
      <h2 style="margin:0 0 16px;">Application Update</h2>
      <p>Thank you for your interest in TreeSnap. After reviewing your application, we're unable to approve it at this time.</p>
      ${reason
        ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:12px 16px;margin:20px 0;">
             <strong>Reason:</strong> ${reason}
           </div>`
        : ''}
      <p>If you have questions or would like to reapply, please reply to this email.</p>
      <p style="color:#6b7280;font-size:14px;">Thank you for considering TreeSnap.</p>
    `),
  });
}

export async function sendUpgradeCheckoutEmail(customer, targetTier, checkoutUrl, upgradeFee) {
  const newMonthly = TIER_PRICES[targetTier] ?? 79;
  return getResend().emails.send({
    from:    FROM,
    to:      customer.email,
    replyTo: REPLY_TO,
    subject: `Upgrade your TreeSnap plan to ${tierLabel(targetTier)}`,
    html: wrap(`
      <h2 style="margin:0 0 16px;">Upgrade to ${tierLabel(targetTier)}</h2>
      <p>You've been invited to upgrade your TreeSnap plan.</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px 20px;margin:20px 0;">
        <strong>One-time upgrade fee:</strong> ${fmtMoney(upgradeFee)}<br>
        <strong>New monthly rate:</strong> ${fmtMoney(newMonthly)}/month (starting next billing cycle)
      </div>
      <div style="text-align:center;margin:28px 0;">
        <a href="${checkoutUrl}"
           style="display:inline-block;background:#166534;color:#fff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:700;font-size:16px;">
          Upgrade Now →
        </a>
      </div>
      <p style="font-size:13px;color:#6b7280;">Questions? Reply to this email.</p>
    `),
  });
}

export async function sendHomeownerEstimateEmail(homeowner, estimate, customer) {
  const serviceLabels = {
    removal: 'Tree Removal', trimming: 'Trimming / Pruning',
    storm_damage: 'Storm Damage Cleanup', emergency: 'Emergency Service',
  };
  const serviceLabel = serviceLabels[homeowner.serviceType] || homeowner.serviceType;

  const lineItemsHtml = (estimate.line_items || []).map(item => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${item.description}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;">
        ${fmtMoney(item.price_low ?? item.low)} – ${fmtMoney(item.price_high ?? item.high)}
      </td>
    </tr>`).join('');

  const businessName = customer.business_name || customer.company_name;
  const businessPhone = customer.phone;
  const businessEmail = customer.email;

  return getResend().emails.send({
    from: FROM,
    to: homeowner.email,
    replyTo: businessEmail,
    subject: `Your tree estimate from ${businessName}`,
    html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#111;">
  <div style="background:#166534;padding:24px 32px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:20px;">Your Estimate is Ready</h1>
    <p style="color:#bbf7d0;margin:6px 0 0;font-size:14px;">${businessName}</p>
  </div>
  <div style="padding:28px 32px;background:#fff;border:1px solid #e5e7eb;border-top:none;">
    <p style="margin:0 0 20px;">Hi ${homeowner.name.split(' ')[0]}, here's your preliminary estimate for <strong>${serviceLabel}</strong>.</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:8px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
      ${lineItemsHtml}
      <tr style="background:#f0fdf4;">
        <td style="padding:10px 12px;font-weight:700;">Estimated Total</td>
        <td style="padding:10px 12px;font-weight:700;text-align:right;color:#166534;">
          ${fmtMoney(estimate.total_low)} – ${fmtMoney(estimate.total_high)}
        </td>
      </tr>
    </table>
    <p style="font-size:13px;color:#6b7280;margin:8px 0 24px;">
      ${estimate.species} | ${estimate.estimated_height} | Condition: ${estimate.condition}
    </p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px 20px;margin-bottom:20px;">
      <p style="margin:0;font-size:14px;color:#166534;">${estimate.notes}</p>
    </div>
    <div style="background:#fefce8;border:1px solid #fde68a;border-radius:6px;padding:12px 16px;margin-bottom:24px;font-size:13px;color:#92400e;">
      <strong>Disclaimer:</strong> This is a preliminary estimate based on submitted photos only.
      Final pricing is confirmed after an on-site assessment.
    </div>
    <div style="text-align:center;margin-top:8px;">
      <p style="margin:0 0 16px;font-weight:600;">Ready to book your free on-site visit?</p>
      ${businessPhone ? `<a href="tel:${businessPhone}" style="display:inline-block;background:#166534;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:16px;">Call ${businessPhone}</a>` : ''}
      ${businessEmail ? `<p style="margin:12px 0 0;font-size:13px;color:#6b7280;">Or email: <a href="mailto:${businessEmail}" style="color:#166534;">${businessEmail}</a></p>` : ''}
    </div>
  </div>
  <div style="padding:14px 32px;background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;font-size:12px;color:#9ca3af;text-align:center;">
    Powered by TreeSnap &bull; AI-generated preliminary estimate
  </div>
</div>`,
  });
}
