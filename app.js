/* ============================================================================
 * BINGO PLATFORM — app.js
 * Telegram Mini App + Multiplayer Stake Lobby + Admin Console
 * ----------------------------------------------------------------------------
 * Sections (search for the header to jump):
 *   TELEGRAM        SUPABASE        CONFIG          STATE
 *   AUTHENTICATION  UI              NAVIGATION      PLAYER / PROFILE
 *   LOBBY           STAKE ROOMS     CARD SELECTION  GAME
 *   REALTIME        BINGO           WALLET          HISTORY
 *   PAYMENTS        NOTIFICATIONS   ADMIN           INIT
 * ==========================================================================*/

'use strict';

/* ============================================================================
 * TELEGRAM
 * ==========================================================================*/

const TG = (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp) || null;
const IS_TELEGRAM = !!(TG && TG.initData && TG.initData.length > 0);
const IS_ADMIN_MODE = (typeof window !== 'undefined' && window.__APP_MODE__ === 'admin');
const IS_PLAYER_MODE = !IS_ADMIN_MODE;

const TG_USER = (() => {
  if (!TG) return null;
  // initDataUnsafe is fine for DISPLAY only. Never used for auth decisions.
  return TG.initDataUnsafe?.user || null;
})();

function tgInit() {
  if (!TG) return;
  try {
    TG.ready();
    TG.expand();
    if (TG.setHeaderColor) TG.setHeaderColor('secondary_bg_color');
    if (TG.setBackgroundColor) TG.setBackgroundColor('bg_color');
    if (TG.enableClosingConfirmation) TG.enableClosingConfirmation();
    TG.disableVerticalSwipes?.();
  } catch (_) { /* older Telegram clients */ }

  applyTgTheme();
  try { TG.onEvent('themeChanged', applyTgTheme); } catch (_) {}
}

function applyTgTheme() {
  if (!TG || !TG.themeParams) return;
  const t = TG.themeParams;
  const root = document.documentElement;
  const map = {
    '--tg-bg':            t.bg_color,
    '--tg-secondary-bg':  t.secondary_bg_color,
    '--tg-text':          t.text_color,
    '--tg-hint':          t.hint_color,
    '--tg-link':          t.link_color,
    '--tg-button':        t.button_color,
    '--tg-button-text':   t.button_text_color,
    '--tg-header-bg':     t.header_bg_color,
    '--tg-accent':        t.accent_text_color,
  };
  for (const [k, v] of Object.entries(map)) if (v) root.style.setProperty(k, v);
}

function tgHaptic(type = 'light') {
  try { TG?.HapticFeedback?.impactOccurred(type); } catch (_) {}
}
function tgNotify(type = 'success') {
  try { TG?.HapticFeedback?.notificationOccurred(type); } catch (_) {}
}
function tgAlert(msg) {
  if (TG?.showAlert) { TG.showAlert(String(msg)); }
  else { window.alert(String(msg)); }
}
function tgConfirm(msg) {
  return new Promise((resolve) => {
    if (TG?.showConfirm) TG.showConfirm(String(msg), (ok) => resolve(!!ok));
    else resolve(window.confirm(String(msg)));
  });
}
function tgMainButton(text, onClick) {
  if (!TG?.MainButton) return;
  TG.MainButton.setText(text).show();
  TG.MainButton.onClick(onClick);
}
function tgHideMainButton() {
  try { TG?.MainButton?.hide(); TG?.MainButton?.offClick(); } catch (_) {}
}


/* ============================================================================
 * SUPABASE
 * ==========================================================================*/

const SUPABASE_URL       = window.SUPABASE_URL      || 'https://yewjrkopdoffxpzhktqa.supabase.co';
const SUPABASE_ANON_KEY  = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlld2pya29wZG9mZnhwemhrdHFhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExODg1ODksImV4cCI6MjEwNjc2NDU4OX0.qE7IYYkRxJR1_3yxTsx09gQIcpPn2aas69QK42ZT3Dw';

// ⚠️  telegram-auth now runs on Render — set window.TELEGRAM_AUTH_URL in HTML.
//     Fallback to the legacy Edge Function URL for a transitional period.
const TELEGRAM_AUTH_URL  = window.TELEGRAM_AUTH_URL ||
                           (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/telegram-auth` : '');

let sb = null;   // supabase client

function sbInit() {
  if (!window.supabase || !window.supabase.createClient) {
    throw new Error('Supabase library not loaded. Include @supabase/supabase-js in HTML.');
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY missing.');
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession:     true,
      autoRefreshToken:   true,
      detectSessionInUrl: false,
    },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return sb;
}


/* ============================================================================
 * CONFIG
 * ==========================================================================*/

const APP = {
  version:           '2.1.0',
  heartbeatMs:       1000,        // local render tick
  engineTickMs:      2000,        // distributed tick_games() heartbeat
  winnerLobbyDelay:  5000,        // 5 s winner screen before returning
  maxCardGrid:       20,          // default grid size for card selection
  unsubscribeTimeoutMs: 1500,     // safety timeout on removeChannel
  maxRealtimeErrors: 5,           // give up after this many consecutive errors
};

const DEFAULT_BRANDING = {
  name: 'Bingo',
  primary: '#2AABEE',
  logo: null,
};


/* ============================================================================
 * STATE
 * ==========================================================================*/

const State = {
  booted:          false,
  session:         null,
  profile:         null,
  wallet:          null,
  settings:        {},
  stakeRooms:      [],

  // Active flow
  currentRoom:     null,
  currentGame:     null,
  myPlayer:        null,
  gameState:       null,
  availableCards:  new Set(),
  takenCards:      new Set(),

  // Realtime
  channel:         null,
  channelGameId:   null,
  notifChannel:    null,
  engineTimer:     null,
  renderTimer:     null,

  // Wallet/History cache
  transactions:    [],
  history:         [],
  notifications:   [],

  // Admin
  adminLiveGames:  [],
  adminSelectedGameId: null,

  view: 'lobby',
  toastTimer: null,
};


/* ============================================================================
 * AUTHENTICATION
 * ==========================================================================*/

async function authenticate() {
  if (!sb) throw new Error('Supabase not initialised.');

  // Already have a live session?  Reuse it.
  const { data: sess } = await sb.auth.getSession();
  if (sess?.session?.user) {
    State.session = sess.session;
    await loadProfile();
    if (!State.profile) {
      // Session exists but profile missing — sign out and redo.
      await sb.auth.signOut();
    } else {
      return State.session;
    }
  }

  if (IS_ADMIN_MODE) {
    // Admin mode: e-mail / password login handled by admin.html UI.
    return null;
  }

  if (!IS_TELEGRAM) {
    // Outside Telegram — anonymous session is DEV ONLY.
    const isLocal =
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1' ||
      location.protocol === 'file:';

    if (!isLocal) {
      throw new Error('This app must be opened inside Telegram.');
    }

    const { data, error } = await sb.auth.signInAnonymously();
    if (error) throw error;
    State.session = data.session;
    await loadProfile();
    // One retry in case the handle_new_user trigger is still running.
    if (!State.profile) {
      await new Promise((r) => setTimeout(r, 600));
      await loadProfile();
    }
    return State.session;
  }

  // ---- Telegram Mini App login ----
  const initData = TG.initData;
  if (!initData) throw new Error('Telegram initData missing.');

  if (!TELEGRAM_AUTH_URL) {
    throw new Error('TELEGRAM_AUTH_URL is not configured.');
  }

  const res = await fetch(TELEGRAM_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Telegram authentication failed (${res.status}). ${text}`);
  }

  const payload = await res.json();
  // telegram-auth returns { access_token, refresh_token, expires_at, user }
  const { error: setErr } = await sb.auth.setSession({
    access_token:  payload.access_token,
    refresh_token: payload.refresh_token,
  });
  if (setErr) throw setErr;

  const { data: sess2 } = await sb.auth.getSession();
  State.session = sess2.session;
  await loadProfile();
  if (!State.profile) {
    await new Promise((r) => setTimeout(r, 600));
    await loadProfile();
  }

  // Best-effort presence ping
  sb.rpc('touch_last_seen').then(() => {}, () => {});
  return State.session;
}

