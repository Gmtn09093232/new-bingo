// supabase/functions/telegram-auth/index.ts
//
// Validates Telegram WebApp initData against the bot token, then mints a
// Supabase session for the corresponding user. Returns:
//
//   { access_token, refresh_token, expires_at, user: { id, telegram_id } }
//
// The client (app.js → authenticate()) calls sb.auth.setSession() with the
// two tokens. Bot token NEVER leaves this function.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

// ---------------------------------------------------------------------------
// ENV
// ---------------------------------------------------------------------------

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
const TELEGRAM_BOT_TOKEN        = Deno.env.get('TELEGRAM_BOT_TOKEN')!;

// Optional: override with a domain you actually own. `.local` is safe for
// GoTrue's email parser and will never receive real mail.
const USER_EMAIL_DOMAIN  = Deno.env.get('USER_EMAIL_DOMAIN') || 'telegram.local';

// Reject initData older than this.
const MAX_AUTH_AGE_SEC = 60 * 60 * 24;              // 24 hours

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'METHOD_NOT_ALLOWED' }, 405);

  try {
    // ---- 1. Parse body -----------------------------------------------------
    const body = await req.json().catch(() => null) as { initData?: string } | null;
    const initData = body?.initData;
    if (!initData || typeof initData !== 'string') {
      return json({ error: 'MISSING_INIT_DATA' }, 400);
    }

    // ---- 2. Verify Telegram initData --------------------------------------
    const verified = await verifyTelegramInitData(initData, TELEGRAM_BOT_TOKEN);
    if (!verified.ok) {
      console.warn('[telegram-auth] verification failed:', verified.error);
      return json({ error: verified.error }, 401);
    }
    const tg = verified.user;

    // ---- 3. Supabase clients ----------------------------------------------
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ---- 4. Deterministic email + password --------------------------------
    // Same Telegram user always maps to the same auth user. The password is a
    // keyed HMAC over the bot token — it never leaves this function.
    const email    = `tg_${tg.id}@${USER_EMAIL_DOMAIN}`;
    const password = await derivePassword(tg.id, TELEGRAM_BOT_TOKEN);

    // ---- 5. Fast path: try to sign in -------------------------------------
    let session: { access_token: string; refresh_token: string; expires_at?: number; user: { id: string } } | null = null;

    const signIn = await authClient.auth.signInWithPassword({ email, password });
    if (!signIn.error && signIn.data.session) {
      session = signIn.data.session as any;
    } else {
      // ---- 6. Create the user ---------------------------------------------
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
        return json({ error: 'USER_CREATE_FAILED' }, 500);
      }

      // If the account existed with a stale password (e.g. bot token rotated),
      // reset it. We locate the user via profiles.telegram_id.
      if (alreadyExists) {
        const { data: profile, error: pErr } = await admin
          .from('profiles')
          .select('id')
          .eq('telegram_id', tg.id)
          .maybeSingle();

        if (pErr || !profile) {
          console.error('[telegram-auth] profile lookup failed:', pErr?.message);
          return json({ error: 'PROFILE_LOOKUP_FAILED' }, 500);
        }

        const reset = await admin.auth.admin.updateUserById(profile.id, { password });
        if (reset.error) {
          console.error('[telegram-auth] password reset failed:', reset.error.message);
          return json({ error: 'PASSWORD_RESET_FAILED' }, 500);
        }
      }

      // Retry sign-in now that the user definitely exists with the right password
      const retry = await authClient.auth.signInWithPassword({ email, password });
      if (retry.error || !retry.data.session) {
        console.error('[telegram-auth] retry sign-in failed:', retry.error?.message);
        return json({ error: 'SIGNIN_FAILED' }, 500);
      }
      session = retry.data.session as any;
    }

    const userId = session.user.id;

    // ---- 7. Refresh profile fields (name, photo may have changed) ---------
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

    // ---- 8. Return the session --------------------------------------------
    return json({
      access_token:  session.access_token,
      refresh_token: session.refresh_token,
      expires_at:    session.expires_at,
      user: {
        id:          userId,
        telegram_id: tg.id,
      },
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[telegram-auth] unhandled error:', msg);
    return json({ error: 'INTERNAL_ERROR' }, 500);
  }
});

// ---------------------------------------------------------------------------
// TELEGRAM INITDATA VERIFICATION
// ---------------------------------------------------------------------------

interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
  is_premium?: boolean;
}

type VerifyResult =
  | { ok: true;  user: TelegramUser }
  | { ok: false; error: string };

async function verifyTelegramInitData(
  initData: string,
  botToken: string,
): Promise<VerifyResult> {
  const params = new URLSearchParams(initData);

  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'MISSING_HASH' };

  // auth_date freshness — reject replayed initData
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate) return { ok: false, error: 'MISSING_AUTH_DATE' };

  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec < -60) return { ok: false, error: 'AUTH_DATE_IN_FUTURE' };
  if (ageSec > MAX_AUTH_AGE_SEC) return { ok: false, error: 'EXPIRED' };

  // Build data_check_string from all fields except `hash`, sorted alphabetically
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // secret_key = HMAC-SHA256(key="WebAppData", message=bot_token)
  // computed   = HMAC-SHA256(key=secret_key,   message=data_check_string)
  const enc = new TextEncoder();

  const webAppDataKey = await crypto.subtle.importKey(
    'raw',
    enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const secretKeyBytes = await crypto.subtle.sign(
    'HMAC',
    webAppDataKey,
    enc.encode(botToken),
  );

  const hmacKey = await crypto.subtle.importKey(
    'raw',
    secretKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const computedBytes = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(dataCheckString));
  const computedHex   = toHex(computedBytes);

  if (!timingSafeEqual(computedHex, hash.toLowerCase())) {
    return { ok: false, error: 'INVALID_HASH' };
  }

  // Extract user
  const raw = params.get('user');
  if (!raw) return { ok: false, error: 'MISSING_USER' };

  let user: TelegramUser;
  try {
    user = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'INVALID_USER_JSON' };
  }
  if (!user?.id || typeof user.id !== 'number') {
    return { ok: false, error: 'INVALID_TELEGRAM_ID' };
  }

  return { ok: true, user };
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function telegramMetadata(tg: TelegramUser) {
  // Keys MUST match what handle_new_user() reads in database.sql
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

// Deterministic per-user password. Changing TELEGRAM_BOT_TOKEN invalidates
// existing derived passwords, which is handled by the reset branch above.
async function derivePassword(telegramId: number, botToken: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(botToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(`tg-pw:${telegramId}`)),
  );

  // base64url, then prefix with a symbol so it satisfies Supabase's
  // password policy regardless of which characters the HMAC happens to produce.
  let b64 = btoa(String.fromCharCode(...sigBytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `Tg!${b64}Aa1`;   // 47 chars, includes upper, lower, digit, symbol
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Constant-time string compare — prevents timing side-channels on the hash.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
