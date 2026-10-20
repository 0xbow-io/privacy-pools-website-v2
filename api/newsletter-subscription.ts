import type { VercelRequest, VercelResponse } from '@vercel/node';

const MAILERLITE_API_KEY = process.env.MAILERLITE_API_KEY;
const MAILERLITE_GROUP_ID = '164050012372731588';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function verifyTurnstile(token: string): Promise<boolean> {
  if (!TURNSTILE_SECRET_KEY) return false;
  const form = new URLSearchParams();
  form.append('secret', TURNSTILE_SECRET_KEY);
  form.append('response', token);
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!resp.ok) return false;
  const data = await resp.json();
  return data.success === true;
}

async function subscribeToMailerLite(email: string): Promise<{ id: string; email: string; status: string }> {
  if (!MAILERLITE_API_KEY) throw new Error('MailerLite API key not configured');

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const resp = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MAILERLITE_API_KEY}`,
      Accept: 'application/json',
    },
    body: JSON.stringify({
      email,
      status: 'active',
      groups: [MAILERLITE_GROUP_ID],
      subscribed_at: now,
    }),
  });

  const data = await resp.json();

  if (!resp.ok) {
    // Already subscribed — add to group
    if (resp.status === 422 && data.errors?.email?.includes('The email has already been taken.')) {
      return addToGroup(email);
    }
    throw new Error(data.message || `MailerLite error: ${resp.status}`);
  }

  return { id: data.data.id, email: data.data.email, status: data.data.status };
}

async function addToGroup(email: string): Promise<{ id: string; email: string; status: string }> {
  if (!MAILERLITE_API_KEY) throw new Error('MailerLite API key not configured');

  const searchResp = await fetch(
    `https://connect.mailerlite.com/api/subscribers?filter[email]=${encodeURIComponent(email)}`,
    {
      headers: { Authorization: `Bearer ${MAILERLITE_API_KEY}`, Accept: 'application/json' },
    },
  );
  const searchData = await searchResp.json();
  if (!searchResp.ok || !searchData.data?.length) throw new Error('Subscriber not found');

  const subscriberId = searchData.data[0].id;
  await fetch(`https://connect.mailerlite.com/api/subscribers/${subscriberId}/groups`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MAILERLITE_API_KEY}`,
      Accept: 'application/json',
    },
    body: JSON.stringify({ groups: [MAILERLITE_GROUP_ID] }),
  });

  return { id: subscriberId, email, status: 'active' };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email, 'cf-turnstile-response': turnstileToken } = req.body || {};

    if (!email || !turnstileToken) {
      return res.status(400).json({ error: 'Email and captcha verification are required' });
    }
    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const captchaValid = await verifyTurnstile(turnstileToken);
    if (!captchaValid) {
      return res.status(400).json({ error: 'Captcha verification failed' });
    }

    const result = await subscribeToMailerLite(email);
    return res.status(200).json({ success: true, message: 'Successfully subscribed', data: result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Internal server error';
    return res.status(500).json({ error: msg });
  }
}