async function loadProfile() {
  const uid = State.session?.user?.id;
  if (!uid) { State.profile = null; return null; }

  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', uid)
    .maybeSingle();

  if (error) { console.warn('[profile]', error); State.profile = null; return null; }
  State.profile = data;
  return data;
}

async function loadWallet() {
  const uid = State.session?.user?.id;
  if (!uid) return null;
  const { data, error } = await sb
    .from('wallets')
    .select('*')
    .eq('user_id', uid)
    .maybeSingle();
  if (error) { console.warn('[wallet]', error); return null; }
  State.wallet = data;
  return data;
}

async function signOut() {
  try { await sb?.auth.signOut(); } catch (_) {}
  State.session = null;
  State.profile = null;
  State.wallet = null;
}


/* ============================================================================
 * UI HELPERS
 * ==========================================================================*/

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtMoney(n, currency = 'ETB') {
  const v = Number(n || 0);
  return `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function fmtDateTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return String(iso); }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function showToast(message, type = 'info', timeout = 3200) {
  const box = $('#toast');
  if (!box) { console.log('[toast]', type, message); return; }
  box.textContent = message;
  box.className = `toast show ${type}`;
  clearTimeout(State.toastTimer);
  State.toastTimer = setTimeout(() => { box.className = 'toast'; }, timeout);
}

function setBusy(el, busy) {
  if (!el) return;
  el.classList.toggle('busy', !!busy);
  el.disabled = !!busy;
}

function letterFor(n) {
  if (n <= 15) return 'B';
  if (n <= 30) return 'I';
  if (n <= 45) return 'N';
  if (n <= 60) return 'G';
  return 'O';
}

function letterColor(l) {
  return ({ B: '#3B82F6', I: '#EF4444', N: '#10B981', G: '#F59E0B', O: '#8B5CF6' })[l] || '#333';
}

// Shared helper — remove a realtime channel without hanging on a wedged socket.
async function removeChannelSafe(channel) {
  if (!channel) return;
  try {
    await Promise.race([
      sb.removeChannel(channel),
      new Promise((r) => setTimeout(r, APP.unsubscribeTimeoutMs)),
    ]);
  } catch (_) {}
}


/* ============================================================================
 * NAVIGATION (player bottom nav)
 * ==========================================================================*/

const VIEWS = ['lobby', 'game', 'wallet', 'profile', 'history'];

function switchView(view) {
  if (!VIEWS.includes(view)) view = 'lobby';
  State.view = view;

  $$('.view').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  $$('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.nav === view);
  });

  // Lazy-load per view
  if (view === 'wallet')  renderWallet();
  if (view === 'profile') renderProfile();
  if (view === 'history') renderHistory();
  if (view === 'lobby')   renderLobby();
  if (view === 'game')    renderGame();
  tgHaptic('light');
}


/* ============================================================================
 * PLAYER / PROFILE
 * ==========================================================================*/

function renderPlayerHeader() {
  const nameEl  = $('#player-name');
  const balEl   = $('#player-balance');
  const avEl    = $('#player-avatar');

  const p = State.profile;
  const w = State.wallet;

  const display = p?.telegram_first_name || p?.display_name || 'Player';
  if (nameEl) nameEl.textContent = display;

  if (balEl) balEl.textContent = fmtMoney(w?.balance ?? 0, w?.currency || 'ETB');

  if (avEl) {
    const url = p?.telegram_photo_url || p?.avatar_url || '';
    if (url) {
      avEl.style.backgroundImage = `url("${url}")`;
      avEl.textContent = '';
    } else {
      avEl.style.backgroundImage = '';
      avEl.textContent = display.charAt(0).toUpperCase();
    }
  }
}

function renderProfile() {
  const root = $('#profile-view');
  if (!root) return;
  const p = State.profile || {};
  const w = State.wallet  || {};

  const name = [p.telegram_first_name, p.telegram_last_name].filter(Boolean).join(' ') || p.display_name || 'Player';

  root.innerHTML = `
    <div class="profile-head">
      <div class="avatar-lg" style="${p.telegram_photo_url ? `background-image:url('${escapeHtml(p.telegram_photo_url)}')` : ''}">
        ${p.telegram_photo_url ? '' : escapeHtml(name.charAt(0).toUpperCase())}
      </div>
      <div class="profile-name">${escapeHtml(name)}</div>
      ${p.telegram_username ? `<div class="profile-username">@${escapeHtml(p.telegram_username)}</div>` : ''}
    </div>

    <div class="kv-list">
      <div class="kv"><span>Telegram ID</span><b>${escapeHtml(String(p.telegram_id ?? '—'))}</b></div>
      <div class="kv"><span>Language</span><b>${escapeHtml(p.telegram_language || '—')}</b></div>
      <div class="kv"><span>Member since</span><b>${fmtDateTime(p.created_at)}</b></div>
      <div class="kv"><span>Last seen</span><b>${fmtDateTime(p.last_seen)}</b></div>
      <div class="kv"><span>Status</span><b>${p.is_blocked ? '⛔ Blocked' : '✅ Active'}</b></div>
      <div class="kv"><span>Total staked</span><b>${fmtMoney(w.total_staked || 0, w.currency || 'ETB')}</b></div>
      <div class="kv"><span>Total won</span><b>${fmtMoney(w.total_won || 0, w.currency || 'ETB')}</b></div>
    </div>

    <button class="btn ghost" id="btn-refresh-profile">🔄 Refresh</button>
  `;

  $('#btn-refresh-profile')?.addEventListener('click', async () => {
    await Promise.all([loadProfile(), loadWallet()]);
    renderPlayerHeader();
    renderProfile();
    showToast('Profile updated', 'success');
  });
}


/* ============================================================================
 * LOBBY  (main page)
 * ==========================================================================*/

async function loadStakeRooms() {
  const { data, error } = await sb
    .from('stake_rooms')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error) { console.warn('[stake_rooms]', error); return []; }
  State.stakeRooms = data || [];
  return State.stakeRooms;
}

/**
 * For each stake room, look up the currently open lobby via peek_lobby so the
 * card grid preview shows correct occupancy.
 */
async function enrichStakeRoomsWithLobbyState() {
  const rooms = State.stakeRooms;
  const enriched = await Promise.all(rooms.map(async (room) => {
    try {
      const { data } = await sb.rpc('peek_lobby', { p_stake_room_id: room.id });
      return { room, lobby: data || null };
    } catch (e) {
      return { room, lobby: null };
    }
  }));
  State.stakeRooms = enriched.map((x) => ({ ...x.room, __lobby: x.lobby }));
  return State.stakeRooms;
}

async function renderLobby() {
  const root = $('#lobby-view');
  if (!root) return;

  renderPlayerHeader();

  if (!State.stakeRooms.length) {
    await loadStakeRooms();
  }
  await enrichStakeRoomsWithLobbyState();

  const cards = State.stakeRooms.map((room) => {
    const lobby = room.__lobby || {};
    const players = lobby.player_count ?? 0;
    const maxP = lobby.max_players ?? room.max_players;
    const stake = room.stake_amount;
    const cur   = room.currency || 'ETB';
    const prizeMax = (maxP * stake * (room.prize_pct / 100));
    const prizeCur = (players * stake * (room.prize_pct / 100));

    return `
      <div class="room-card" data-room-id="${room.id}">
        <div class="room-head">
          <div class="room-stake">${fmtMoney(stake, cur)}</div>
          <div class="room-count">${players} / ${maxP} players</div>
        </div>
        <div class="room-body">
          <div class="room-prize">
            <span class="label">Prize pool</span>
            <span class="value">${fmtMoney(prizeCur, cur)}</span>
            <span class="hint">up to ${fmtMoney(prizeMax, cur)}</span>
          </div>
          <button class="btn primary join-btn" data-room-id="${room.id}">JOIN</button>
        </div>
      </div>
    `;
  }).join('');

  root.innerHTML = `
    <div class="lobby-greeting">
      <div>
        <div class="hello">Welcome back,</div>
        <div class="name">${escapeHtml(State.profile?.telegram_first_name || 'Player')}</div>
      </div>
      <div class="wallet-chip">
        <span>Balance</span>
        <b>${fmtMoney(State.wallet?.balance ?? 0, State.wallet?.currency || 'ETB')}</b>
      </div>
    </div>

    <h3 class="section-title">Stake Rooms</h3>
    <div class="room-list">${cards || '<div class="empty">No rooms available right now.</div>'}</div>
  `;

  $$('#lobby-view .join-btn').forEach((btn) => {
    btn.addEventListener('click', () => openCardSelection(btn.dataset.roomId));
  });
}


/* ============================================================================
 * CARD SELECTION
 * ==========================================================================*/

async function openCardSelection(stakeRoomId) {
  tgHaptic('medium');
  const room = State.stakeRooms.find((r) => r.id === stakeRoomId);
  if (!room) { showToast('Room not found', 'error'); return; }

  if ((State.wallet?.balance ?? 0) < room.stake_amount) {
    showToast('Insufficient balance', 'error');
    tgNotify('error');
    return;
  }

  const modal = $('#card-modal');
  const title = $('#card-modal-title');
  const grid  = $('#card-grid');
  const status = $('#card-modal-status');
  const confirmBtn = $('#card-confirm');

  modal.classList.add('open');
  title.textContent = `Select your card — ${fmtMoney(room.stake_amount, room.currency)}`;
  grid.innerHTML = '';
  status.textContent = 'Loading available cards…';
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'SELECT A CARD';

  // Fetch fresh lobby data
  let lobbyData;
  try {
    const { data, error } = await sb.rpc('peek_lobby', { p_stake_room_id: stakeRoomId });
    if (error) throw error;
    lobbyData = data;
  } catch (err) {
    status.textContent = 'Unable to load lobby: ' + err.message;
    return;
  }

  const maxP = lobbyData.max_players ?? room.max_players;
  const taken = new Set(lobbyData.taken_cards || []);
  State.takenCards = taken;
  State.availableCards = new Set();
  for (let i = 1; i <= maxP; i++) if (!taken.has(i)) State.availableCards.add(i);

  let selected = null;

  grid.innerHTML = Array.from({ length: maxP }, (_, i) => {
    const num = i + 1;
    const cls = taken.has(num) ? 'taken' : 'free';
    return `<button class="card-num ${cls}" data-num="${num}" ${taken.has(num) ? 'disabled' : ''}>${String(num).padStart(2, '0')}</button>`;
  }).join('');

  status.textContent = `${lobbyData.player_count ?? 0} / ${maxP} players • ${fmtMoney(lobbyData.prize_potential || 0, room.currency)} potential prize`;

  grid.querySelectorAll('.card-num:not(.taken)').forEach((btn) => {
    btn.addEventListener('click', () => {
      grid.querySelectorAll('.card-num.selected').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      selected = Number(btn.dataset.num);
      confirmBtn.disabled = false;
      confirmBtn.textContent = `JOIN WITH CARD ${String(selected).padStart(2, '0')}`;
      tgHaptic('light');
    });
  });

  // Wire the confirm button (replace listener each time)
  const newConfirm = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);

  newConfirm.addEventListener('click', async () => {
    if (!selected) return;
    setBusy(newConfirm, true);
    try {
      await joinStakeRoom(stakeRoomId, selected);
      modal.classList.remove('open');
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Failed to join', 'error');
      tgNotify('error');
      // Reload grid to reflect DB state
      openCardSelection(stakeRoomId);
    } finally {
      setBusy(newConfirm, false);
    }
  });
}

function closeCardSelection() {
  $('#card-modal')?.classList.remove('open');
}


/* ============================================================================
 * JOIN / LEAVE
 * ==========================================================================*/

// In-flight guard so double-tap JOIN cannot fire two RPCs.
let _joining = false;

async function joinStakeRoom(stakeRoomId, cardNumber) {
  if (_joining) return;
  _joining = true;
  try {
    const { data, error } = await sb.rpc('join_stake_room', {
      p_stake_room_id: stakeRoomId,
      p_card_number:   cardNumber,
    });
    if (error) throw new Error(friendlyRpcError(error));

    tgNotify('success');
    await loadWallet();
    renderPlayerHeader();

    // Enter the game view
    await enterGame(data.game_id);
    return data;
  } finally {
    _joining = false;
  }
}

function friendlyRpcError(err) {
  const msg = (err?.message || '').toUpperCase();
  if (msg.includes('INSUFFICIENT_BALANCE'))   return 'Not enough balance for this stake.';
  if (msg.includes('CARD_ALREADY_TAKEN'))     return 'That card was just taken. Pick another.';
  if (msg.includes('ALREADY_IN_GAME'))        return 'You are already in an active game.';
  if (msg.includes('STAKE_ROOM_UNAVAILABLE')) return 'That room is not currently open.';
  if (msg.includes('CARD_NOT_AVAILABLE'))     return 'Card number is no longer available.';
  if (msg.includes('INVALID_CARD_NUMBER'))    return 'Invalid card number.';
  if (msg.includes('ACCOUNT_BLOCKED'))        return 'Your account has been blocked.';
  if (msg.includes('NOT_AUTHENTICATED'))      return 'Please reopen the app.';
  if (msg.includes('CANNOT_LEAVE_AFTER_START')) return 'Cannot leave — game already started.';
  return err?.message || 'Something went wrong.';
}

async function leaveCurrentLobby() {
  const gid = State.currentGame?.id;
  if (!gid) return;
  try {
    await sb.rpc('leave_lobby', { p_game_id: gid });
    showToast('You left the lobby. Stake refunded.', 'success');
    await loadWallet();
    renderPlayerHeader();
    await exitGame();
    switchView('lobby');
  } catch (err) {
    showToast(friendlyRpcError(err), 'error');
  }
}


/* ============================================================================
 * GAME
 * ==========================================================================*/

async function enterGame(gameId) {
  const { data, error } = await sb.rpc('get_game_state', { p_game_id: gameId });
  if (error) throw new Error(friendlyRpcError(error));

  State.gameState   = data;
  State.currentGame = data.game;
  State.myPlayer    = data.me;

  // Force a render even if a previous key happens to match.
  _lastGameRenderKey = '';

  // Route to game view
  switchView('game');
  renderGame();

  // Subscribe to realtime for this game
  await subscribeToGame(gameId);

  // Start the local render loop and distributed engine heartbeat
  startLocalTimers();
}

async function exitGame() {
  _lastGameRenderKey = '';
  await unsubscribeGame();
  stopLocalTimers();
  State.gameState    = null;
  State.currentGame  = null;
  State.myPlayer     = null;
}

async function refreshGameState() {
  const gid = State.currentGame?.id;
  if (!gid) return;
  const { data, error } = await sb.rpc('get_game_state', { p_game_id: gid });
  if (error) { console.warn('[refreshGameState]', error); return; }
  State.gameState   = data;
  State.currentGame = data.game;
  State.myPlayer    = data.me;
  renderGame();
}

// Skip DOM churn when nothing meaningful changed. Prevents the BINGO button
// being replaced mid-tap by a realtime event.
let _lastGameRenderKey = '';

function renderGame() {
  const root = $('#game-view');
  if (!root) return;

  const g = State.currentGame;
  if (!g) {
    _lastGameRenderKey = '';
    root.innerHTML = `<div class="empty">You are not currently in a game.</div>`;
    tgHideMainButton();
    return;
  }

  const renderKey = [
    g.id,
    g.status,
    g.current_number,
    g.is_paused ? 1 : 0,
    g.player_count,
    (State.gameState?.called_numbers || []).length,
    State.gameState?.winner?.id || '',
  ].join('|');

  if (renderKey === _lastGameRenderKey) return;
  _lastGameRenderKey = renderKey;

  const cur = g.currency || 'ETB';
  const me  = State.myPlayer || {};
  const calledSet = new Set((State.gameState?.called_numbers || []).map((c) => c.number));

  // ---- Header block ----
  const headerHtml = `
    <div class="game-header">
      <div class="game-meta">
        <div class="row">
          <span>Game</span><b>#${g.game_number}</b>
        </div>
        <div class="row">
          <span>Players</span><b>${g.player_count} / ${g.max_players}</b>
        </div>
        <div class="row">
          <span>Prize</span><b>${fmtMoney(prizeFromGame(g), cur)}</b>
        </div>
        <div class="row">
          <span>Status</span><b class="status-${g.status}">${g.status}</b>
        </div>
        <div class="row">
          <span>Your card</span><b>${me?.card_number ? String(me.card_number).padStart(2, '0') : '—'}</b>
        </div>
      </div>
    </div>
  `;

  // ---- Body block ----
  let bodyHtml = '';

  if (g.status === 'LOBBY') {
    const secsLeft = computeLobbySeconds(g);
    bodyHtml = `
      <div class="countdown-block">
        <div class="countdown-label">GAME STARTING IN</div>
        <div class="countdown-value" id="lobby-countdown">${fmtTime(secsLeft)}</div>
        <div class="countdown-hint">${g.player_count} / ${g.min_players} min players</div>
      </div>
      <div class="players-block">
        <h4>Players in lobby</h4>
        <div class="players-list">${renderPlayersList()}</div>
      </div>
      <button class="btn danger" id="btn-leave-lobby">LEAVE LOBBY (refund)</button>
    `;
  } else if (g.status === 'STARTING' || g.status === 'ACTIVE') {
    const currentNum = g.current_number ?? 0;
    const currentLetter = g.current_letter || letterFor(currentNum) || '—';
    const nextIn = Math.max(0, Math.ceil(
      (new Date(g.next_call_at || Date.now()).getTime() - Date.now()) / 1000
    ));

    bodyHtml = `
      <div class="current-call">
        <div class="current-label">CURRENT NUMBER</div>
        ${currentNum
          ? `<div class="ball" style="background:${letterColor(currentLetter)}">
               <div class="ball-letter">${currentLetter}</div>
               <div class="ball-number">${currentNum}</div>
             </div>`
          : `<div class="ball placeholder"><div class="ball-number">—</div></div>`}
        <div class="next-label">Next number in <b id="next-call-in">${nextIn}s</b></div>
      </div>

      <div class="called-block">
        <h4>Called numbers (${(State.gameState?.called_numbers || []).length} / 75)</h4>
        <div class="called-list">
          ${(State.gameState?.called_numbers || []).map((c) => `
            <span class="called-chip" style="background:${letterColor(c.letter)}">
              ${c.letter}-${c.number}
            </span>`).join('') || '<span class="muted">No numbers yet.</span>'}
        </div>
      </div>

      <div class="card-block">
        <h4>YOUR CARD ${me?.card_number ? `#${String(me.card_number).padStart(2,'0')}` : ''}</h4>
        ${me?.card_matrix ? renderBingoCard(me.card_matrix, calledSet) : '<div class="muted">No card assigned.</div>'}
      </div>

      <button class="btn bingo-btn" id="btn-bingo">BINGO!</button>
    `;
  } else if (g.status === 'FINISHED' || g.status === 'SETTLED') {
    const winner = State.gameState?.winner;
    const isMe = winner?.user_id === State.profile?.id;
    bodyHtml = `
      <div class="winner-block ${isMe ? 'me' : ''}">
        <div class="winner-emoji">🎉</div>
        <div class="winner-title">${isMe ? 'YOU WON!' : 'WINNER'}</div>
        ${winner ? `
          <div class="winner-line">Card <b>${String(winner.card_number).padStart(2,'0')}</b></div>
          <div class="winner-line">Prize <b>${fmtMoney(winner.prize_amount, cur)}</b></div>
        ` : ''}
        <div class="winner-hint">Returning to lobby shortly…</div>
      </div>
    `;
  } else if (g.status === 'CANCELLED' || g.status === 'REFUNDING') {
    bodyHtml = `
      <div class="cancel-block">
        <div class="winner-emoji">↩️</div>
        <div class="winner-title">GAME CANCELLED</div>
        <div class="winner-hint">${escapeHtml(g.cancel_reason || 'Your stake has been refunded.')}</div>
      </div>
    `;
  }

  root.innerHTML = headerHtml + bodyHtml;

  // ---- Post-render wiring ----
  const leaveBtn = $('#btn-leave-lobby');
  if (leaveBtn) leaveBtn.addEventListener('click', leaveCurrentLobby);

  const bingoBtn = $('#btn-bingo');
  if (bingoBtn) {
    bingoBtn.addEventListener('click', onBingoClaim);
    if (g.status !== 'ACTIVE') bingoBtn.disabled = true;
  }

  // MainButton if inside Telegram
  if (g.status === 'ACTIVE' && TG?.MainButton) {
    tgMainButton('BINGO!', onBingoClaim);
  } else {
    tgHideMainButton();
  }
}

function prizeFromGame(g) {
  if (g.prize_amount && g.prize_amount > 0) return g.prize_amount;
  return Math.round(((g.total_pot || 0) * (g.prize_pct || 90) / 100) * 100) / 100;
}

function renderPlayersList() {
  const players = State.gameState?.players || [];
  if (!players.length) return '<div class="muted">Waiting for players…</div>';
  return players.map((p) => `
    <div class="player-chip ${p.is_me ? 'me' : ''}">
      <div class="pc-avatar" style="${p.photo_url ? `background-image:url('${escapeHtml(p.photo_url)}')` : ''}">
        ${p.photo_url ? '' : escapeHtml((p.display_name || 'P').charAt(0).toUpperCase())}
      </div>
      <div class="pc-name">
        ${escapeHtml(p.display_name || 'Player')}
        ${p.username ? `<span class="pc-handle">@${escapeHtml(p.username)}</span>` : ''}
      </div>
      <div class="pc-card">#${String(p.card_number).padStart(2, '0')}</div>
    </div>
  `).join('');
}

function renderBingoCard(matrix, calledSet) {
  if (!matrix) return '';
  const letters = ['B', 'I', 'N', 'G', 'O'];
  let html = '<div class="bingo-card">';

  // Header
  html += '<div class="bingo-row header">';
  for (const L of letters) {
    html += `<div class="bingo-cell head" style="background:${letterColor(L)}">${L}</div>`;
  }
  html += '</div>';

  // Rows
  for (let r = 0; r < 5; r++) {
    html += '<div class="bingo-row">';
    for (let c = 0; c < 5; c++) {
      const L = letters[c];
      const v = matrix?.[L]?.[r];
      const isCenter = (r === 2 && c === 2);
      const marked = isCenter || (v != null && calledSet.has(v));
      html += `<div class="bingo-cell ${marked ? 'marked' : ''} ${isCenter ? 'free' : ''}">${isCenter ? '★' : (v ?? '')}</div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}


