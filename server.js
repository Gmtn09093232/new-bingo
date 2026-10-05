// telegram-auth/server.js
//
// Bingo platform — single Render service
//
//   GET  /                 → public/index.html   (player Mini App)
//   GET  /admin            → public/admin.html   (admin console)
//   GET  /app.js, /…       → any static asset from public/
//   POST /telegram-auth    → verify Telegram initData, mint Supabase session
//   GET  /health           → liveness probe
//   GET  /status           → JSON status (for browser debugging)

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- env ----------
const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  TELEGRAM_BOT_TOKEN,
} = process.env;

const USER_EMAIL_DOMAIN = process.env.USER_EMAIL_DOMAIN || 'telegram.local';
const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN    || '*';
const PORT              = process.env.PORT              || 10000;
const MAX_AUTH_AGE_SEC  = 60 * 60 * 24;   // 24 h

for (const [k, v] of Object.entries({
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN,
})) {
  if (!v) { console.error(`[telegram-auth] missing env: ${k}`); process.exit(1); }
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// CORS — open, because Telegram Mini App WebViews originate from many places.
// Security comes from the initData hash, not from an origin allowlist.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ============================================================================
// API ROUTES  (must be declared BEFORE express.static so POST works)
// ============================================================================

app.get('/health', (_req, res) =>
  res.json({ ok: true, at: new Date().toISOString() })
);

app.get('/status', (_req, res) =>
  res.json({
    service: 'bingo',
    status:  'up',
    at:      new Date().toISOString(),
    endpoints: {
      'GET  /':              'Player Mini App',
      'GET  /admin':         'Admin console',
      'POST /telegram-auth': 'Validate Telegram initData and mint a Supabase session',
      'GET  /health':        'Liveness probe',
    },
  })
);

app.post('/telegram-auth', handleAuth);

// ============================================================================
// STATIC FILES  (HTML, JS, images, CSS from public/)
// ============================================================================
//
//   index: 'index.html'  → GET /       serves public/index.html
//   extensions: ['html'] → GET /admin  serves public/admin.html
//   maxAge: '1h'         → browser cache; safe because HTML is fetched fresh
//
app.use(express.static(PUBLIC_DIR, {
  index:      'index.html',
  extensions: ['html'],
  maxAge:     '1h',
  etag:       true,
}));

// ============================================================================
// 404 — JSON for API paths, plain text otherwise
// ============================================================================

app.use((req, res) => {
  if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.includes('.')) {
    return res.status(404).json({ error: 'NOT_FOUND', path: req.path });
  }
  res.status(404).send('Not found');
});

// ============================================================================
// MAIN HANDLER — /telegram-auth
// ============================================================================