/* ============================================================================
 * BINGO
 * ==========================================================================*/

async function onBingoClaim() {
  const gid = State.currentGame?.id;
  if (!gid) return;
  tgHaptic('heavy');

  // Optimistically lock the button to avoid double-claim spam
  const btn = $('#btn-bingo');
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }

  try {
    const { data, error } = await sb.rpc('claim_bingo', { p_game_id: gid });
    if (error) throw new Error(friendlyRpcError(error));

    if (data?.ok) {
      tgNotify('success');
      showToast('BINGO confirmed! 🎉', 'success');
    } else if (data?.already_settled) {
      showToast('Winner already confirmed for this game.', 'info');
    } else {
      tgNotify('error');
      showToast(data?.message || 'Invalid bingo.', 'error');
    }
    // Always resync — the DB is the source of truth
    await refreshGameState();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Bingo check failed.', 'error');
  } finally {
    // Only re-enable if the node is still in the DOM (i.e. not re-rendered).
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }
}


/* ============================================================================
 * REALTIME
 * ==========================================================================*/

let _subErrors = 0;

async function subscribeToGame(gameId) {
  // Drop any previous subscription
  await unsubscribeGame();

  _subErrors = 0;
  const channelName = `game:${gameId}`;
  const channel = sb.channel(channelName, {
    config: { broadcast: { self: true } },
  });

  // Games row (status, current number, countdown, winner)
  channel.on('postgres_changes',
    { event: '*', schema: 'public', table: 'games', filter: `id=eq.${gameId}` },
    (payload) => {
      if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
        const row = payload.new;
        State.currentGame = { ...(State.currentGame || {}), ...row };
        renderGame();
        maybeHandleStatusTransition(row.status);
      }
    }
  );

  // Player joins/leaves/card updates
  channel.on('postgres_changes',
    { event: '*', schema: 'public', table: 'game_players', filter: `game_id=eq.${gameId}` },
    () => {
      debouncedRefresh(250);
    }
  );

  // Called numbers
  channel.on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'called_numbers', filter: `game_id=eq.${gameId}` },
    (payload) => {
      const row = payload.new;
      if (!State.gameState) State.gameState = { called_numbers: [] };
      if (!State.gameState.called_numbers) State.gameState.called_numbers = [];
      State.gameState.called_numbers.push({
        number: row.number, letter: row.letter, sequence: row.sequence, called_at: row.called_at,
      });
      if (State.currentGame) {
        State.currentGame.current_number = row.number;
        State.currentGame.current_letter = row.letter;
        State.currentGame.current_sequence = row.sequence;
      }
      tgHaptic('soft');
      renderGame();
    }
  );

  // Winner row
  channel.on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'game_winners', filter: `game_id=eq.${gameId}` },
    (payload) => {
      if (!State.gameState) State.gameState = {};
      State.gameState.winner = payload.new;
      renderGame();
    }
  );

  // Game events (rich audit trail for UI animations)
  channel.on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'game_events', filter: `game_id=eq.${gameId}` },
    (payload) => {
      const ev = payload.new;
      if (ev.event === 'PLAYER_JOINED' || ev.event === 'CARD_SELECTED' || ev.event === 'PLAYER_LEFT') {
        debouncedRefresh(400);
      }
      if (ev.event === 'GAME_STARTED' || ev.event === 'GAME_FINISHED') {
        debouncedRefresh(150);
      }
    }
  );

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      _subErrors = 0;
      console.info('[realtime] subscribed', channelName);
      return;
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      _subErrors++;
      console.warn('[realtime] issue', status, `attempt ${_subErrors}`);
      if (_subErrors <= APP.maxRealtimeErrors) {
        const delay = Math.min(30_000, 1500 * 2 ** (_subErrors - 1));
        setTimeout(refreshGameState, delay);
      } else {
        console.warn('[realtime] giving up after', APP.maxRealtimeErrors, 'consecutive errors');
      }
    }
  });

  State.channel = channel;
  State.channelGameId = gameId;
}

async function unsubscribeGame() {
  const ch = State.channel;
  State.channel = null;
  State.channelGameId = null;
  await removeChannelSafe(ch);
}

// Coalesce rapid refreshes
let _refreshTimer = null;
function debouncedRefresh(ms = 300) {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(refreshGameState, ms);
}


/* ============================================================================
 * LOCAL TIMERS (display only) + ENGINE HEARTBEAT
 * ==========================================================================*/

function startLocalTimers() {
  stopLocalTimers();

  // 1 Hz local render of countdowns
  State.renderTimer = setInterval(() => {
    tickRender();
  }, APP.heartbeatMs);

  // Distributed engine heartbeat — safe because tick_games() is server-timed
  // and idempotent. The RPC is a no-op if pg_cron already ran the tick.
  State.engineTimer = setInterval(() => {
    const g = State.currentGame;
    if (!g) return;
    if (g.status === 'ACTIVE' || g.status === 'LOBBY' || g.status === 'STARTING') {
      sb.rpc('tick_games').then(() => {}, () => {});
    }
  }, APP.engineTickMs);
}

function stopLocalTimers() {
  clearInterval(State.renderTimer);
  clearInterval(State.engineTimer);
  State.renderTimer = null;
  State.engineTimer = null;
}

function tickRender() {
  const g = State.currentGame;
  if (!g) return;

  if (g.status === 'LOBBY') {
    const el = $('#lobby-countdown');
    if (el) el.textContent = fmtTime(computeLobbySeconds(g));
  } else if (g.status === 'ACTIVE' || g.status === 'STARTING') {
    const el = $('#next-call-in');
    if (el && g.next_call_at) {
      const secs = Math.max(0, Math.ceil((new Date(g.next_call_at).getTime() - Date.now()) / 1000));
      el.textContent = `${secs}s`;
    }
  }

  // Auto-return to lobby 5s after FINISHED / SETTLED / CANCELLED
  if (g.status === 'FINISHED' || g.status === 'SETTLED' || g.status === 'CANCELLED') {
    if (!g.__returnAt) {
      g.__returnAt = Date.now() + APP.winnerLobbyDelay;
    } else if (Date.now() >= g.__returnAt) {
      autoReturnToLobby().catch((e) => console.warn('[autoReturnToLobby]', e));
    }
  }
}