async function handleAuth(req, res) {
  try {
    const initData = req.body?.initData;
    if (!initData || typeof initData !== 'string') {
      return res.status(400).json({ error: 'MISSING_INIT_DATA' });
    }

    const verified = verifyTelegramInitData(initData, TELEGRAM_BOT_TOKEN);
    if (!verified.ok) {
      console.warn('[telegram-auth] verification failed:', verified.error);
      return res.status(401).json({ error: verified.error });
    }
    const tg = verified.user;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const email    = `tg_${tg.id}@${USER_EMAIL_DOMAIN}`;
    const password = derivePassword(tg.id, TELEGRAM_BOT_TOKEN);

    let session = null;

    // Fast path: try to sign in.
    const signIn = await authClient.auth.signInWithPassword({ email, password });
    if (!signIn.error && signIn.data.session) {
      session = signIn.data.session;
    } else {
      // Create the user.
      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: telegramMetadata(tg),
      });

      const alreadyExists =
        created.error &&
        /already|duplicate|registered/i.test(created.error.message);

      if (created.error && !alreadyExists) {
        console.error('[telegram-auth] createUser failed:', created.error.message);
        return res.status(500).json({ error: 'USER_CREATE_FAILED' });
      }

      // Existing account with a stale password (bot token rotated).
      if (alreadyExists) {
        const { data: profile, error: pErr } = await admin
          .from('profiles')
          .select('id')
          .eq('telegram_id', tg.id)
          .maybeSingle();

        if (pErr || !profile) {
          console.error('[telegram-auth] profile lookup failed:', pErr?.message);
          return res.status(500).json({ error: 'PROFILE_LOOKUP_FAILED' });
        }

        const reset = await admin.auth.admin.updateUserById(profile.id, { password });
        if (reset.error) {
          console.error('[telegram-auth] password reset failed:', reset.error.message);
          return res.status(500).json({ error: 'PASSWORD_RESET_FAILED' });
        }
      }

      const retry = await authClient.auth.signInWithPassword({ email, password });
      if (retry.error || !retry.data.session) {
        console.error('[telegram-auth] retry sign-in failed:', retry.error?.message);
        return res.status(500).json({ error: 'SIGNIN_FAILED' });
      }
      session = retry.data.session;
    }

    const userId = session.user.id;

    await admin
      .from('profiles')
      .update({
        telegram_username:   tg.username      ?? null,
        telegram_first_name: tg.first_name    ?? null,
        telegram_last_name:  tg.last_name     ?? null,
        telegram_photo_url:  tg.photo_url     ?? null,
        telegram_language:   tg.language_code ?? null,
        display_name:        tg.first_name ?? tg.username ?? 'Player',
        avatar_url:          tg.photo_url     ?? null,
        last_seen:           new Date().toISOString(),
      })
      .eq('id', userId);

    return res.json({
      access_token:  session.access_token,
      refresh_token: session.refresh_token,
      expires_at:    session.expires_at,
      user: { id: userId, telegram_id: tg.id },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[telegram-auth] unhandled error:', msg);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
}

// ---------- listen ----------
app.listen(PORT, () => {
  console.log(`[bingo] listening on :${PORT}`);
  console.log(`[bingo] serving static from ${PUBLIC_DIR}`);
  console.log(`[bingo]   GET  /`);
  console.log(`[bingo]   GET  /admin`);
  console.log(`[bingo]   POST /telegram-auth`);
});

// ============================================================================
// TELEGRAM INITDATA VERIFICATION
// ============================================================================

function verifyTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData);

  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'MISSING_HASH' };

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate) return { ok: false, error: 'MISSING_AUTH_DATE' };

  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec < -60)              return { ok: false, error: 'AUTH_DATE_IN_FUTURE' };
  if (ageSec > MAX_AUTH_AGE_SEC) return { ok: false, error: 'EXPIRED' };

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey   = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHex = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!timingSafeEqualHex(computedHex, hash.toLowerCase())) {
    return { ok: false, error: 'INVALID_HASH' };
  }

  const raw = params.get('user');
  if (!raw) return { ok: false, error: 'MISSING_USER' };

  let user;
  try { user = JSON.parse(raw); }
  catch { return { ok: false, error: 'INVALID_USER_JSON' }; }

  if (!user?.id || typeof user.id !== 'number') {
    return { ok: false, error: 'INVALID_TELEGRAM_ID' };
  }
  return { ok: true, user };
}

function telegramMetadata(tg) {
  return {
    telegram_id:         String(tg.id),
    telegram_username:   tg.username      ?? null,
    telegram_first_name: tg.first_name    ?? null,
    telegram_last_name:  tg.last_name     ?? null,
    telegram_photo_url:  tg.photo_url     ?? null,
    telegram_language:   tg.language_code ?? null,
    display_name:        tg.first_name ?? tg.username ?? 'Player',
  };
}

function derivePassword(telegramId, botToken) {
  const sig = createHmac('sha256', botToken).update(`tg-pw:${telegramId}`).digest();
  const b64 = sig.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `Tg!${b64}Aa1`;
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return nodeTimingSafeEqual(ba, bb);
}