// Always derive from lobby_ends_at (server-truth) so the countdown updates
// smoothly. `seconds_left` from get_game_state is only a snapshot.
function computeLobbySeconds(g) {
  if (g.lobby_ends_at) {
    return Math.max(0, Math.floor((new Date(g.lobby_ends_at).getTime() - Date.now()) / 1000));
  }
  const s = State.gameState?.game?.seconds_left;
  return typeof s === 'number' && s >= 0 ? s : 0;
}

let _handledStatuses = new Set();
function maybeHandleStatusTransition(status) {
  const gid = State.currentGame?.id;
  if (!gid) return;
  const key = `${gid}:${status}`;
  if (_handledStatuses.has(key)) return;
  _handledStatuses.add(key);

  if (status === 'CANCELLED') {
    showToast('Game cancelled — stake refunded.', 'info');
    loadWallet().then(renderPlayerHeader);
  }
  if (status === 'ACTIVE') {
    tgNotify('success');
    showToast('Game started!', 'success');
  }
  if (status === 'FINISHED' || status === 'SETTLED') {
    loadWallet().then(renderPlayerHeader);
  }
}

async function autoReturnToLobby() {
  await exitGame();
  _handledStatuses.clear();
  await loadWallet();
  renderPlayerHeader();
  await loadStakeRooms();
  switchView('lobby');
}


/* ============================================================================
 * WALLET
 * ==========================================================================*/

async function renderWallet() {
  const root = $('#wallet-view');
  if (!root) return;

  const uid = State.profile?.id;
  if (!uid) { root.innerHTML = '<div class="empty">Not signed in.</div>'; return; }

  await loadWallet();
  const { data: txs } = await sb
    .from('wallet_transactions')
    .select('*')
    .eq('user_id', uid)
    .order('created_at', { ascending: false })
    .limit(100);

  State.transactions = txs || [];
  const cur = State.wallet?.currency || 'ETB';

  root.innerHTML = `
    <div class="wallet-hero">
      <div class="wallet-label">Balance</div>
      <div class="wallet-value">${fmtMoney(State.wallet?.balance ?? 0, cur)}</div>
    </div>

    <div class="wallet-actions">
      <button class="btn primary" id="btn-deposit">Deposit</button>
      <button class="btn ghost"   id="btn-withdraw">Withdraw</button>
    </div>

    <h3 class="section-title">Transactions</h3>
    <div class="tx-list">
      ${State.transactions.length ? State.transactions.map((t) => `
        <div class="tx-row">
          <div class="tx-left">
            <div class="tx-type tx-${t.type.toLowerCase()}">${t.type}</div>
            <div class="tx-date">${fmtDateTime(t.created_at)}</div>
            ${t.note ? `<div class="tx-note">${escapeHtml(t.note)}</div>` : ''}
          </div>
          <div class="tx-right ${t.amount >= 0 ? 'pos' : 'neg'}">
            ${t.amount >= 0 ? '+' : ''}${fmtMoney(t.amount, t.currency || cur)}
            <div class="tx-bal">${fmtMoney(t.balance_after, t.currency || cur)}</div>
          </div>
        </div>
      `).join('') : '<div class="empty">No transactions yet.</div>'}
    </div>
  `;

  $('#btn-deposit')?.addEventListener('click', onDeposit);
  $('#btn-withdraw')?.addEventListener('click', onWithdraw);
}

async function onDeposit() {
  const raw = prompt('Deposit amount (ETB):');
  if (!raw) return;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) { showToast('Invalid amount', 'error'); return; }
  try {
    const { data, error } = await sb.rpc('request_deposit', { p_amount: amount, p_reference: null });
    if (error) throw error;
    showToast('Deposit request submitted. Awaiting approval.', 'success');
  } catch (err) {
    showToast(err.message || 'Deposit failed', 'error');
  }
}

async function onWithdraw() {
  const raw = prompt('Withdraw amount (ETB):');
  if (!raw) return;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) { showToast('Invalid amount', 'error'); return; }
  const destination = prompt('Destination (Telegram username / phone):') || null;
  try {
    const { data, error } = await sb.rpc('request_withdrawal', { p_amount: amount, p_destination: destination });
    if (error) throw error;
    showToast('Withdrawal requested.', 'success');
    await loadWallet();
    renderWallet();
    renderPlayerHeader();
  } catch (err) {
    showToast(friendlyRpcError(err), 'error');
  }
}


/* ============================================================================
 * HISTORY
 * ==========================================================================*/

async function renderHistory() {
  const root = $('#history-view');
  if (!root) return;

  const uid = State.profile?.id;
  if (!uid) { root.innerHTML = '<div class="empty">Not signed in.</div>'; return; }

  const { data, error } = await sb
    .from('game_players')
    .select(`
      id, card_number, stake_amount, status, joined_at,
      games:game_id ( id, game_number, status, winner_user_id, winner_card_number, prize_amount, currency, settled_at, stake_room_id )
    `)
    .eq('user_id', uid)
    .order('joined_at', { ascending: false })
    .limit(100);

  if (error) {
    root.innerHTML = `<div class="empty">Failed to load history: ${escapeHtml(error.message)}</div>`;
    return;
  }

  State.history = data || [];

  const filter = root.dataset.filter || 'ALL';
  const filtered = State.history.filter((row) => {
    if (filter === 'ALL') return true;
    const won = row.status === 'WON' || row.games?.winner_user_id === uid;
    if (filter === 'WINS') return won;
    if (filter === 'LOSSES') return !won && (row.status === 'LOST' || row.status === 'REFUNDED');
    return true;
  });

  root.innerHTML = `
    <div class="history-filters">
      <button class="chip ${filter === 'ALL' ? 'active' : ''}"    data-filter="ALL">All</button>
      <button class="chip ${filter === 'WINS' ? 'active' : ''}"   data-filter="WINS">Wins</button>
      <button class="chip ${filter === 'LOSSES' ? 'active' : ''}" data-filter="LOSSES">Losses</button>
    </div>

    <div class="history-list">
      ${filtered.length ? filtered.map((row) => {
        const g = row.games || {};
        const won = row.status === 'WON' || g.winner_user_id === uid;
        const cur = g.currency || 'ETB';
        const prize = won ? (g.prize_amount || 0) : 0;
        const resultLabel = won ? 'WIN' :
                            row.status === 'REFUNDED' ? 'REFUND' :
                            row.status === 'LEFT'     ? 'LEFT'   : 'LOSS';
        const resultCls = won ? 'win' : (resultLabel === 'LOSS' ? 'loss' : 'neutral');
        return `
          <div class="history-row">
            <div class="history-main">
              <div class="history-title">Game #${g.game_number ?? '—'}</div>
              <div class="history-sub">Card ${String(row.card_number).padStart(2,'0')} • ${fmtDateTime(g.settled_at || row.joined_at)}</div>
            </div>
            <div class="history-result">
              <div class="result-badge ${resultCls}">${resultLabel}</div>
              <div class="history-amounts">
                Stake ${fmtMoney(row.stake_amount, cur)}
                ${won ? `<br/>Prize ${fmtMoney(prize, cur)}` : ''}
              </div>
            </div>
          </div>
        `;
      }).join('') : '<div class="empty">No games yet.</div>'}
    </div>
  `;

  root.querySelectorAll('.history-filters .chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      root.dataset.filter = btn.dataset.filter;
      renderHistory();
    });
  });
}


/* ============================================================================
 * PAYMENTS (integration surface for future providers)
 * ==========================================================================*/

const Payments = {
  async initiateDeposit(amount, method = 'TELEGRAM') {
    const { data, error } = await sb.rpc('request_deposit', { p_amount: amount, p_reference: method });
    if (error) throw error;
    return data;
  },
  async initiateWithdrawal(amount, destination) {
    const { data, error } = await sb.rpc('request_withdrawal', { p_amount: amount, p_destination: destination });
    if (error) throw error;
    return data;
  },
};


/* ============================================================================
 * NOTIFICATIONS
 * ==========================================================================*/

async function loadNotifications() {
  const uid = State.profile?.id;
  if (!uid) return [];
  const { data, error } = await sb
    .from('notifications')
    .select('*')
    .eq('user_id', uid)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) return [];
  State.notifications = data || [];
  renderNotificationBadge();
  return State.notifications;
}

function renderNotificationBadge() {
  const unread = State.notifications.filter((n) => !n.is_read).length;
  const badge = $('#notif-badge');
  if (!badge) return;
  if (unread > 0) {
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.add('show');
  } else {
    badge.classList.remove('show');
  }
}

async function subscribeToNotifications() {
  const uid = State.profile?.id;
  if (!uid) return;
  await unsubscribeNotifications();

  State.notifChannel = sb.channel(`notifs:${uid}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` },
      (payload) => {
        State.notifications.unshift(payload.new);
        renderNotificationBadge();
        showToast(payload.new.title, 'info');
      })
    .subscribe();
}

async function unsubscribeNotifications() {
  const ch = State.notifChannel;
  State.notifChannel = null;
  await removeChannelSafe(ch);
}


/* ============================================================================
 * ADMIN
 * ==========================================================================*/

const Admin = {
  async login(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    State.session = data.session;
    await loadProfile();
    if (!State.profile) throw new Error('Profile missing for this account.');
    return State.profile;
  },

  async signOut() { return signOut(); },

  // ---- Stake rooms ----
  async listStakeRooms() {
    const { data, error } = await sb.from('stake_rooms').select('*').order('sort_order');
    if (error) throw error;
    return data || [];
  },

  async upsertStakeRoom(payload) {
    const { data, error } = await sb.rpc('admin_upsert_stake_room', { p_payload: payload });
    if (error) throw error;
    return data;
  },

  async toggleStakeRoom(id, active) {
    const { data, error } = await sb.rpc('admin_toggle_stake_room', { p_id: id, p_active: active });
    if (error) throw error;
    return data;
  },

  // ---- Live games ----
  async listLiveGames() {
    const { data, error } = await sb.rpc('admin_live_games');
    if (error) throw error;
    State.adminLiveGames = data || [];
    return State.adminLiveGames;
  },

  async gameDetail(gameId) {
    const { data, error } = await sb.rpc('admin_game_detail', { p_game_id: gameId });
    if (error) throw error;
    return data;
  },

  async controlGame(gameId, action) {
    const { data, error } = await sb.rpc('admin_game_control', { p_game_id: gameId, p_action: action });
    if (error) throw error;
    return data;
  },

  // ---- Wallet ----
  async adjustBalance(userId, amount, note) {
    const { data, error } = await sb.rpc('admin_adjust_balance', {
      p_user_id: userId, p_amount: amount, p_note: note,
    });
    if (error) throw error;
    return data;
  },

  async approveDeposit(depositId, approve) {
    const { data, error } = await sb.rpc('admin_approve_deposit', {
      p_deposit_id: depositId, p_approve: approve,
    });
    if (error) throw error;
    return data;
  },

  async listDeposits(status = 'PENDING') {
    let q = sb.from('deposits').select('*, profiles:user_id(telegram_first_name, telegram_username, telegram_id)').order('created_at', { ascending: false }).limit(200);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async listWithdrawals(status = 'PENDING') {
    let q = sb.from('withdrawals').select('*, profiles:user_id(telegram_first_name, telegram_username, telegram_id)').order('created_at', { ascending: false }).limit(200);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async listPlayers(search = '') {
    let q = sb.from('profiles').select('*').order('last_seen', { ascending: false }).limit(200);
    if (search) q = q.or(`telegram_username.ilike.%${search}%,telegram_first_name.ilike.%${search}%`);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async listAuditLogs() {
    const { data, error } = await sb.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    return data || [];
  },
};


/* ============================================================================
 * MARKETING (stub — real campaigns live in admin.html / a future service)
 * ==========================================================================*/

const Marketing = {
  async broadcast(title, body) {
    console.info('[Marketing.broadcast]', title, body);
  },
};


/* ============================================================================
 * INIT
 * ==========================================================================*/

async function bootPlayerApp() {
  tgInit();
  sbInit();

  // Wire bottom navigation
  $$('.nav-item').forEach((el) => {
    el.addEventListener('click', () => switchView(el.dataset.nav));
  });

  // Wire card modal close
  $('#card-modal-close')?.addEventListener('click', closeCardSelection);
  $('#card-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCardSelection();
  });

  // Wire global toast helper for CSS default
  const toastEl = $('#toast');
  if (toastEl) toastEl.className = 'toast';

  // Auth + initial data
  try {
    await authenticate();
  } catch (err) {
    console.error('[auth]', err);
    showToast('Authentication failed: ' + err.message, 'error', 8000);
    return;
  }

  if (!State.profile) {
    showToast('Profile not ready. Try reopening the app.', 'error');
    return;
  }

  // Header + initial data
  await Promise.all([loadWallet(), loadStakeRooms()]);
  renderPlayerHeader();

  // Default view
  switchView('lobby');

  // Notifications
  await loadNotifications();
  subscribeToNotifications();

  // If a game is already running for this user, jump straight into it
  try {
    const { data: live } = await sb
      .from('game_players')
      .select('game_id, games:game_id(status)')
      .eq('user_id', State.profile.id)
      .in('status', ['JOINED', 'PLAYING'])
      .order('joined_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (live?.game_id && live.games && ['LOBBY','STARTING','ACTIVE'].includes(live.games.status)) {
      await enterGame(live.game_id);
    }
  } catch (e) { /* no active game — fine */ }

  // Session refresh on visibility change (Telegram re-open)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadWallet().then(renderPlayerHeader);
      if (State.currentGame?.id) refreshGameState();
    }
  });

  State.booted = true;
}

function bootAdminApp() {
  sbInit();
  // admin.html drives its own login + rendering by calling Admin.* functions.
  // We only initialise the client and expose the namespace.
}

// ---------------------------------------------------------------------------
// Global wiring — expose the API surface to inline handlers in HTML files.
// ---------------------------------------------------------------------------

window.BingoApp = {
  // Player
  State, APP, Admin, Marketing, Payments,
  switchView, leaveCurrentLobby, onBingoClaim,
  loadStakeRooms, renderLobby, renderWallet, renderProfile, renderHistory,
  openCardSelection, closeCardSelection, joinStakeRoom,
  refreshGameState, enterGame, exitGame,
  // Realtime cleanup (useful for admin.html and for sign-out flows)
  unsubscribeGame, unsubscribeNotifications,
  // Utility
  showToast, fmtMoney, fmtTime, fmtDateTime,
  sb: () => sb,
  TG, IS_TELEGRAM, IS_ADMIN_MODE,
};

// Auto-boot based on mode signalled by the host HTML
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (IS_ADMIN_MODE) bootAdminApp();
    else               bootPlayerApp();
  });
} else {
  if (IS_ADMIN_MODE) bootAdminApp();
  else               bootPlayerApp();
}
