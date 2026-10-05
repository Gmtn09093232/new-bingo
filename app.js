/* =============================================================================
 *  app.js  —  Bingo Platform shared JavaScript
 *  Loaded by BOTH index.html (player) and admin.html (control center).
 *  Detects the current page at boot and runs the correct module.
 * =============================================================================
 *  Sections:
 *    1.  SUPABASE CONFIGURATION
 *    2.  GLOBAL STATE
 *    3.  UI UTILITIES
 *    4.  AUTHENTICATION
 *    5.  PLAYER SYSTEM          (window.App)
 *    6.  BINGO SYSTEM
 *    7.  REALTIME
 *    8.  WALLET / PAYMENT
 *    9.  REFERRAL SYSTEM
 *   10.  MARKETING
 *   11.  NOTIFICATIONS
 *   12.  ADMIN SYSTEM           (window.Admin)
 *   13.  USER MANAGEMENT
 *   14.  GAME MANAGEMENT
 *   15.  BINGO CALLER
 *   16.  FINANCE
 *   17.  REPORTS
 *   18.  BOOT
 * ============================================================================ */

(function () {
'use strict';

/* =============================================================================
 * 1. SUPABASE CONFIGURATION
 * ============================================================================= */

const SUPABASE_URL      = 'https://jmszgqtfserjqxpvjksr.supabase.co';       // <-- replace
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imptc3pncXRmc2VyanF4cHZqa3NyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExODE1MTEsImV4cCI6MjEwNjc1NzUxMX0.r1sa6u2n2aTTrtiF5980sPCB6E9HsxEBGTZPfzHPCPo';   // <-- replace

if (!window.supabase || !window.supabase.createClient) {
    console.error('[app.js] Supabase library failed to load.');
    return;
}

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    realtime: { params: { eventsPerSecond: 12 } }
});

const PAGE = document.getElementById('adminApp') ? 'admin' : 'player';

/* =============================================================================
 * 2. GLOBAL STATE
 * ============================================================================= */

const STATE = {
    user: null,
    profile: null,
    wallet: null,
    roles: [],
    // game room
    currentGame: null,
    currentCard: null,
    calledNumbers: [],          // ordered list
    calledSet: new Set(),
    allGames: [],
    // realtime
    channels: {},
    reconnectTimer: null,
    // admin
    adminGames: [],
    adminGameFilter: { search: '', status: '' },
    adminUsers: [],
    adminUsersPage: 0,
    adminUsersPageSize: 25,
    adminUsersTotal: 0,
    adminUsersSearch: '',
    adminDepositFilter: 'pending',
    adminWithdrawFilter: 'pending',
    adminTxFilter: { search: '', type: '' },
    adminAuditFilter: { search: '', action: '' },
    callerGameId: null,
    callerTimer: null,
    charts: {},
    settings: {}
};

/* =============================================================================
 * 3. UI UTILITIES
 * ============================================================================= */

const U = {

    /* ---- toast ---- */
    toast(title, message, type = 'info', ms = 4200) {
        const box = document.getElementById('toastContainer');
        if (!box) return;
        const icons = { success: '✅', error: '⚠️', info: 'ℹ️', warning: '⚡' };
        const el = document.createElement('div');
        el.className = 'toast ' + type;
        el.innerHTML = `
            <span class="ti">${icons[type] || icons.info}</span>
            <div class="toast-body">
                <b>${U.esc(title)}</b>
                ${message ? `<p>${U.esc(message)}</p>` : ''}
            </div>`;
        box.appendChild(el);
        setTimeout(() => {
            el.classList.add('out');
            setTimeout(() => el.remove(), 320);
        }, ms);
    },

    /* ---- escape for HTML text ---- */
    esc(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    /* ---- amount ---- */
    money(v, withCurrency = true) {
        const n = Number(v || 0);
        const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return withCurrency ? s + ' ETB' : s;
    },
    num(v) { return Number(v || 0).toLocaleString('en-US'); },

    /* ---- date ---- */
    date(d) {
        if (!d) return '—';
        const x = new Date(d);
        if (isNaN(x)) return '—';
        return x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    },
    time(d) {
        if (!d) return '—';
        const x = new Date(d);
        if (isNaN(x)) return '—';
        return x.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    },
    dateTime(d) { return U.date(d) + ' · ' + U.time(d); },

    /* ---- relative time ---- */
    ago(d) {
        if (!d) return '—';
        const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
        if (s < 60)   return 'just now';
        if (s < 3600) return Math.floor(s / 60) + ' min ago';
        if (s < 86400) return Math.floor(s / 3600) + ' h ago';
        if (s < 604800) return Math.floor(s / 86400) + ' d ago';
        return U.date(d);
    },

    /* ---- pattern / status labels ---- */
    patternLabel(p) {
        return ({
            single_line: 'Single Line',
            two_lines: 'Two Lines',
            three_lines: 'Three Lines',
            four_corners: 'Four Corners',
            x: 'X Pattern',
            cross: 'Cross',
            full_house: 'Full House',
            custom: 'Custom'
        })[p] || p;
    },
    statusLabel(s) {
        return ({
            scheduled: 'Scheduled', open: 'Open', active: 'Live', paused: 'Paused',
            completed: 'Completed', cancelled: 'Cancelled',
            pending: 'Pending', processing: 'Processing', failed: 'Failed',
            rejected: 'Rejected', approved: 'Approved',
            joined: 'Joined', won: 'Won', lost: 'Lost', refunded: 'Refunded',
            active_account: 'Active', suspended: 'Suspended', banned: 'Banned'
        })[s] || s;
    },
    statusClass(s) {
        return ({
            scheduled: 'status-scheduled', open: 'status-open', active: 'status-active',
            paused: 'status-paused', completed: 'status-completed', cancelled: 'status-cancelled',
            pending: 'pill-yellow', processing: 'pill-blue', failed: 'pill-red',
            rejected: 'pill-red', completed_tx: 'pill-green',
            won: 'pill-green', lost: 'pill-grey', refunded: 'pill-blue',
            active_account: 'status-open', suspended: 'status-paused', banned: 'status-cancelled'
        })[s] || 'pill-grey';
    },

    /* ---- letter for number ---- */
    letterFor(n) {
        if (n <= 15) return 'B';
        if (n <= 30) return 'I';
        if (n <= 45) return 'N';
        if (n <= 60) return 'G';
        return 'O';
    },
    letterClass(l) {
        return ({ B: 'b', I: 'i', N: 'n', G: 'g', O: 'o' })[l] || 'b';
    },

    /* ---- modal ---- */
    modal(html, wide = false) {
        const overlay = document.getElementById('modalOverlay');
        const content = document.getElementById('modalContent');
        if (!overlay || !content) return;
        content.className = 'modal' + (wide ? ' wide' : '');
        content.innerHTML = html;
        overlay.classList.add('show');
    },
    closeModal() {
        const overlay = document.getElementById('modalOverlay');
        if (overlay) overlay.classList.remove('show');
    },

    /* ---- inline error alert ---- */
    showError(elId, msg) {
        const el = document.getElementById(elId);
        if (!el) return;
        const m = el.querySelector('.msg');
        if (m) m.textContent = msg;
        el.classList.add('show');
        setTimeout(() => el.classList.remove('show'), 7000);
    },
    showSuccess(elId, msg) {
        const el = document.getElementById(elId);
        if (!el) return;
        const m = el.querySelector('.msg');
        if (m) m.textContent = msg;
        el.classList.add('show');
    },
    hideAlert(elId) {
        const el = document.getElementById(elId);
        if (el) el.classList.remove('show');
    },

    /* ---- button loading state ---- */
    loading(btnId, on, originalText) {
        const b = document.getElementById(btnId);
        if (!b) return;
        if (on) {
            b.dataset.originalText = b.innerHTML;
            b.disabled = true;
            b.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span> Please wait…';
        } else {
            b.disabled = false;
            b.innerHTML = b.dataset.originalText || originalText || 'Submit';
        }
    },

    /* ---- debounce ---- */
    debounce(fn, ms) {
        let t;
        return function (...args) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), ms);
        };
    },

    /* ---- empty state ---- */
    empty(icon, title, sub) {
        return `<div class="empty-state" style="padding:36px 16px">
            <div class="icon" style="font-size:2.4rem;opacity:.55">${icon}</div>
            <h4 style="font-size:1rem;font-weight:800;color:var(--text-2);margin-bottom:4px">${U.esc(title)}</h4>
            <p style="font-size:.83rem">${U.esc(sub || '')}</p>
        </div>`;
    },
    emptyRow(cols, icon, title, sub) {
        return `<tr><td colspan="${cols}" style="padding:0">${U.empty(icon, title, sub)}</td></tr>`;
    },

    /* ---- theming ---- */
    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem('bingo_theme', theme); } catch (e) {}
        const btn = document.getElementById('themeToggle');
        if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
        if (window.Chart) {
            Object.values(STATE.charts).forEach(c => {
                try {
                    c.options.plugins.legend.labels.color = theme === 'dark' ? '#b4b4d4' : '#3a3a60';
                    c.options.scales.x.ticks.color        = theme === 'dark' ? '#7878a4' : '#71719a';
                    c.options.scales.y.ticks.color        = theme === 'dark' ? '#7878a4' : '#71719a';
                    c.options.scales.x.grid.color         = theme === 'dark' ? 'rgba(255,255,255,.05)' : 'rgba(15,15,45,.06)';
                    c.options.scales.y.grid.color         = theme === 'dark' ? 'rgba(255,255,255,.05)' : 'rgba(15,15,45,.06)';
                    c.update('none');
                } catch (e) {}
            });
        }
    },
    toggleTheme() {
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        U.applyTheme(cur === 'dark' ? 'light' : 'dark');
    },

    /* ---- avatar initials ---- */
    initials(name) {
        if (!name) return '?';
        const p = String(name).trim().split(/\s+/);
        return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
    },

    /* ---- random id ---- */
    uid() { return 'x' + Math.random().toString(36).slice(2, 10); }
};

/* =============================================================================
 * 4. AUTHENTICATION  (shared helpers)
 * ============================================================================= */

const Auth = {

    async getUser() {
        const { data } = await sb.auth.getUser();
        return data?.user || null;
    },

    async getSession() {
        const { data } = await sb.auth.getSession();
        return data?.session || null;
    },

    async fetchProfile(userId) {
        const { data, error } = await sb.from('profiles')
            .select('*').eq('id', userId).maybeSingle();
        if (error) { console.warn('[profile]', error.message); return null; }
        return data;
    },

    async fetchWallet(userId) {
        const { data, error } = await sb.from('wallets')
            .select('*').eq('user_id', userId).maybeSingle();
        if (error) { console.warn('[wallet]', error.message); return null; }
        return data;
    },

    async fetchRoles(userId) {
        const { data, error } = await sb.from('user_roles')
            .select('roles(code, name, is_staff)').eq('user_id', userId);
        if (error) { console.warn('[roles]', error.message); return []; }
        return (data || []).map(r => r.roles).filter(Boolean);
    },

    hasRole(code) { return STATE.roles.some(r => r.code === code); },
    isStaff()    { return STATE.roles.some(r => r.is_staff); },
    isAdmin()    { return Auth.hasRole('SUPER_ADMIN') || Auth.hasRole('ADMIN'); },
    isFinance()  { return Auth.isAdmin() || Auth.hasRole('FINANCE_MANAGER'); },
    isGameMgr()  { return Auth.isAdmin() || Auth.hasRole('GAME_MANAGER'); },
    isMarketing(){ return Auth.isAdmin() || Auth.hasRole('MARKETING_MANAGER'); },

    async hydrate(user) {
        STATE.user    = user;
        if (!user) { STATE.profile = null; STATE.wallet = null; STATE.roles = []; return; }
        const [p, w, r] = await Promise.all([
            Auth.fetchProfile(user.id),
            Auth.fetchWallet(user.id),
            Auth.fetchRoles(user.id)
        ]);
        STATE.profile = p;
        STATE.wallet  = w;
        STATE.roles   = r || [];
    },

    async logout() {
        try { await sb.auth.signOut(); } catch (e) {}
        STATE.user = null; STATE.profile = null; STATE.wallet = null; STATE.roles = [];
        Object.values(STATE.channels).forEach(ch => { try { sb.removeChannel(ch); } catch (e) {} });
        STATE.channels = {};
    }
};

/* =============================================================================
 * 5. PLAYER SYSTEM  —  window.App
 * ============================================================================= */

const App = {

    /* ------------------------------------------------------------------ */
    /* Navigation                                                          */
    /* ------------------------------------------------------------------ */
    go(page, opts) {
        // Player pages
        const ALLOWED = ['home','login','register','dashboard','games','bingo',
                         'wallet','promotions','winners','referrals','profile'];
        if (!ALLOWED.includes(page)) page = 'home';

        // Auth-gated
        const AUTH_PAGES = ['dashboard','wallet','referrals','profile','bingo'];
        if (AUTH_PAGES.includes(page) && !STATE.user) {
            U.toast('Please sign in', 'You need an account to continue.', 'warning');
            page = 'login';
        }

        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const el = document.getElementById('page-' + page);
        if (el) el.classList.add('active');

        document.querySelectorAll('.nav-link').forEach(a => {
            a.classList.toggle('active', a.dataset.nav === page);
        });

        // Close mobile menu
        document.getElementById('navLinks')?.classList.remove('open');
        document.querySelector('.hamburger')?.classList.remove('open');

        // scroll to top
        window.scrollTo({ top: 0, behavior: 'smooth' });

        // Leaving the game room?
        if (page !== 'bingo' && STATE.channels.game) {
            try { sb.removeChannel(STATE.channels.game); } catch (e) {}
            delete STATE.channels.game;
        }

        // Lazy loaders
        switch (page) {
            case 'home':       App.loadHome(); break;
            case 'dashboard':  App.loadDashboard(); break;
            case 'games':      App.loadGames(); break;
            case 'wallet':     App.loadWallet(); break;
            case 'promotions': App.loadPromotions(); break;
            case 'winners':    App.loadWinners(); break;
            case 'referrals':  App.loadReferrals(); break;
            case 'profile':    App.loadProfile(); break;
        }
    },

    toggleMenu(btn) {
        document.getElementById('navLinks')?.classList.toggle('open');
        btn?.querySelector('.hamburger')?.classList.toggle('open');
    },

    toggleTheme() { U.toggleTheme(); },

    togglePassword(inputId, btn) {
        const el = document.getElementById(inputId);
        if (!el) return;
        const show = el.type === 'password';
        el.type = show ? 'text' : 'password';
        if (btn) btn.textContent = show ? '🙈' : '👁️';
    },

    showModal(title, bodyHtml, actionsHtml) {
        U.modal(`
            <h3>${U.esc(title)}</h3>
            <div style="font-size:.88rem;color:var(--text-2);line-height:1.65;margin:14px 0 6px">${bodyHtml}</div>
            ${actionsHtml
                ? `<div class="modal-actions">${actionsHtml}</div>`
                : `<div class="modal-actions"><button class="btn btn-primary btn-block" onclick="App.closeModal()">Close</button></div>`}
        `);
    },
    closeModal() { U.closeModal(); },

    /* ------------------------------------------------------------------ */
    /* AUTH                                                                */
    /* ------------------------------------------------------------------ */
    async submitLogin(e) {
        e.preventDefault();
        U.hideAlert('loginError');
        U.loading('loginBtn', true);

        const email    = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value;

        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        U.loading('loginBtn', false);

        if (error) {
            U.showError('loginError', error.message);
            return;
        }
        await Auth.hydrate(data.user);

        // Suspended / banned
        if (STATE.profile && ['suspended','banned'].includes(STATE.profile.status)) {
            U.toast('Account ' + STATE.profile.status,
                    'Your account has been ' + STATE.profile.status + '. Contact support.',
                    'error', 6000);
            await Auth.logout();
            return;
        }

        U.toast('Welcome back!', 'Signed in as ' + (STATE.profile?.username || 'player'), 'success');
        App.refreshAuthUI();
        App.startRealtimeNotifications();
        App.go('dashboard');
    },

    async submitRegister(e) {
        e.preventDefault();
        U.hideAlert('registerError');
        U.hideAlert('registerSuccess');

        const fullName = document.getElementById('regFullName').value.trim();
        const username = document.getElementById('regUsername').value.trim();
        const email    = document.getElementById('regEmail').value.trim();
        const phone    = document.getElementById('regPhone').value.trim();
        const pass     = document.getElementById('regPassword').value;
        const pass2    = document.getElementById('regPasswordConfirm').value;
        const ref      = document.getElementById('regReferral').value.trim().toUpperCase();

        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
            return U.showError('registerError', 'Username must be 3–20 characters (letters, numbers, underscore).');
        }
        if (pass.length < 8) {
            return U.showError('registerError', 'Password must be at least 8 characters.');
        }
        if (pass !== pass2) {
            return U.showError('registerError', 'Passwords do not match.');
        }

        U.loading('registerBtn', true);

        const { data, error } = await sb.auth.signUp({
            email,
            password: pass,
            options: {
                data: {
                    full_name: fullName,
                    username,
                    phone,
                    referral_code: ref || null
                }
            }
        });

        U.loading('registerBtn', false);

        if (error) return U.showError('registerError', error.message);

        // If email confirmation is OFF, we have a session — sign in immediately.
        if (data.session && data.user) {
            await Auth.hydrate(data.user);
            U.toast('Account created', 'Welcome to Bingo Ethiopia!', 'success');
            App.refreshAuthUI();
            App.startRealtimeNotifications();
            setTimeout(() => App.go('dashboard'), 500);
        } else {
            U.showSuccess('registerSuccess',
                'Account created. Please check your email to confirm your address, then sign in.');
            setTimeout(() => App.go('login'), 1800);
        }
    },

    async forgotPassword() {
        const email = prompt('Enter your email address and we will send you a reset link:');
        if (!email) return;
        const { error } = await sb.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + window.location.pathname
        });
        if (error) return U.toast('Could not send reset email', error.message, 'error');
        U.toast('Reset email sent', 'Check your inbox for the reset link.', 'success');
    },

    async logout() {
        if (!confirm('Sign out of your account?')) return;
        await Auth.logout();
        App.refreshAuthUI();
        App.go('home');
        U.toast('Signed out', 'See you next time!', 'info');
    },

    /* ------------------------------------------------------------------ */
    /* UI reflect auth state                                               */
    /* ------------------------------------------------------------------ */
    refreshAuthUI() {
        const signedIn = !!STATE.user;
        document.querySelectorAll('.auth-only').forEach(el => el.style.display = signedIn ? '' : 'none');
        document.querySelectorAll('.guest-only').forEach(el => el.style.display = signedIn ? 'none' : '');

        const pill = document.getElementById('balancePill');
        if (pill) pill.classList.toggle('show', signedIn);

        if (signedIn) {
            App.updateBalanceUI();
        }
    },

    updateBalanceUI() {
        const b = STATE.wallet?.balance ?? 0;
        const nav = document.getElementById('navBalance');
        if (nav) nav.textContent = U.money(b, false);
        const da = document.getElementById('dashBalance');
        if (da) da.textContent = U.money(b, false);
        const wd = document.getElementById('walletAmount');
        if (wd) wd.innerHTML = U.money(b, false) + ' <span style="font-size:1rem;opacity:.8">ETB</span>';
        const wb = document.getElementById('walletBonus');
        if (wb) wb.textContent = U.money(STATE.wallet?.bonus_balance || 0, false);
    },

    /* ------------------------------------------------------------------ */
    /* HOME                                                                */
    /* ------------------------------------------------------------------ */
    async loadHome() {
        // Floating balls
        App.renderFloatBalls();

        // Jackpot
        const { data: set } = await sb.from('system_settings')
            .select('value').eq('key', 'jackpot').maybeSingle();
        const jp = Number(set?.value?.amount || 125000);
        const el = document.getElementById('jackpotAmount');
        if (el) el.textContent = jp.toLocaleString('en-US');
        const sp = document.getElementById('statPrize');
        if (sp) sp.textContent = Math.round(jp / 1000) + 'K';

        App.loadHomeGames();
        App.loadHomePromos();
        App.loadHomeWinners();
    },

    renderFloatBalls() {
        const box = document.getElementById('floatBalls');
        if (!box || box.dataset.rendered) return;
        box.dataset.rendered = '1';
        const letters = ['B','I','N','G','O'];
        const colors = {
            B: 'linear-gradient(135deg,#dc2626,#ef4444)',
            I: 'linear-gradient(135deg,#d97706,#f59e0b)',
            N: 'linear-gradient(135deg,#059669,#10b981)',
            G: 'linear-gradient(135deg,#2563eb,#3b82f6)',
            O: 'linear-gradient(135deg,#7c3aed,#a855f7)'
        };
        for (let i = 0; i < 12; i++) {
            const L = letters[i % 5];
            const n = Math.floor(Math.random() * 15) + 1 + letters.indexOf(L) * 15;
            const ball = document.createElement('div');
            ball.className = 'f-ball';
            ball.style.background = colors[L];
            ball.style.left = (5 + Math.random() * 90) + '%';
            ball.style.top  = (5 + Math.random() * 85) + '%';
            ball.style.animationDelay = (Math.random() * 8) + 's';
            ball.textContent = L + '-' + n;
            box.appendChild(ball);
        }
    },

    async loadHomeGames() {
        const { data: games } = await sb.from('game_lobby')
            .select('*')
            .in('status', ['scheduled','open','active'])
            .order('start_time', { ascending: true })
            .limit(12);

        const list = games || [];
        STATE.allGames = list;

        const featured = list.filter(g => g.is_featured).slice(0, 3);
        const upcoming = list.filter(g => g.status !== 'active').slice(0, 4);

        const fbox = document.getElementById('featuredGames');
        if (fbox) {
            fbox.innerHTML = featured.length
                ? featured.map(g => App.gameCardHtml(g)).join('')
                : U.empty('🎯', 'No featured games', 'Check back soon');
        }

        const ubox = document.getElementById('upcomingGames');
        if (ubox) {
            ubox.innerHTML = upcoming.length
                ? upcoming.map(g => App.gameRowCompact(g)).join('')
                : U.empty('⏰', 'Nothing scheduled', 'New games will appear here');
        }
    },

    gameCardHtml(g) {
        const statusCls = 'status-' + g.status;
        return `
            <div class="game-card ${g.is_featured ? 'featured' : ''}">
                <div class="game-card-top">
                    <div>
                        <h3>${U.esc(g.name)}</h3>
                        <div class="game-meta">
                            <span class="chip">📐 ${U.patternLabel(g.winning_pattern)}</span>
                            <span class="chip">🎟️ ${U.money(g.ticket_price, false)} ETB</span>
                        </div>
                    </div>
                    <span class="status-badge ${statusCls}">${U.statusLabel(g.status)}</span>
                </div>
                <div class="game-stats">
                    <div class="game-stat"><b>${U.money(g.prize, false)}</b><span>Prize</span></div>
                    <div class="game-stat"><b>${g.player_count || 0}</b><span>Players</span></div>
                </div>
                <button class="btn btn-primary btn-block" onclick="App.openGame('${g.id}')">
                    ${g.status === 'active' ? '🔴 Watch Live' : g.status === 'open' ? '🎟️ Join Game' : '👁️ View Game'}
                </button>
            </div>`;
    },

    gameRowCompact(g) {
        return `
            <div class="winner-row" style="cursor:pointer" onclick="App.openGame('${g.id}')">
                <div class="avatar" style="background:linear-gradient(135deg,var(--brand),var(--accent))">🎮</div>
                <div class="info">
                    <b>${U.esc(g.name)}</b>
                    <span>${U.dateTime(g.start_time)} · ${U.patternLabel(g.winning_pattern)}</span>
                </div>
                <div style="text-align:right">
                    <div class="winner-amount">${U.money(g.prize, false)}</div>
                    <span class="chip" style="margin-top:4px">${g.player_count || 0} players</span>
                </div>
            </div>`;
    },

    async loadHomePromos() {
        const { data } = await sb.from('promotions')
            .select('*').eq('status', 'active')
            .order('created_at', { ascending: false }).limit(4);

        const box = document.getElementById('homePromos');
        if (!box) return;
        box.innerHTML = (data || []).length
            ? data.map(p => App.promoCardHtml(p)).join('')
            : U.empty('🎁', 'No active promotions', 'New offers coming soon');
    },

    promoCardHtml(p) {
        return `
            <div class="promo-card">
                <div class="promo-img" style="background-image:url('${U.esc(p.image_url || '')}')"></div>
                <div class="promo-body">
                    <span class="chip" style="margin-bottom:8px">${U.esc(p.type.replace('_',' '))}</span>
                    <h4>${U.esc(p.title)}</h4>
                    <p>${U.esc((p.description || '').slice(0, 120))}${(p.description||'').length > 120 ? '…' : ''}</p>
                    ${p.bonus_amount > 0
                        ? `<div style="margin-top:10px;font-weight:900;color:var(--accent-2);font-family:'Orbitron',sans-serif">+${U.money(p.bonus_amount, false)} ETB</div>`
                        : ''}
                </div>
            </div>`;
    },

    async loadHomeWinners() {
        const { data } = await sb.from('public_winners')
            .select('*').order('claimed_at', { ascending: false }).limit(6);
        const box = document.getElementById('homeWinners');
        if (!box) return;
        box.innerHTML = (data || []).length
            ? data.map(w => App.winnerRowHtml(w)).join('')
            : U.empty('🏆', 'No winners yet', 'Be the first to win!');
    },

    winnerRowHtml(w) {
        return `
            <div class="winner-row">
                <div class="avatar">${U.esc(U.initials(w.username))}</div>
                <div class="info">
                    <b>${U.esc(w.username)}</b>
                    <span>${U.esc(w.game_name || 'Game')} · ${U.patternLabel(w.pattern)} · ${U.ago(w.claimed_at)}</span>
                </div>
                <div class="winner-amount">${U.money(w.prize_amount, false)}</div>
            </div>`;
    },

    /* ------------------------------------------------------------------ */
    /* DASHBOARD                                                           */
    /* ------------------------------------------------------------------ */
    async loadDashboard() {
        if (!STATE.user) return;
        const p = STATE.profile || {};
        document.getElementById('dashName').textContent = (p.full_name || p.username || 'Player').split(' ')[0];
        document.getElementById('dashSub').textContent = 'Here is what is happening in your account';

        App.updateBalanceUI();

        // Stat cards
        const { data: gps } = await sb.from('game_players')
            .select('game_id, status').eq('user_id', STATE.user.id);
        const played = (gps || []).length;
        const won    = (gps || []).filter(g => g.status === 'won').length;

        const { data: wins } = await sb.from('game_winners')
            .select('prize_amount, status').eq('user_id', STATE.user.id)
            .in('status', ['verified','paid']);
        const totalWon = (wins || []).reduce((s, w) => s + Number(w.prize_amount || 0), 0);

        const { data: refs } = await sb.from('referrals')
            .select('status').eq('referrer_id', STATE.user.id);

        document.getElementById('dashGames').textContent = U.num(played);
        document.getElementById('dashWins').textContent  = U.money(totalWon, false);
        document.getElementById('dashRefs').textContent  = U.num((refs || []).length);

        // Active games
        const { data: active } = await sb.from('game_lobby')
            .select('*').in('status', ['open','active'])
            .order('start_time', { ascending: true }).limit(4);
        const abox = document.getElementById('dashActiveGames');
        abox.innerHTML = (active || []).length
            ? active.map(g => App.gameRowCompact(g)).join('')
            : U.empty('🎮', 'No active games', 'Check the lobby');

        // Recent winnings
        const { data: recentWins } = await sb.from('game_winners')
            .select('*, games(name)')
            .eq('user_id', STATE.user.id)
            .in('status', ['verified','paid'])
            .order('claimed_at', { ascending: false }).limit(4);
        const wbox = document.getElementById('dashRecentWins');
        wbox.innerHTML = (recentWins || []).length
            ? recentWins.map(w => `
                <div class="winner-row">
                    <div class="avatar" style="background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#1a1200">🏆</div>
                    <div class="info">
                        <b>${U.esc(w.games?.name || 'Game')}</b>
                        <span>${U.patternLabel(w.pattern)} · ${U.date(w.claimed_at)}</span>
                    </div>
                    <div class="winner-amount">+${U.money(w.prize_amount, false)}</div>
                </div>`).join('')
            : U.empty('🏆', 'No wins yet', 'Keep playing!');

        // Recent games
        const { data: hist } = await sb.from('game_players')
            .select('*, games(name, prize, winning_pattern, status, ended_at)')
            .eq('user_id', STATE.user.id)
            .order('joined_at', { ascending: false }).limit(6);
        const hbox = document.getElementById('dashHistory');
        hbox.innerHTML = (hist || []).length
            ? hist.map(h => `
                <div class="winner-row">
                    <div class="avatar" style="background:var(--surface-2);border:1px solid var(--border);color:var(--text-2)">🎯</div>
                    <div class="info">
                        <b>${U.esc(h.games?.name || 'Game')}</b>
                        <span>${U.date(h.joined_at)} · ${U.patternLabel(h.games?.winning_pattern)} · Ticket ${U.money(h.ticket_price, false)} ETB</span>
                    </div>
                    <span class="pill ${h.status === 'won' ? 'pill-green' : h.status === 'lost' ? 'pill-grey' : 'pill-blue'}">${U.statusLabel(h.status)}</span>
                </div>`).join('')
            : U.empty('📜', 'No games played yet', 'Join a game from the lobby');

        // Promos
        const { data: promos } = await sb.from('promotions')
            .select('*').eq('status','active').limit(3);
        const pbox = document.getElementById('dashPromos');
        pbox.innerHTML = (promos || []).length
            ? promos.map(p => `
                <div class="card card-hover" style="padding:16px">
                    <div style="font-weight:800;margin-bottom:6px">${U.esc(p.title)}</div>
                    <div style="font-size:.78rem;color:var(--text-3);line-height:1.5">${U.esc((p.description||'').slice(0,90))}…</div>
                    ${p.bonus_amount > 0 ? `<div style="margin-top:8px;color:var(--accent-2);font-weight:900">+${U.money(p.bonus_amount, false)} ETB</div>` : ''}
                </div>`).join('')
            : U.empty('🎁', 'No promotions', 'Check back later');
    },

    /* ------------------------------------------------------------------ */
    /* GAMES LOBBY                                                         */
    /* ------------------------------------------------------------------ */
    async loadGames() {
        const { data, error } = await sb.from('game_lobby')
            .select('*')
            .in('status', ['scheduled','open','active','paused'])
            .order('start_time', { ascending: true })
            .limit(50);

        if (error) {
            console.warn('[games]', error.message);
            document.getElementById('gamesGrid').innerHTML =
                U.empty('⚠️', 'Could not load games', error.message);
            return;
        }

        STATE.allGames = data || [];
        App.renderGamesGrid();
    },

    filterGames(filter, el) {
        document.querySelectorAll('#gameTabs .tab').forEach(t => t.classList.remove('active'));
        el?.classList.add('active');
        App.renderGamesGrid(filter);
    },

    renderGamesGrid(filter) {
        filter = filter || 'all';
        const grid = document.getElementById('gamesGrid');
        if (!grid) return;

        let list = STATE.allGames.slice();
        if (filter === 'open')      list = list.filter(g => g.status === 'open');
        if (filter === 'active')    list = list.filter(g => g.status === 'active' || g.status === 'paused');
        if (filter === 'scheduled') list = list.filter(g => g.status === 'scheduled');
        if (filter === 'featured')  list = list.filter(g => g.is_featured);

        grid.innerHTML = list.length
            ? list.map(g => App.gameCardHtml(g)).join('')
            : U.empty('🎯', 'No games in this category', 'Try a different filter');
    },

    /* ------------------------------------------------------------------ */
    /* OPEN A GAME (join or watch)                                         */
    /* ------------------------------------------------------------------ */
    async openGame(gameId) {
        const g = STATE.allGames.find(x => x.id === gameId)
              || (await sb.from('game_lobby').select('*').eq('id', gameId).maybeSingle()).data;
        if (!g) return U.toast('Game not found', '', 'error');

        STATE.currentGame = g;
        STATE.currentCard = null;
        STATE.calledNumbers = [];
        STATE.calledSet = new Set();

        App.go('bingo');
        App.renderGameHeader();
        App.renderNumberBoard();
        App.renderCalledStrip();
        App.renderBingoGrid(null);
        App.renderGameHistory();

        // Load called numbers
        const { data: called } = await sb.from('called_numbers')
            .select('*').eq('game_id', gameId).order('sequence', { ascending: true });
        STATE.calledNumbers = called || [];
        STATE.calledSet = new Set((called || []).map(c => c.number));
        App.renderCalledStrip();
        App.renderGameHistory();
        if (called?.length) {
            const last = called[called.length - 1];
            App.showCurrentNumber(last.number, last.letter, false);
        }

        // Load my card for this game
        if (STATE.user) {
            const { data: card } = await sb.from('bingo_cards')
                .select('*').eq('game_id', gameId).eq('user_id', STATE.user.id).maybeSingle();
            if (card) {
                STATE.currentCard = card;
                App.renderBingoGrid(card.numbers);
                App.markCalledOnCard();
                document.getElementById('yourCardStatus').innerHTML =
                    `<div class="alert alert-success show" style="margin:0"><span>✅</span><span class="msg">You have a card in this game</span></div>`;
                document.getElementById('joinGameBtn').style.display = 'none';
                document.getElementById('bingoBtn').disabled = g.status !== 'active';
            } else {
                document.getElementById('yourCardStatus').innerHTML =
                    `<div class="alert alert-info show" style="margin:0"><span>ℹ️</span><span class="msg">Join this game to get your card</span></div>`;
                document.getElementById('joinGameBtn').style.display = '';
                document.getElementById('bingoBtn').disabled = true;
            }
        } else {
            document.getElementById('joinGameBtn').style.display = 'none';
            document.getElementById('bingoBtn').disabled = true;
        }

        App.loadPlayersList();
        App.subscribeToGame(gameId);
    },

    renderGameHeader() {
        const g = STATE.currentGame;
        if (!g) return;
        document.getElementById('bingoGameName').textContent      = g.name;
        document.getElementById('bingoGamePrize').textContent     = '🏆 ' + U.money(g.prize, false) + ' ETB';
        document.getElementById('bingoGameTicket').textContent    = '🎟️ ' + U.money(g.ticket_price, false) + ' ETB';
        document.getElementById('bingoGamePlayers').textContent   = '👥 ' + (g.player_count || 0);
        document.getElementById('bingoGamePattern').textContent   = '📐 ' + U.patternLabel(g.winning_pattern);

        const st = document.getElementById('bingoGameStatus');
        st.textContent = U.statusLabel(g.status);
        st.className = 'status-badge status-' + g.status;

        document.getElementById('sidePrize').textContent    = U.money(g.prize, false) + ' ETB';
        document.getElementById('sideTicket').textContent   = U.money(g.ticket_price, false) + ' ETB';
        document.getElementById('sidePattern').textContent  = U.patternLabel(g.winning_pattern);
        document.getElementById('sideInterval').textContent = (g.call_interval_seconds || 8) + 's';

        App.startGameTimer();
    },

    startGameTimer() {
        if (STATE.gameTimer) clearInterval(STATE.gameTimer);
        const el = document.getElementById('bingoTimer');
        const g = STATE.currentGame;
        if (!el || !g) return;
        const tick = () => {
            const now = Date.now();
            if (g.status === 'active' || g.status === 'paused') {
                const start = g.started_at ? new Date(g.started_at).getTime() : now;
                const s = Math.floor((now - start) / 1000);
                const m = Math.floor(s / 60);
                el.textContent = String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
            } else if (g.status === 'scheduled' || g.status === 'open') {
                const diff = new Date(g.start_time).getTime() - now;
                if (diff > 0) {
                    const m = Math.floor(diff / 60000);
                    const s = Math.floor((diff % 60000) / 1000);
                    el.textContent = 'Starts in ' + m + ':' + String(s).padStart(2, '0');
                } else {
                    el.textContent = 'Starting soon…';
                }
            } else {
                el.textContent = '—';
            }
        };
        tick();
        STATE.gameTimer = setInterval(tick, 1000);
    },

    renderNumberBoard() {
        const grid = document.getElementById('callerNumGrid');
        if (grid && !grid.dataset.rendered) {
            grid.dataset.rendered = '1';
            let html = '';
            for (let n = 1; n <= 75; n++) {
                const L = U.letterFor(n);
                html += `<div class="num-cell" data-num="${n}" data-letter="${L}">${n}</div>`;
            }
            grid.innerHTML = html;
        }
    },

    renderCalledStrip() {
        const box = document.getElementById('calledStrip');
        if (!box) return;
        const list = STATE.calledNumbers;
        const cnt = document.getElementById('calledCount');
        if (cnt) cnt.textContent = list.length + ' / 75';

        if (!list.length) {
            box.innerHTML = `<div class="empty-state" style="padding:16px"><p>No numbers called yet</p></div>`;
            return;
        }
        box.innerHTML = list.map((c, i) => {
            const cls = 'cb-' + U.letterClass(c.letter);
            const latest = i === list.length - 1 ? 'style="box-shadow:0 0 0 3px var(--accent),0 0 18px rgba(245,180,0,.65)"' : '';
            return `<div class="called-ball ${cls}" ${latest}><small>${c.letter}</small>${c.number}</div>`;
        }).join('');
        box.scrollTop = box.scrollHeight;
    },

    renderGameHistory() {
        const box = document.getElementById('bingoHistory');
        if (!box) return;
        const list = STATE.calledNumbers;
        if (!list.length) {
            box.innerHTML = `<div class="empty-state" style="padding:16px"><p>No numbers called yet</p></div>`;
            return;
        }
        box.innerHTML = list.map(c => `
            <div class="winner-row" style="padding:8px 12px;margin-bottom:6px">
                <div class="called-ball cb-${U.letterClass(c.letter)}" style="width:38px;height:38px;font-size:.75rem;position:relative">
                    <small style="position:absolute;top:2px;font-size:.5rem;opacity:.85">${c.letter}</small>${c.number}
                </div>
                <div class="info"><b>${c.letter}-${c.number}</b><span>Call #${c.sequence}</span></div>
                <span style="font-size:.72rem;color:var(--text-3)">${U.time(c.called_at)}</span>
            </div>`).reverse().join('');
    },

    showCurrentNumber(n, letter, animate = true) {
        const ball   = document.getElementById('currentBall');
        const numEl  = document.getElementById('currentNum');
        const letEl  = document.getElementById('currentLetter');
        const hint   = document.getElementById('currentHint');
        if (!ball) return;

        numEl.textContent = n;
        letEl.textContent = letter || U.letterFor(n);

        ball.className = 'call-ball ball-' + U.letterClass(letter || U.letterFor(n)).toUpperCase().toLowerCase();
        if (animate) {
            ball.classList.remove('animate');
            void ball.offsetWidth;
            ball.classList.add('animate');
        }
        if (hint) hint.textContent = 'Latest call: ' + (letter || U.letterFor(n)) + '-' + n;
    },

    renderBingoGrid(numbers) {
        const grid = document.getElementById('bingoGrid');
        if (!grid) return;
        if (!numbers) {
            grid.innerHTML = Array.from({ length: 25 }).map((_, i) => {
                if (i === 12) return `<div class="bingo-cell free">FREE</div>`;
                return `<div class="bingo-cell" style="opacity:.35">—</div>`;
            }).join('');
            return;
        }
        grid.innerHTML = numbers.map((n, i) => {
            if (i === 12) return `<div class="bingo-cell free marked" data-idx="12">FREE</div>`;
            return `<div class="bingo-cell" data-idx="${i}" data-num="${n}">${n}</div>`;
        }).join('');
    },

    markCalledOnCard() {
        if (!STATE.currentCard) return;
        const cells = document.querySelectorAll('#bingoGrid .bingo-cell');
        cells.forEach(cell => {
            const n = Number(cell.dataset.num);
            if (!n) return;
            const marked = STATE.calledSet.has(n);
            cell.classList.toggle('marked', marked);
            cell.classList.toggle('latest',
                STATE.calledNumbers.length > 0 &&
                STATE.calledNumbers[STATE.calledNumbers.length - 1].number === n);
        });
    },

    async loadPlayersList() {
        const box = document.getElementById('bingoPlayersList');
        if (!box || !STATE.currentGame) return;
        const { data } = await sb.from('game_players')
            .select('user_id, status, profiles(username, avatar_url)')
            .eq('game_id', STATE.currentGame.id);
        const list = data || [];
        box.innerHTML = list.length
            ? list.map(p => `
                <div class="winner-row" style="padding:8px 10px;margin-bottom:6px">
                    <div class="avatar" style="width:34px;height:34px;border-radius:9px;font-size:.75rem">
                        ${U.esc(U.initials(p.profiles?.username || '?'))}
                    </div>
                    <div class="info"><b style="font-size:.82rem">${U.esc(p.profiles?.username || 'Player')}</b></div>
                    <span class="pill ${p.status === 'won' ? 'pill-green' : p.status === 'lost' ? 'pill-grey' : 'pill-blue'}" style="font-size:.6rem">${U.statusLabel(p.status)}</span>
                </div>`).join('')
            : `<div class="empty-state" style="padding:14px"><p>Waiting for players…</p></div>`;

        const chip = document.getElementById('bingoGamePlayers');
        if (chip) chip.textContent = '👥 ' + list.length;
    },

    /* ------------------------------------------------------------------ */
    /* JOIN CURRENT GAME                                                   */
    /* ------------------------------------------------------------------ */
    async joinCurrentGame() {
        if (!STATE.user) { App.go('login'); return; }
        if (!STATE.currentGame) return;

        if (!confirm('Buy a ticket for ' + U.money(STATE.currentGame.ticket_price, false) + ' ETB?')) return;

        const btn = document.getElementById('joinGameBtn');
        btn.disabled = true;
        btn.textContent = 'Joining…';

        const { data, error } = await sb.rpc('join_game', { p_game_id: STATE.currentGame.id });

        btn.disabled = false;
        btn.textContent = '🎟️ Join Game';

        if (error) {
            U.toast('Could not join', error.message, 'error');
            return;
        }
        if (!data?.success) {
            U.toast('Could not join', data?.reason || 'Unknown error', 'error');
            return;
        }

        U.toast('Joined game', 'Good luck! Card #' + String(data.card_id).slice(0, 8), 'success');

        // Refresh wallet
        STATE.wallet = await Auth.fetchWallet(STATE.user.id);
        App.updateBalanceUI();

        // Reload room
        App.openGame(STATE.currentGame.id);
    },

    /* ------------------------------------------------------------------ */
    /* CLAIM BINGO                                                         */
    /* ------------------------------------------------------------------ */
    async claimBingo() {
        if (!STATE.user || !STATE.currentGame || !STATE.currentCard) return;
        const btn = document.getElementById('bingoBtn');
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = 'CHECKING…';

        const { data, error } = await sb.rpc('claim_bingo', {
            p_game_id: STATE.currentGame.id,
            p_card_id: STATE.currentCard.id
        });

        btn.textContent = orig;

        if (error) {
            U.toast('Claim failed', error.message, 'error', 6000);
            btn.disabled = false;
            return;
        }
        if (!data?.success) {
            U.toast('Not a valid Bingo', data?.reason || 'Pattern not complete yet', 'warning', 5000);
            btn.disabled = false;
            return;
        }

        U.toast('🎉 BINGO!', data.message || 'You won!', 'success', 8000);
        if (window.confetti) { try { window.confetti(); } catch (e) {} }
        // Refresh wallet + winners
        STATE.wallet = await Auth.fetchWallet(STATE.user.id);
        App.updateBalanceUI();

        setTimeout(() => App.openGame(STATE.currentGame.id), 1200);
    },

    /* ------------------------------------------------------------------ */
    /* WALLET                                                              */
    /* ------------------------------------------------------------------ */
    async loadWallet() {
        if (!STATE.user) return;
        STATE.wallet = await Auth.fetchWallet(STATE.user.id);
        App.updateBalanceUI();
        App.loadTransactions('all');
    },

    filterTx(filter, el) {
        document.querySelectorAll('#walletTabs .tab').forEach(t => t.classList.remove('active'));
        el?.classList.add('active');
        App.loadTransactions(filter);
    },

    async loadTransactions(filter) {
        const box = document.getElementById('transactionsList');
        if (!box || !STATE.user) return;

        let q = sb.from('wallet_transactions')
            .select('*').eq('user_id', STATE.user.id)
            .order('created_at', { ascending: false }).limit(60);

        if (filter && filter !== 'all') q = q.eq('type', filter);

        const { data, error } = await q;
        if (error) {
            box.innerHTML = U.empty('⚠️', 'Could not load transactions', error.message);
            return;
        }
        const list = data || [];
        if (!list.length) {
            box.innerHTML = U.empty('🧾', 'No transactions yet', 'Your activity will show here');
            return;
        }
        box.innerHTML = list.map(t => {
            const credit = Number(t.amount) > 0;
            const icons = {
                deposit: '💵', withdrawal: '🏦', bet: '🎟️', win: '🏆',
                refund: '↩️', bonus: '🎁', referral: '🤝',
                adjustment: '⚙️', fee: '💸', jackpot: '💰'
            };
            return `
                <div class="tx-row">
                    <div class="tx-icon ${credit ? 'credit' : 'debit'}">${icons[t.type] || '•'}</div>
                    <div class="tx-body">
                        <b>${U.esc(t.description || t.type)}</b>
                        <span>${U.dateTime(t.created_at)} · ${U.esc(t.reference || '—')}</span>
                    </div>
                    <div style="text-align:right">
                        <div class="tx-amount ${credit ? 'credit' : 'debit'}">${credit ? '+' : ''}${U.money(t.amount, false)}</div>
                        <span style="font-size:.7rem;color:var(--text-3)">${U.money(t.balance_after, false)} ETB</span>
                    </div>
                </div>`;
        }).join('');
    },

    /* ------------------------------------------------------------------ */
    /* DEPOSIT / WITHDRAW modals                                           */
    /* ------------------------------------------------------------------ */
    async openDeposit() {
        if (!STATE.user) return;
        const { data: providers } = await sb.from('system_settings')
            .select('value').eq('key', 'payment_providers').maybeSingle();
        const list = providers?.value?.list || ['telebirr','chapa','cbe_birr','amole'];
        const opts = list.map(p => `<option value="${U.esc(p)}">${U.esc(p.replace(/_/g,' ').toUpperCase())}</option>`).join('');

        U.modal(`
            <h3>Deposit Funds</h3>
            <p class="modal-sub">Choose a provider, then complete the payment in the provider app. Your wallet is credited only after the provider confirms the payment.</p>
            <div class="field">
                <label>Amount (ETB)</label>
                <input class="input" type="number" id="depAmount" min="10" step="1" placeholder="e.g. 100">
            </div>
            <div class="field">
                <label>Payment Provider</label>
                <select class="input" id="depProvider">${opts}</select>
            </div>
            <div class="field">
                <label>Reference / Phone (optional)</label>
                <input class="input" id="depRef" placeholder="e.g. 0912345678">
            </div>
            <div class="alert alert-info show" style="margin-top:10px"><span>ℹ️</span><span class="msg">Deposits are verified by our finance team after the provider sends confirmation.</span></div>
            <div class="modal-actions">
                <button class="btn btn-ghost" onclick="App.closeModal()">Cancel</button>
                <button class="btn btn-gold" id="depSubmitBtn" onclick="App.submitDeposit()">Create Deposit Request</button>
            </div>
        `);
    },

    async submitDeposit() {
        const amount   = Number(document.getElementById('depAmount').value);
        const provider = document.getElementById('depProvider').value;
        const ref      = document.getElementById('depRef').value.trim();

        if (!amount || amount <= 0) {
            U.toast('Invalid amount', 'Please enter a valid amount', 'error');
            return;
        }

        const btn = document.getElementById('depSubmitBtn');
        btn.disabled = true; btn.textContent = 'Submitting…';

        const { data, error } = await sb.rpc('request_deposit', {
            p_amount: amount,
            p_provider: provider,
            p_reference: ref || null
        });

        btn.disabled = false; btn.textContent = 'Create Deposit Request';

        if (error) return U.toast('Deposit error', error.message, 'error');
        if (!data?.success) return U.toast('Deposit error', data?.reason || 'Failed', 'error');

        App.closeModal();
        U.toast('Deposit request created',
            'Waiting for ' + provider.toUpperCase() + ' to confirm your payment of ' +
            U.money(amount, false) + ' ETB.', 'success', 7000);
        App.loadWallet();
    },

    async openWithdraw() {
        if (!STATE.user) return;
        const bal = STATE.wallet?.balance ?? 0;
        const { data: providers } = await sb.from('system_settings')
            .select('value').eq('key', 'payment_providers').maybeSingle();
        const list = providers?.value?.list || ['telebirr','chapa','cbe_birr','amole'];
        const opts = list.map(p => `<option value="${U.esc(p)}">${U.esc(p.replace(/_/g,' ').toUpperCase())}</option>`).join('');

        U.modal(`
            <h3>Withdraw Funds</h3>
            <p class="modal-sub">Available balance: <b style="color:var(--accent-2)">${U.money(bal, false)} ETB</b></p>
            <div class="field">
                <label>Amount (ETB)</label>
                <input class="input" type="number" id="wdAmount" min="50" step="1" max="${bal}" placeholder="e.g. 100">
            </div>
            <div class="field">
                <label>Withdraw To</label>
                <select class="input" id="wdProvider">${opts}</select>
            </div>
            <div class="field">
                <label>Account / Phone Number</label>
                <input class="input" id="wdDest" placeholder="e.g. 0912345678">
            </div>
            <div class="field">
                <label>Account Holder Name</label>
                <input class="input" id="wdName" placeholder="Full name on account">
            </div>
            <div class="alert alert-info show" style="margin-top:10px"><span>ℹ️</span><span class="msg">Withdrawals are reviewed and processed within 24 hours.</span></div>
            <div class="modal-actions">
                <button class="btn btn-ghost" onclick="App.closeModal()">Cancel</button>
                <button class="btn btn-gold" id="wdSubmitBtn" onclick="App.submitWithdraw()">Request Withdrawal</button>
            </div>
        `);
    },

    async submitWithdraw() {
        const amount   = Number(document.getElementById('wdAmount').value);
        const provider = document.getElementById('wdProvider').value;
        const dest     = document.getElementById('wdDest').value.trim();
        const name     = document.getElementById('wdName').value.trim();

        if (!amount || amount <= 0) return U.toast('Invalid amount', '', 'error');
        if (!dest) return U.toast('Missing destination', 'Enter your account / phone number', 'error');

        const btn = document.getElementById('wdSubmitBtn');
        btn.disabled = true; btn.textContent = 'Submitting…';

        const { data, error } = await sb.rpc('request_withdrawal', {
            p_amount: amount,
            p_provider: provider,
            p_destination: dest,
            p_holder_name: name || null
        });

        btn.disabled = false; btn.textContent = 'Request Withdrawal';

        if (error) return U.toast('Withdrawal error', error.message, 'error');
        if (!data?.success) return U.toast('Withdrawal error', data?.reason || 'Failed', 'error');

        App.closeModal();
        U.toast('Withdrawal requested', 'We will process it within 24 hours.', 'success', 6000);

        STATE.wallet = await Auth.fetchWallet(STATE.user.id);
        App.updateBalanceUI();
        App.loadWallet();
    },

    /* ------------------------------------------------------------------ */
    /* PROMOTIONS / WINNERS                                                */
    /* ------------------------------------------------------------------ */
    async loadPromotions() {
        const { data } = await sb.from('promotions')
            .select('*').eq('status','active')
            .order('created_at', { ascending: false });
        const box = document.getElementById('promotionsGrid');
        box.innerHTML = (data || []).length
            ? data.map(p => App.promoCardHtml(p)).join('')
            : U.empty('🎁', 'No active promotions', 'Check back soon');
    },

    async loadWinners() {
        const { data } = await sb.from('public_winners')
            .select('*').order('claimed_at', { ascending: false }).limit(60);
        const box = document.getElementById('winnersGrid');
        box.innerHTML = (data || []).length
            ? data.map(w => App.winnerRowHtml(w)).join('')
            : U.empty('🏆', 'No winners yet', 'Be the first to win!');
    },

    /* ------------------------------------------------------------------ */
    /* REFERRALS                                                           */
    /* ------------------------------------------------------------------ */
    async loadReferrals() {
        if (!STATE.user) return;
        const p = STATE.profile || {};
        const code = p.referral_code || 'BINGO-XXXXX';
        document.getElementById('myReferralCode').textContent = code;
        const link = window.location.origin + '/index.html?ref=' + code;
        document.getElementById('myReferralLink').value = link;

        const { data: refs } = await sb.from('referrals')
            .select('*, referred:referred_id(username, created_at, status)')
            .eq('referrer_id', STATE.user.id)
            .order('created_at', { ascending: false });

        const list = refs || [];
        document.getElementById('refTotal').textContent     = list.length;
        document.getElementById('refQualified').textContent = list.filter(r => r.status === 'qualified' || r.status === 'rewarded').length;

        const { data: rewards } = await sb.from('referral_rewards')
            .select('amount, status').eq('referrer_id', STATE.user.id);
        const paid = (rewards || []).filter(r => r.status === 'paid').reduce((s, r) => s + Number(r.amount || 0), 0);
        document.getElementById('refEarned').textContent = U.money(paid, false);

        const box = document.getElementById('referralsList');
        box.innerHTML = list.length
            ? list.map(r => `
                <div class="winner-row">
                    <div class="avatar" style="background:linear-gradient(135deg,var(--brand),var(--brand-2))">${U.esc(U.initials(r.referred?.username || '?'))}</div>
                    <div class="info">
                        <b>${U.esc(r.referred?.username || 'User')}</b>
                        <span>Joined ${U.date(r.created_at)}</span>
                    </div>
                    <span class="pill ${r.status === 'rewarded' ? 'pill-green' : r.status === 'qualified' ? 'pill-blue' : 'pill-yellow'}">${U.statusLabel(r.status)}</span>
                </div>`).join('')
            : U.empty('👥', 'No referrals yet', 'Share your code to start earning');
    },

    copyReferralCode() {
        const code = document.getElementById('myReferralCode').textContent;
        navigator.clipboard.writeText(code).then(
            () => U.toast('Copied', 'Referral code copied to clipboard', 'success'),
            () => U.toast('Copy failed', 'Please copy manually', 'error')
        );
    },
    copyReferralLink() {
        const link = document.getElementById('myReferralLink').value;
        navigator.clipboard.writeText(link).then(
            () => U.toast('Copied', 'Referral link copied to clipboard', 'success'),
            () => U.toast('Copy failed', 'Please copy manually', 'error')
        );
    },

    /* ------------------------------------------------------------------ */
    /* PROFILE                                                             */
    /* ------------------------------------------------------------------ */
    async loadProfile() {
        if (!STATE.user) return;
        const p = STATE.profile || {};
        document.getElementById('profileName').textContent     = p.full_name || p.username || 'Player';
        document.getElementById('profileUsername').textContent = '@' + (p.username || 'user');
        document.getElementById('pFullName').textContent       = p.full_name || '—';
        document.getElementById('pUsername').textContent       = p.username  || '—';
        document.getElementById('pEmail').textContent          = p.email     || '—';
        document.getElementById('pPhone').textContent          = p.phone     || '—';
        document.getElementById('pRefCode').textContent        = p.referral_code || '—';
        document.getElementById('pCreated').textContent        = U.date(p.created_at);
        document.getElementById('pStatus').textContent         = U.statusLabel(p.status);

        const ps = document.getElementById('profileStatus');
        ps.textContent = U.statusLabel(p.status);
        ps.className = 'status-badge ' + (p.status === 'active' ? 'status-open' : 'status-paused');

        document.getElementById('editFullName').value = p.full_name || '';
        document.getElementById('editUsername').value = p.username  || '';
        document.getElementById('editPhone').value    = p.phone     || '';

        const initial = document.getElementById('avatarInitial');
        const img     = document.getElementById('avatarImg');
        if (p.avatar_url) {
            img.src = p.avatar_url;
            img.style.display = '';
            initial.style.display = 'none';
        } else {
            initial.textContent = U.initials(p.full_name || p.username || 'P');
            initial.style.display = '';
            img.style.display = 'none';
        }
    },

    async updateProfile(e) {
        e.preventDefault();
        if (!STATE.user) return;
        const full_name = document.getElementById('editFullName').value.trim();
        const username  = document.getElementById('editUsername').value.trim();
        const phone     = document.getElementById('editPhone').value.trim();

        if (username && !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
            return U.toast('Invalid username', '3–20 characters, letters/numbers/underscore', 'error');
        }

        const btn = document.getElementById('updateProfileBtn');
        btn.disabled = true; btn.textContent = 'Saving…';

        const { error } = await sb.from('profiles')
            .update({ full_name, username, phone }).eq('id', STATE.user.id);

        btn.disabled = false; btn.textContent = 'Save Changes';

        if (error) return U.toast('Update failed', error.message, 'error');

        U.toast('Profile updated', '', 'success');
        STATE.profile = await Auth.fetchProfile(STATE.user.id);
        App.loadProfile();
    },

    async uploadAvatar(e) {
        if (!STATE.user || !e.target.files?.[0]) return;
        const file = e.target.files[0];
        if (file.size > 2 * 1024 * 1024) return U.toast('File too big', 'Max 2 MB', 'error');
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
        const path = STATE.user.id + '/' + Date.now() + '.' + ext;

        U.toast('Uploading…', '', 'info', 1500);
        const { error: upErr } = await sb.storage.from('avatars')
            .upload(path, file, { upsert: true, cacheControl: '3600' });
        if (upErr) return U.toast('Upload failed', upErr.message, 'error');

        const { data: url } = sb.storage.from('avatars').getPublicUrl(path);
        const { error: dbErr } = await sb.from('profiles')
            .update({ avatar_url: url.publicUrl }).eq('id', STATE.user.id);
        if (dbErr) return U.toast('Save failed', dbErr.message, 'error');

        STATE.profile = await Auth.fetchProfile(STATE.user.id);
        App.loadProfile();
        U.toast('Avatar updated', '', 'success');
    },

    /* ------------------------------------------------------------------ */
    /* NOTIFICATIONS                                                       */
    /* ------------------------------------------------------------------ */
    openNotifications() {
        document.getElementById('notifOverlay')?.classList.add('show');
        document.getElementById('notifPanel')?.classList.add('show');
        App.loadNotifications();
    },
    closeNotifications() {
        document.getElementById('notifOverlay')?.classList.remove('show');
        document.getElementById('notifPanel')?.classList.remove('show');
    },

    async loadNotifications() {
        if (!STATE.user) return;
        const { data } = await sb.from('notifications')
            .select('*')
            .or(`user_id.eq.${STATE.user.id},user_id.is.null`)
            .order('created_at', { ascending: false })
            .limit(40);
        const box = document.getElementById('notifList');
        if (!box) return;
        const list = data || [];
        box.innerHTML = list.length
            ? list.map(n => `
                <div class="notif-item ${n.is_read ? '' : 'unread'}" onclick="App.markNotificationRead('${n.id}')">
                    <b>${U.esc(n.title)}</b>
                    ${n.body ? `<p>${U.esc(n.body)}</p>` : ''}
                    <time>${U.ago(n.created_at)}</time>
                </div>`).join('')
            : U.empty('🔔', 'No notifications', 'You are all caught up');
    },

    async markNotificationRead(id) {
        if (!STATE.user) return;
        await sb.from('notifications').update({ is_read: true }).eq('id', id);
        App.updateNotifBadge();
    },

    async updateNotifBadge() {
        if (!STATE.user) return;
        const { data } = await sb.from('notifications')
            .select('id', { count: 'exact', head: false })
            .or(`user_id.eq.${STATE.user.id},user_id.is.null`)
            .eq('is_read', false);
        const n = (data || []).length;
        const badge = document.getElementById('notifBadge');
        if (badge) {
            badge.textContent = n > 99 ? '99+' : n;
            badge.classList.toggle('show', n > 0);
        }
    },

    startRealtimeNotifications() {
        if (!STATE.user || STATE.channels.notif) return;
        const ch = sb.channel('notifications:' + STATE.user.id)
            .on('postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'notifications',
                  filter: `user_id=eq.${STATE.user.id}` },
                payload => {
                    const n = payload.new;
                    U.toast(n.title, n.body || '', 'info', 6000);
                    App.updateNotifBadge();
                    if (document.getElementById('notifPanel')?.classList.contains('show')) {
                        App.loadNotifications();
                    }
                })
            .subscribe();
        STATE.channels.notif = ch;
        App.updateNotifBadge();
        setInterval(App.updateNotifBadge, 30000);
    },

    /* ------------------------------------------------------------------ */
    /* REALTIME GAME ROOM                                                  */
    /* ------------------------------------------------------------------ */
    subscribeToGame(gameId) {
        if (STATE.channels.game) {
            try { sb.removeChannel(STATE.channels.game); } catch (e) {}
            delete STATE.channels.game;
        }
        App.setConnStatus('connecting');

        const ch = sb.channel('game:' + gameId, {
            config: { broadcast: { self: false } }
        });

        ch.on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'called_numbers',
              filter: `game_id=eq.${gameId}` },
            payload => App.onNumberCalled(payload.new));

        ch.on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'games',
              filter: `id=eq.${gameId}` },
            payload => App.onGameUpdated(payload.new));

        ch.on('postgres_changes',
            { event: '*', schema: 'public', table: 'game_players',
              filter: `game_id=eq.${gameId}` },
            () => App.loadPlayersList());

        ch.on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'game_winners',
              filter: `game_id=eq.${gameId}` },
            payload => {
                U.toast('BINGO!', 'A player has claimed BINGO!', 'warning', 7000);
                App.loadPlayersList();
            });

        ch.subscribe(status => {
            if (status === 'SUBSCRIBED') {
                App.setConnStatus('live');
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                App.setConnStatus('offline');
                App.scheduleReconnect(gameId);
            }
        });

        STATE.channels.game = ch;
    },

    scheduleReconnect(gameId) {
        if (STATE.reconnectTimer) return;
        STATE.reconnectTimer = setTimeout(() => {
            STATE.reconnectTimer = null;
            if (STATE.currentGame && STATE.currentGame.id === gameId) {
                App.subscribeToGame(gameId);
            }
        }, 4000);
    },

    setConnStatus(status) {
        const el = document.getElementById('connStatus');
        if (!el) return;
        el.className = 'conn-status ' + (status === 'live' ? 'live' : status === 'offline' ? 'offline' : '');
        el.innerHTML = `<span class="dot"></span>${
            status === 'live' ? 'Live' :
            status === 'offline' ? 'Offline' :
            'Connecting…'}`;

        const bar = document.getElementById('reconnectBar');
        if (bar) bar.classList.toggle('show', status === 'offline');
    },

    onNumberCalled(row) {
        // Ignore duplicates
        if (STATE.calledSet.has(row.number)) return;
        STATE.calledSet.add(row.number);
        STATE.calledNumbers.push(row);
        STATE.calledNumbers.sort((a, b) => a.sequence - b.sequence);

        App.showCurrentNumber(row.number, row.letter, true);
        App.renderCalledStrip();
        App.renderGameHistory();
        App.markCalledOnCard();

        if (STATE.currentGame) {
            STATE.currentGame.current_number = row.number;
            STATE.currentGame.current_letter = row.letter;
            STATE.currentGame.called_count   = STATE.calledNumbers.length;
        }

        // Enable BINGO button if I have a card
        const btn = document.getElementById('bingoBtn');
        if (btn && STATE.currentCard && STATE.currentGame.status === 'active') {
            btn.disabled = false;
        }
    },

    onGameUpdated(g) {
        if (!STATE.currentGame) return;
        Object.assign(STATE.currentGame, g);
        App.renderGameHeader();

        const st = document.getElementById('bingoGameStatus');
        st.textContent = U.statusLabel(g.status);
        st.className = 'status-badge status-' + g.status;

        const btn = document.getElementById('bingoBtn');
        if (btn) btn.disabled = !(STATE.currentCard && g.status === 'active');

        if (g.status === 'paused') U.toast('Game paused', 'The caller has paused the game', 'warning');
        if (g.status === 'completed') U.toast('Game finished', 'Thanks for playing!', 'info', 7000);
        if (g.status === 'cancelled') U.toast('Game cancelled', 'Your ticket has been refunded', 'warning', 7000);
    }
};

window.App = App;

/* =============================================================================
 * 12. ADMIN SYSTEM  —  window.Admin
 * ============================================================================= */

const Admin = {

    /* ------------------------------------------------------------------ */
    /* Auth gate                                                           */
    /* ------------------------------------------------------------------ */
    async submitLogin(e) {
        e.preventDefault();
        U.hideAlert('adminLoginError');
        U.loading('adminLoginBtn', true);

        const email    = document.getElementById('adminEmail').value.trim();
        const password = document.getElementById('adminPassword').value;

        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        U.loading('adminLoginBtn', false);

        if (error) return U.showError('adminLoginError', error.message);

        await Auth.hydrate(data.user);

        if (!Auth.isStaff()) {
            U.showError('adminLoginError',
                'This account does not have administrator privileges.');
            await Auth.logout();
            return;
        }

        Admin.enter();
    },

    togglePassword(id, btn) {
        const el = document.getElementById(id);
        if (!el) return;
        const show = el.type === 'password';
        el.type = show ? 'text' : 'password';
        if (btn) btn.textContent = show ? '🙈' : '👁️';
    },

    enter() {
        document.getElementById('adminLoginGate').classList.add('hidden');
        document.getElementById('adminApp').classList.add('ready');

        // Avatar / name / role
        const p = STATE.profile || {};
        document.getElementById('sbUserName').textContent = p.full_name || p.username || 'Administrator';
        const primary = STATE.roles.find(r => r.is_staff)?.code || 'STAFF';
        document.getElementById('sbUserRole').textContent = primary.replace(/_/g, ' ');
        const initEl = document.getElementById('sbAvatarInitial');
        if (initEl) initEl.textContent = U.initials(p.full_name || p.username || 'A');

        // Role-gated menu items
        document.querySelectorAll('#sbNav .sb-item[data-role]').forEach(el => {
            const need = el.dataset.role;
            const allowed =
                Auth.isAdmin() ||
                (need === 'GAME_MANAGER'       && Auth.isGameMgr()) ||
                (need === 'FINANCE_MANAGER'    && Auth.isFinance()) ||
                (need === 'MARKETING_MANAGER'  && Auth.isMarketing());
            el.style.display = allowed ? '' : 'none';
        });

        Admin.go('dashboard');
        Admin.startRealtimeAdmin();
        setInterval(Admin.updateBadges, 30000);
        Admin.updateBadges();
    },

    async logout() {
        if (!confirm('Sign out of the admin console?')) return;
        await Auth.logout();
        location.reload();
    },

    toggleTheme() { U.toggleTheme(); },

    toggleSidebar(force) {
        const sb_ = document.getElementById('sidebar');
        const bd  = document.getElementById('sbBackdrop');
        if (!sb_) return;
        const open = typeof force === 'boolean' ? force : !sb_.classList.contains('open');
        sb_.classList.toggle('open', open);
        bd?.classList.toggle('show', open);
    },

    /* ------------------------------------------------------------------ */
    /* Navigation                                                          */
    /* ------------------------------------------------------------------ */
    go(view) {
        const titles = {
            dashboard:    ['Dashboard',        'Platform overview'],
            reports:      ['Reports',          'Financial and operational analytics'],
            caller:       ['Bingo Caller',     'Run live games in real time'],
            games:        ['Game Management',  'Create and control Bingo games'],
            users:        ['User Management',  'Search and moderate players'],
            deposits:     ['Deposits',         'Confirm deposit requests'],
            withdrawals:  ['Withdrawals',      'Process payout requests'],
            transactions: ['Transactions',     'Complete wallet ledger'],
            promotions:   ['Promotions',       'Marketing campaigns'],
            banners:      ['Banners',          'Homepage slides'],
            notifications:['Notifications',    'Broadcast messages'],
            referrals:    ['Referrals',        'Referral program'],
            audit:        ['Audit Log',        'Every staff action'],
            settings:     ['Settings',         'Platform configuration']
        };

        document.querySelectorAll('.sb-item').forEach(el => {
            el.classList.toggle('active', el.dataset.view === view);
        });
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-' + view)?.classList.add('active');

        const [t, s] = titles[view] || [view, ''];
        document.getElementById('viewTitle').childNodes[0].nodeValue = t;
        document.getElementById('viewSubtitle').textContent = s;

        Admin.toggleSidebar(false);
        window.scrollTo({ top: 0 });

        // Lazy loaders
        switch (view) {
            case 'dashboard':     Admin.loadDashboard(); break;
            case 'reports':       Admin.loadReports(); break;
            case 'caller':        Admin.loadCallerGames(); break;
            case 'games':         Admin.loadGames(); break;
            case 'users':         Admin.loadUsers(); break;
            case 'deposits':      Admin.loadDeposits(); break;
            case 'withdrawals':   Admin.loadWithdrawals(); break;
            case 'transactions':  Admin.loadTransactions(); break;
            case 'promotions':    Admin.loadPromotions(); break;
            case 'banners':       Admin.loadBanners(); break;
            case 'notifications': Admin.loadAdminNotifications(); break;
            case 'referrals':     Admin.loadAdminReferrals(); break;
            case 'audit':         Admin.loadAudit(); break;
            case 'settings':      Admin.loadSettings(); break;
        }
    },

    refreshCurrentView() {
        const active = document.querySelector('.view.active')?.id.replace('view-', '');
        if (active) Admin.go(active);
    },

    /* ------------------------------------------------------------------ */
    /* Realtime for admin                                                  */
    /* ------------------------------------------------------------------ */
    startRealtimeAdmin() {
        if (STATE.channels.admin) return;
        const ch = sb.channel('admin:feeds')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'deposits' },
                () => { Admin.updateBadges(); if (document.querySelector('.view.active')?.id === 'view-deposits') Admin.loadDeposits(); })
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'withdrawals' },
                () => { Admin.updateBadges(); if (document.querySelector('.view.active')?.id === 'view-withdrawals') Admin.loadWithdrawals(); })
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_winners' },
                () => { if (document.querySelector('.view.active')?.id === 'view-caller') Admin.reloadCallerClaims(); })
            .subscribe();
        STATE.channels.admin = ch;
    },

    async updateBadges() {
        const [deps, wds] = await Promise.all([
            sb.from('deposits').select('id', { count: 'exact', head: true }).eq('status','pending'),
            sb.from('withdrawals').select('id', { count: 'exact', head: true }).eq('status','pending')
        ]);
        const nd = deps.count || 0;
        const nw = wds.count || 0;

        const bd = document.getElementById('badgeDeposits');
        if (bd) { bd.textContent = nd; bd.classList.toggle('show', nd > 0); }
        const bw = document.getElementById('badgeWithdrawals');
        if (bw) { bw.textContent = nw; bw.classList.toggle('show', nw > 0); }

        const dot = document.getElementById('topNotifDot');
        if (dot) { dot.textContent = nd + nw; dot.classList.toggle('show', (nd + nw) > 0); }
    },

    /* ------------------------------------------------------------------ */
    /* DASHBOARD                                                           */
    /* ------------------------------------------------------------------ */
    async loadDashboard() {
        const since14 = new Date(Date.now() - 14 * 86400000).toISOString();
        const since7  = new Date(Date.now() - 7 * 86400000).toISOString();
        const since5m = new Date(Date.now() - 5 * 60000).toISOString();

        const [
            { count: totalUsers },
            { count: newUsers },
            { count: online },
            { count: activeGames },
            { count: totalGames },
            { count: completedGames },
            { data: deps },
            { data: wds },
            { data: bets },
            { data: wins },
            { data: recentWinners },
            { data: profiles14 },
            { data: tx14 }
        ] = await Promise.all([
            sb.from('profiles').select('id', { count:'exact', head:true }),
            sb.from('profiles').select('id', { count:'exact', head:true }).gte('created_at', since7),
            sb.from('profiles').select('id', { count:'exact', head:true }).gte('last_seen_at', since5m),
            sb.from('games').select('id', { count:'exact', head:true }).in('status', ['active','paused']),
            sb.from('games').select('id', { count:'exact', head:true }),
            sb.from('games').select('id', { count:'exact', head:true }).eq('status','completed'),
            sb.from('deposits').select('amount').eq('status','completed').gte('confirmed_at', since14),
            sb.from('withdrawals').select('amount').eq('status','completed').gte('processed_at', since14),
            sb.from('wallet_transactions').select('amount').eq('type','bet').gte('created_at', since14),
            sb.from('game_winners').select('prize_amount').in('status', ['verified','paid']).gte('claimed_at', since14),
            sb.from('public_winners').select('*').order('claimed_at', { ascending:false }).limit(8),
            sb.from('profiles').select('created_at').gte('created_at', since14),
            sb.from('wallet_transactions').select('type, amount, created_at').gte('created_at', since14)
        ]);

        document.getElementById('dTotalUsers').textContent     = U.num(totalUsers || 0);
        document.getElementById('dNewUsers').textContent       = U.num(newUsers || 0) + ' new this week';
        document.getElementById('dOnline').textContent         = U.num(online || 0);
        document.getElementById('dActiveGames').textContent    = U.num(activeGames || 0);
        document.getElementById('dTotalGames').textContent    = U.num(totalGames || 0) + ' total games';
        document.getElementById('dCompletedGames').textContent = U.num(completedGames || 0);
        document.getElementById('dDeposits').textContent      = U.money((deps || []).reduce((s,x)=>s+Number(x.amount||0),0), false);
        document.getElementById('dWithdrawals').textContent   = U.money((wds || []).reduce((s,x)=>s+Number(x.amount||0),0), false);
        document.getElementById('dRevenue').textContent       = U.money((bets || []).reduce((s,x)=>s+Math.abs(Number(x.amount||0)),0), false);
        document.getElementById('dPrizes').textContent        = U.money((wins || []).reduce((s,x)=>s+Number(x.prize_amount||0),0), false);

        // Recent winners mini-list
        const wbox = document.getElementById('dRecentWinners');
        wbox.innerHTML = (recentWinners || []).length
            ? recentWinners.map(w => `
                <div class="winner-row" style="padding:10px;margin-bottom:6px">
                    <div class="avatar" style="width:34px;height:34px;border-radius:9px;font-size:.75rem;background:linear-gradient(135deg,var(--brand),var(--brand-2))">
                        ${U.esc(U.initials(w.username))}
                    </div>
                    <div class="info">
                        <b style="font-size:.83rem">${U.esc(w.username)}</b>
                        <span style="font-size:.7rem">${U.esc(w.game_name)} · ${U.patternLabel(w.pattern)}</span>
                    </div>
                    <div class="winner-amount" style="font-size:.85rem">${U.money(w.prize_amount, false)}</div>
                </div>`).join('')
            : U.empty('🏆', 'No winners yet', 'Waiting for the first payout');

        Admin.drawDashboardCharts(profiles14 || [], tx14 || []);
    },

    drawDashboardCharts(profiles, txs) {
        if (!window.Chart) return;
        const days = 14;
        const labels = [];
        const mapUsers = {}, mapDep = {}, mapWit = {}, mapBets = {};

        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000);
            const key = d.toISOString().slice(0, 10);
            labels.push(d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }));
            mapUsers[key] = 0; mapDep[key] = 0; mapWit[key] = 0; mapBets[key] = 0;
        }

        profiles.forEach(p => { const k = new Date(p.created_at).toISOString().slice(0,10); if (k in mapUsers) mapUsers[k]++; });
        txs.forEach(t => {
            const k = new Date(t.created_at).toISOString().slice(0,10);
            if (!(k in mapDep)) return;
            if (t.type === 'deposit')    mapDep[k]  += Number(t.amount || 0);
            if (t.type === 'withdrawal') mapWit[k]  += Math.abs(Number(t.amount || 0));
            if (t.type === 'bet')        mapBets[k] += Math.abs(Number(t.amount || 0));
        });

        const palette = { brand:'#a855f7', gold:'#f5b400', success:'#10b981', danger:'#ef4444' };
        const textColor = document.documentElement.getAttribute('data-theme') === 'dark' ? '#b4b4d4' : '#3a3a60';
        const gridColor = document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,.05)' : 'rgba(15,15,45,.06)';

        const baseOpts = type => ({
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: textColor, font: { size: 11 } } } },
            scales: {
                x: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
                y: { beginAtZero: true, ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } }
            }
        });

        const kill = k => { if (STATE.charts[k]) { STATE.charts[k].destroy(); delete STATE.charts[k]; } };

        // Users
        kill('users');
        const uc = document.getElementById('chartUsers');
        if (uc) STATE.charts.users = new Chart(uc, {
            type: 'line',
            data: { labels, datasets: [{
                label: 'New registrations',
                data: Object.values(mapUsers),
                borderColor: palette.brand, backgroundColor: 'rgba(168,85,247,.15)',
                fill: true, tension: .35, borderWidth: 2, pointRadius: 3
            }]},
            options: baseOpts('line')
        });

        // Finance
        kill('finance');
        const fc = document.getElementById('chartFinance');
        if (fc) STATE.charts.finance = new Chart(fc, {
            type: 'bar',
            data: { labels, datasets: [
                { label: 'Deposits',    data: Object.values(mapDep), backgroundColor: palette.success },
                { label: 'Withdrawals', data: Object.values(mapWit), backgroundColor: palette.danger }
            ]},
            options: baseOpts('bar')
        });

        // Games
        kill('games');
        const gc = document.getElementById('chartGames');
        if (gc) STATE.charts.games = new Chart(gc, {
            type: 'bar',
            data: { labels, datasets: [{
                label: 'Ticket sales (ETB)',
                data: Object.values(mapBets),
                backgroundColor: palette.gold
            }]},
            options: baseOpts('bar')
        });
    },

    /* ------------------------------------------------------------------ */
    /* BINGO CALLER                                                        */
    /* ------------------------------------------------------------------ */
    async loadCallerGames() {
        const sel = document.getElementById('callerGameSelect');
        if (!sel) return;
        const { data } = await sb.from('game_lobby')
            .select('id, name, status, prize, ticket_price, player_count, winning_pattern, call_interval_seconds')
            .in('status', ['scheduled','open','active','paused'])
            .order('start_time', { ascending: true }).limit(50);

        const cur = sel.value;
        sel.innerHTML = `<option value="">— Choose an active or scheduled game —</option>` +
            (data || []).map(g => `<option value="${g.id}">${U.esc(g.name)} · ${U.statusLabel(g.status)} · ${g.player_count || 0} players</option>`).join('');
        if (cur) sel.value = cur;

        // Build the 1-75 board
        Admin.renderCallerBoard();

        // If we have a previously selected game, refresh it
        if (STATE.callerGameId) Admin.onCallerGameChange(true);
    },

    renderCallerBoard() {
        const grid = document.getElementById('callerNumGrid');
        if (!grid) return;
        let html = '';
        for (let n = 1; n <= 75; n++) {
            html += `<div class="num-cell" data-num="${n}">${n}</div>`;
        }
        grid.innerHTML = html;
    },

    async onCallerGameChange(silent) {
        const sel = document.getElementById('callerGameSelect');
        const id = sel?.value || '';
        STATE.callerGameId = id || null;

        // Clear previous
        if (STATE.callerTimer) { clearInterval(STATE.callerTimer); STATE.callerTimer = null; }
        if (STATE.channels.caller) { try { sb.removeChannel(STATE.channels.caller); } catch(e){} delete STATE.channels.caller; }

        if (!id) {
            Admin.updateCallerButtons({});
            document.getElementById('callerStatusPill').textContent = 'No game selected';
            document.getElementById('callerBall').className = 'big-ball';
            document.getElementById('callerLetter').textContent = '—';
            document.getElementById('callerNumber').textContent = '--';
            document.getElementById('callerCalledStrip').innerHTML = `<div class="empty" style="padding:16px"><p>No numbers called yet</p></div>`;
            document.getElementById('callerPlayersList').innerHTML = `<div class="empty" style="padding:16px"><p>No players yet</p></div>`;
            document.getElementById('callerClaims').innerHTML = `<div class="empty" style="padding:16px"><p>No claims yet</p></div>`;
            Admin.resetCallerBoard();
            return;
        }

        // Load full game
        const { data: g } = await sb.from('games').select('*').eq('id', id).maybeSingle();
        if (!g) return U.toast('Game not found', '', 'error');

        const { data: called } = await sb.from('called_numbers')
            .select('*').eq('game_id', id).order('sequence', { ascending: true });
        const calledList = called || [];
        const calledSet = new Set(calledList.map(c => c.number));

        // Update UI
        const pill = document.getElementById('callerStatusPill');
        pill.textContent = U.statusLabel(g.status);
        pill.className = 'pill ' + (g.status === 'active' ? 'pill-green' : g.status === 'paused' ? 'pill-yellow' : 'pill-blue');

        document.getElementById('callerPlayers').textContent = g.called_count == null ? 0 : g.called_count;
        document.getElementById('callerPrize').textContent = U.money(g.prize, false);
        document.getElementById('callerCalled').textContent = calledList.length;
        document.getElementById('callerRemaining').textContent = 75 - calledList.length;

        document.getElementById('callerInfoStatus').textContent = U.statusLabel(g.status);
        document.getElementById('callerInfoPattern').textContent = U.patternLabel(g.winning_pattern);
        document.getElementById('callerInfoTicket').textContent = U.money(g.ticket_price, false) + ' ETB';
        document.getElementById('callerInfoInterval').textContent = (g.call_interval_seconds || 8) + 's';
        document.getElementById('callerInfoStarted').textContent = g.started_at ? U.dateTime(g.started_at) : '—';

        const { data: players } = await sb.from('game_players')
            .select('id, user_id, status, profiles(username)').eq('game_id', id);
        document.getElementById('callerPlayers').textContent = (players || []).length;

        // Render board + strip
        document.querySelectorAll('#callerNumGrid .num-cell').forEach(el => {
            const n = Number(el.dataset.num);
            const on = calledSet.has(n);
            el.classList.toggle('called', on);
            if (on) el.classList.add(U.letterClass(U.letterFor(n)));
        });
        if (calledList.length) {
            const last = calledList[calledList.length - 1];
            const cell = document.querySelector(`#callerNumGrid .num-cell[data-num="${last.number}"]`);
            cell?.classList.add('latest');
            Admin.showCallerBall(last.number, last.letter, false);
        }
        Admin.renderCallerStrip(calledList);
        Admin.renderCallerPlayers(players || []);
        Admin.reloadCallerClaims();

        // Buttons
        Admin.updateCallerButtons(g, calledList.length);

        // Subscribe to changes
        const ch = sb.channel('caller:' + id)
            .on('postgres_changes', { event:'INSERT', schema:'public', table:'called_numbers', filter:`game_id=eq.${id}` },
                payload => {
                    const r = payload.new;
                    document.querySelectorAll('#callerNumGrid .num-cell').forEach(el => el.classList.remove('latest'));
                    const cell = document.querySelector(`#callerNumGrid .num-cell[data-num="${r.number}"]`);
                    if (cell) { cell.classList.add('called', U.letterClass(r.letter), 'latest'); }
                    Admin.showCallerBall(r.number, r.letter, true);
                    document.getElementById('callerCalled').textContent = r.sequence;
                    document.getElementById('callerRemaining').textContent = 75 - r.sequence;
                    Admin.refreshCallerStrip(id);
                    document.getElementById('btnUndo').disabled = false;
                })
            .on('postgres_changes', { event:'UPDATE', schema:'public', table:'games', filter:`id=eq.${id}` },
                payload => Admin.onCallerGameUpdated(payload.new))
            .on('postgres_changes', { event:'*', schema:'public', table:'game_players', filter:`game_id=eq.${id}` },
                () => Admin.reloadCallerPlayers(id))
            .on('postgres_changes', { event:'INSERT', schema:'public', table:'game_winners', filter:`game_id=eq.${id}` },
                () => { Admin.reloadCallerClaims(); U.toast('BINGO!', 'A winner has been verified', 'success'); })
            .subscribe();

        STATE.channels.caller = ch;

        // Local timer
        STATE.callerTimer = setInterval(() => {
            if (!document.getElementById('view-caller')?.classList.contains('active')) return;
            sb.from('games').select('called_count').eq('id', id).maybeSingle().then(({ data }) => {
                if (data) document.getElementById('callerCalled').textContent = data.called_count;
            });
        }, 10000);
    },

    onCallerGameUpdated(g) {
        const pill = document.getElementById('callerStatusPill');
        pill.textContent = U.statusLabel(g.status);
        pill.className = 'pill ' + (g.status === 'active' ? 'pill-green' : g.status === 'paused' ? 'pill-yellow' : 'pill-blue');
        document.getElementById('callerInfoStatus').textContent = U.statusLabel(g.status);
        document.getElementById('callerInfoStarted').textContent = g.started_at ? U.dateTime(g.started_at) : '—';
        Admin.updateCallerButtons(g);
    },

    showCallerBall(n, letter, animate) {
        const ball = document.getElementById('callerBall');
        if (!ball) return;
        ball.className = 'big-ball ball-' + U.letterClass(letter).toUpperCase().toLowerCase();
        document.getElementById('callerLetter').textContent = letter;
        document.getElementById('callerNumber').textContent = n;
        if (animate) {
            ball.classList.remove('pop');
            void ball.offsetWidth;
            ball.classList.add('pop');
        }
    },

    resetCallerBoard() {
        document.querySelectorAll('#callerNumGrid .num-cell').forEach(el => {
            el.className = 'num-cell';
        });
    },

    async refreshCallerStrip(id) {
        const { data } = await sb.from('called_numbers')
            .select('*').eq('game_id', id).order('sequence', { ascending: true });
        Admin.renderCallerStrip(data || []);
    },

    renderCallerStrip(list) {
        const box = document.getElementById('callerCalledStrip');
        if (!box) return;
        if (!list.length) {
            box.innerHTML = `<div class="empty" style="padding:16px"><p>No numbers called yet</p></div>`;
            return;
        }
        box.innerHTML = list.map((c, i) => {
            const cls = U.letterClass(c.letter);
            const latest = i === list.length - 1 ? 'style="box-shadow:0 0 0 3px var(--accent),0 0 16px rgba(245,180,0,.65)"' : '';
            return `<div class="chip-ball cb-${cls}" ${latest} style="background:${Admin.ballBg(cls)}"><small>${c.letter}</small>${c.number}</div>`;
        }).join('');
        box.scrollTop = box.scrollHeight;
    },

    ballBg(cls) {
        return ({
            b: 'linear-gradient(135deg,#dc2626,#ef4444)',
            i: 'linear-gradient(135deg,#d97706,#f59e0b)',
            n: 'linear-gradient(135deg,#059669,#10b981)',
            g: 'linear-gradient(135deg,#2563eb,#3b82f6)',
            o: 'linear-gradient(135deg,#7c3aed,#a855f7)'
        })[cls] || 'linear-gradient(135deg,#7c3aed,#a855f7)';
    },

    async reloadCallerPlayers(id) {
        const { data } = await sb.from('game_players')
            .select('id, user_id, status, profiles(username)').eq('game_id', id);
        Admin.renderCallerPlayers(data || []);
        document.getElementById('callerPlayers').textContent = (data || []).length;
    },

    renderCallerPlayers(list) {
        const box = document.getElementById('callerPlayersList');
        if (!box) return;
        box.innerHTML = list.length
            ? list.map(p => `
                <div class="winner-row" style="padding:8px 10px;margin-bottom:6px">
                    <div class="avatar" style="width:32px;height:32px;border-radius:9px;font-size:.72rem">
                        ${U.esc(U.initials(p.profiles?.username || '?'))}
                    </div>
                    <div class="info"><b style="font-size:.8rem">${U.esc(p.profiles?.username || 'Player')}</b></div>
                    <span class="pill ${p.status === 'won' ? 'pill-green' : p.status === 'lost' ? 'pill-grey' : 'pill-blue'}" style="font-size:.58rem">${U.statusLabel(p.status)}</span>
                </div>`).join('')
            : `<div class="empty" style="padding:14px"><p>No players yet</p></div>`;
    },

    async reloadCallerClaims() {
        const id = STATE.callerGameId;
        if (!id) return;
        const { data } = await sb.from('game_winners')
            .select('*, profiles(username)').eq('game_id', id)
            .order('claimed_at', { ascending: false });
        const box = document.getElementById('callerClaims');
        if (!box) return;
        const list = data || [];
        box.innerHTML = list.length
            ? list.map(w => `
                <div class="winner-row" style="padding:8px 10px;margin-bottom:6px">
                    <div class="avatar" style="width:32px;height:32px;border-radius:9px;font-size:.72rem;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#1a1200">🏆</div>
                    <div class="info">
                        <b style="font-size:.8rem">${U.esc(w.profiles?.username || 'Player')}</b>
                        <span style="font-size:.68rem">${U.patternLabel(w.pattern)} · ${U.money(w.prize_amount,false)} ETB</span>
                    </div>
                    <span class="pill ${w.status === 'paid' ? 'pill-green' : w.status === 'verified' ? 'pill-blue' : w.status === 'rejected' ? 'pill-red' : 'pill-yellow'}" style="font-size:.58rem">${U.statusLabel(w.status)}</span>
                </div>`).join('')
            : `<div class="empty" style="padding:14px"><p>No claims yet</p></div>`;
    },

    updateCallerButtons(g, calledCount) {
        const has = !!g.id;
        const isActive = has && g.status === 'active';
        const isPaused = has && g.status === 'paused';
        const isOpen   = has && g.status === 'open';

        document.getElementById('btnCallNext').disabled = !isActive;
        document.getElementById('btnPause').disabled    = !(isActive || isPaused);
        document.getElementById('btnPause').textContent = isPaused ? '▶ Resume' : '⏸ Pause';
        document.getElementById('btnUndo').disabled     = !(isActive || isPaused) || !calledCount;
        document.getElementById('btnStart').disabled    = !(has && (isOpen || g.status === 'scheduled'));
        document.getElementById('btnEnd').disabled      = !(isActive || isPaused);
        document.getElementById('btnCancel').disabled   = !has || ['completed','cancelled'].includes(g.status);
    },

    async callNext() {
        const id = STATE.callerGameId;
        if (!id) return;
        const btn = document.getElementById('btnCallNext');
        btn.disabled = true;
        const { data, error } = await sb.rpc('call_next_number', { p_game_id: id });
        btn.disabled = false;
        if (error) return U.toast('Call failed', error.message, 'error');
        if (!data?.success) return U.toast('Cannot call', data?.reason || 'Failed', 'error');
        // The realtime subscription will update the UI
    },

    async togglePause() {
        const id = STATE.callerGameId;
        if (!id) return;
        const btn = document.getElementById('btnPause');
        const goingToPause = !btn.textContent.includes('Resume');
        const target = goingToPause ? 'paused' : 'active';
        const { error } = await sb.rpc('set_game_status', { p_game_id: id, p_status: target });
        if (error) return U.toast('Failed', error.message, 'error');
        U.toast(target === 'paused' ? 'Game paused' : 'Game resumed', '', 'success');
    },

    async undoLast() {
        const id = STATE.callerGameId;
        if (!id) return;
        if (!confirm('Undo the last called number?')) return;
        const { data, error } = await sb.rpc('undo_last_number', { p_game_id: id });
        if (error) return U.toast('Failed', error.message, 'error');
        U.toast('Number undone', data?.undone || '', 'info');
        // Refresh UI
        Admin.onCallerGameChange(true);
    },

    async startGame() {
        const id = STATE.callerGameId;
        if (!id) return;
        const { error } = await sb.rpc('set_game_status', { p_game_id: id, p_status: 'active' });
        if (error) return U.toast('Failed', error.message, 'error');
        U.toast('Game started', 'You can now call numbers', 'success');
    },

    async endGame() {
        const id = STATE.callerGameId;
        if (!id) return;
        if (!confirm('End this game now? The game will be marked as completed.')) return;
        const { error } = await sb.rpc('set_game_status', { p_game_id: id, p_status: 'completed' });
        if (error) return U.toast('Failed', error.message, 'error');
        U.toast('Game ended', '', 'success');
    },

    async cancelGame() {
        const id = STATE.callerGameId;
        if (!id) return;
        const reason = prompt('Reason for cancelling this game?', 'Cancelled by staff');
        if (reason === null) return;
        const { data, error } = await sb.rpc('cancel_game', { p_game_id: id, p_reason: reason || 'Cancelled' });
        if (error) return U.toast('Failed', error.message, 'error');
        U.toast('Game cancelled', (data?.refunded_players || 0) + ' players refunded', 'warning');
    },

    /* ------------------------------------------------------------------ */
    /* GAME MANAGEMENT                                                     */
    /* ------------------------------------------------------------------ */
    async loadGames() {
        const { data, error } = await sb.from('game_lobby')
            .select('*').order('start_time', { ascending: false }).limit(200);
        if (error) return U.toast('Failed to load games', error.message, 'error');
        STATE.adminGames = data || [];
        Admin.renderGamesTable();
    },

    filterGamesTable() {
        STATE.adminGameFilter.search = (document.getElementById('gameSearchInput')?.value || '').trim().toLowerCase();
        STATE.adminGameFilter.status = document.getElementById('gameStatusFilter')?.value || '';
        Admin.renderGamesTable();
    },

    renderGamesTable() {
        const tbody = document.getElementById('gamesTableBody');
        if (!tbody) return;
        let list = STATE.adminGames.slice();
        const f = STATE.adminGameFilter;
        if (f.search) list = list.filter(g => (g.name || '').toLowerCase().includes(f.search));
        if (f.status) list = list.filter(g => g.status === f.status);

        if (!list.length) {
            tbody.innerHTML = U.emptyRow(8, '🎮', 'No games found', 'Try adjusting your filters');
            return;
        }
        tbody.innerHTML = list.map(g => `
            <tr>
                <td><b>${U.esc(g.name)}</b>${g.is_featured ? ' <span class="pill pill-yellow">FEATURED</span>' : ''}</td>
                <td><span class="status-badge status-${g.status}">${U.statusLabel(g.status)}</span></td>
                <td>${U.money(g.ticket_price, false)}</td>
                <td><b style="color:var(--accent-2)">${U.money(g.prize, false)}</b></td>
                <td>${g.player_count || 0} / ${g.max_players}</td>
                <td>${U.patternLabel(g.winning_pattern)}</td>
                <td>${U.dateTime(g.start_time)}</td>
                <td>
                    <div class="row-actions">
                        <button class="btn btn-ghost btn-sm" onclick="Admin.openGameForm('${g.id}')">Edit</button>
                        <button class="btn btn-outline btn-sm" onclick="Admin.pickCaller('${g.id}')">Open Caller</button>
                        ${g.status !== 'completed' && g.status !== 'cancelled'
                            ? `<button class="btn btn-danger btn-sm" onclick="Admin.cancelGameById('${g.id}')">Cancel</button>` : ''}
                    </div>
                </td>
            </tr>`).join('');
    },

    pickCaller(gameId) {
        Admin.go('caller');
        setTimeout(() => {
            const sel = document.getElementById('callerGameSelect');
            if (sel) { sel.value = gameId; Admin.onCallerGameChange(); }
        }, 200);
    },

    cancelGameById(id) {
        const reason = prompt('Reason for cancelling?', 'Cancelled by staff');
        if (reason === null) return;
        sb.rpc('cancel_game', { p_game_id: id, p_reason: reason || 'Cancelled' }).then(({ data, error }) => {
            if (error) return U.toast('Failed', error.message, 'error');
            U.toast('Game cancelled', (data?.refunded_players || 0) + ' players refunded', 'warning');
            Admin.loadGames();
        });
    },

    async openGameForm(gameId) {
        let g = null;
        if (gameId) {
            const { data } = await sb.from('games').select('*').eq('id', gameId).maybeSingle();
            g = data;
        }
        const isEdit = !!g;

        const patternOptions = ['single_line','two_lines','three_lines','four_corners','x','cross','full_house','custom'];
        const patternOptHtml = patternOptions.map(p =>
            `<option value="${p}" ${g?.winning_pattern === p ? 'selected' : ''}>${U.patternLabel(p)}</option>`).join('');

        const start = g?.start_time ? new Date(g.start_time) : new Date(Date.now() + 15 * 60000);
        const local = new Date(start.getTime() - start.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

        U.modal(`
            <h3>${isEdit ? 'Edit Game' : 'Create Game'}</h3>
            <p class="modal-sub">${isEdit ? 'Update game configuration' : 'Set up a new Bingo game'}</p>

            <div class="field">
                <label>Game Name</label>
                <input class="input" id="gfName" value="${U.esc(g?.name || '')}" placeholder="e.g. Friday Night Jackpot">
            </div>
            <div class="field">
                <label>Description</label>
                <textarea class="input" id="gfDescription" rows="2" placeholder="Short description for players">${U.esc(g?.description || '')}</textarea>
            </div>
            <div class="form-row">
                <div class="field">
                    <label>Ticket Price (ETB)</label>
                    <input class="input" type="number" id="gfTicket" min="0" step="1" value="${g?.ticket_price ?? 10}">
                </div>
                <div class="field">
                    <label>Prize (ETB)</label>
                    <input class="input" type="number" id="gfPrize" min="0" step="1" value="${g?.prize ?? 100}">
                </div>
            </div>
            <div class="form-row">
                <div class="field">
                    <label>Max Players</label>
                    <input class="input" type="number" id="gfMax" min="2" step="1" value="${g?.max_players ?? 200}">
                </div>
                <div class="field">
                    <label>Min Players</label>
                    <input class="input" type="number" id="gfMin" min="2" step="1" value="${g?.min_players ?? 2}">
                </div>
            </div>
            <div class="form-row">
                <div class="field">
                    <label>Start Time</label>
                    <input class="input" type="datetime-local" id="gfStart" value="${local}">
                </div>
                <div class="field">
                    <label>Call Interval (seconds)</label>
                    <input class="input" type="number" id="gfInterval" min="1" max="120" value="${g?.call_interval_seconds ?? 8}">
                </div>
            </div>
            <div class="form-row">
                <div class="field">
                    <label>Winning Pattern</label>
                    <select class="input" id="gfPattern">${patternOptHtml}</select>
                </div>
                <div class="field">
                    <label>Featured</label>
                    <select class="input" id="gfFeatured">
                        <option value="false" ${!g?.is_featured ? 'selected' : ''}>No</option>
                        <option value="true"  ${g?.is_featured ? 'selected' : ''}>Yes</option>
                    </select>
                </div>
            </div>

            <div class="modal-actions">
                <button class="btn btn-ghost" onclick="Admin.closeModal()">Cancel</button>
                <button class="btn btn-primary" id="gfSaveBtn" onclick="Admin.saveGame(${isEdit ? `'${gameId}'` : 'null'})">
                    ${isEdit ? 'Save Changes' : 'Create Game'}
                </button>
            </div>
        `);
    },

    async saveGame(gameId) {
        const payload = {
            p_name:               document.getElementById('gfName').value.trim(),
            p_description:        document.getElementById('gfDescription').value.trim() || null,
            p_ticket_price:       Number(document.getElementById('gfTicket').value),
            p_prize:              Number(document.getElementById('gfPrize').value),
            p_max_players:        Number(document.getElementById('gfMax').value),
            p_min_players:        Number(document.getElementById('gfMin').value),
            p_start_time:         new Date(document.getElementById('gfStart').value).toISOString(),
            p_winning_pattern:    document.getElementById('gfPattern').value,
            p_call_interval_seconds: Number(document.getElementById('gfInterval').value),
            p_is_featured:        document.getElementById('gfFeatured').value === 'true'
        };

        if (!payload.p_name) return U.toast('Name required', '', 'error');

        const btn = document.getElementById('gfSaveBtn');
        btn.disabled = true; btn.textContent = 'Saving…';

        let error;
        if (gameId) {
            const { error: e1, data: d1 } = await sb.rpc('update_game', {
                p_game_id: gameId,
                p_name: payload.p_name,
                p_description: payload.p_description,
                p_ticket_price: payload.p_ticket_price,
                p_prize: payload.p_prize,
                p_max_players: payload.p_max_players,
                p_start_time: payload.p_start_time,
                p_winning_pattern: payload.p_winning_pattern,
                p_call_interval_seconds: payload.p_call_interval_seconds,
                p_is_featured: payload.p_is_featured
            });
            error = e1;
            if (d1 && !d1.success) error = { message: d1.reason || 'Failed' };
        } else {
            const { error: e2 } = await sb.rpc('create_game', payload);
            error = e2;
        }

        btn.disabled = false;
        btn.textContent = gameId ? 'Save Changes' : 'Create Game';

        if (error) return U.toast('Save failed', error.message, 'error');

        U.toast('Saved', 'Game has been ' + (gameId ? 'updated' : 'created'), 'success');
        Admin.closeModal();
        Admin.loadGames();
    },

    closeModal() { U.closeModal(); },

    /* ------------------------------------------------------------------ */
    /* USER MANAGEMENT                                                     */
    /* ------------------------------------------------------------------ */
    async loadUsers() {
        const tbody = document.getElementById('usersTableBody');
        tbody.innerHTML = `<tr><td colspan="8" class="center-loading"><div class="spinner"></div> Loading…</td></tr>`;

        const status = document.getElementById('userStatusFilter')?.value || '';
        const q      = STATE.adminUsersSearch.trim();
        const from   = STATE.adminUsersPage * STATE.adminUsersPageSize;
        const to     = from + STATE.adminUsersPageSize - 1;

        let query = sb.from('profiles')
            .select('id, full_name, username, email, phone, status, created_at, referral_code, wallets(balance)',
                    { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(from, to);

        if (status) query = query.eq('status', status);
        if (q) {
            const like = '%' + q.replace(/%/g, '\\%') + '%';
            query = query.or(`username.ilike.${like},email.ilike.${like},phone.ilike.${like},full_name.ilike.${like}`);
        }

        const { data, error, count } = await query;
        if (error) {
            tbody.innerHTML = U.emptyRow(8, '⚠️', 'Failed to load users', error.message);
            return;
        }
        STATE.adminUsers = data || [];
        STATE.adminUsersTotal = count || 0;

        if (!STATE.adminUsers.length) {
            tbody.innerHTML = U.emptyRow(8, '👥', 'No users found', 'Try a different search');
        } else {
            tbody.innerHTML = STATE.adminUsers.map(u => {
                const bal = Number(u.wallets?.[0]?.balance ?? 0);
                return `
                    <tr>
                        <td><b>${U.esc(u.full_name || '—')}</b></td>
                        <td>@${U.esc(u.username || '—')}</td>
                        <td style="font-size:.78rem">${U.esc(u.email || '—')}</td>
                        <td style="font-size:.78rem">${U.esc(u.phone || '—')}</td>
                        <td><span class="pill ${u.status === 'active' ? 'pill-green' : u.status === 'suspended' ? 'pill-yellow' : u.status === 'banned' ? 'pill-red' : 'pill-grey'}">${U.statusLabel(u.status)}</span></td>
                        <td><b style="color:var(--accent-2)">${U.money(bal, false)}</b></td>
                        <td>${U.date(u.created_at)}</td>
                        <td>
                            <div class="row-actions">
                                <button class="btn btn-ghost btn-sm" onclick="Admin.openUserDetail('${u.id}')">View</button>
                                ${u.status === 'active'
                                    ? `<button class="btn btn-warning btn-sm" onclick="Admin.setUserStatus('${u.id}','suspended')">Suspend</button>`
                                    : `<button class="btn btn-success btn-sm" onclick="Admin.setUserStatus('${u.id}','active')">Activate</button>`}
                            </div>
                        </td>
                    </tr>`;
            }).join('');
        }

        document.getElementById('usersCount').textContent =
            `Showing ${from + 1}–${Math.min(from + STATE.adminUsersPageSize, STATE.adminUsersTotal)} of ${STATE.adminUsersTotal}`;
        document.getElementById('usersPrev').disabled = STATE.adminUsersPage === 0;
        document.getElementById('usersNext').disabled = (from + STATE.adminUsersPageSize) >= STATE.adminUsersTotal;
    },

    debouncedUserSearch: U.debounce(function () {
        STATE.adminUsersSearch = document.getElementById('userSearchInput').value || '';
        STATE.adminUsersPage = 0;
        Admin.loadUsers();
    }, 400),

    usersPage(dir) {
        STATE.adminUsersPage = Math.max(0, STATE.adminUsersPage + dir);
        Admin.loadUsers();
    },

    async openUserDetail(userId) {
        const [profileRes, walletRes, txRes, gamesRes, refsRes, rolesRes] = await Promise.all([
            sb.from('profiles').select('*').eq('id', userId).maybeSingle(),
            sb.from('wallets').select('*').eq('user_id', userId).maybeSingle(),
            sb.from('wallet_transactions').select('*').eq('user_id', userId)
                .order('created_at', { ascending: false }).limit(15),
            sb.from('game_players').select('*, games(name, prize, status)').eq('user_id', userId)
                .order('joined_at', { ascending: false }).limit(10),
            sb.from('referrals').select('*, referred:referred_id(username)').eq('referrer_id', userId).limit(10),
            sb.from('user_roles').select('roles(code)').eq('user_id', userId)
        ]);

        const p = profileRes.data || {};
        const w = walletRes.data || {};
        const tx = txRes.data || [];
        const games = gamesRes.data || [];
        const refs = refsRes.data || [];
        const roles = (rolesRes.data || []).map(r => r.roles?.code).filter(Boolean);

        U.modal(`
            <h3>${U.esc(p.full_name || p.username || 'User')}</h3>
            <p class="modal-sub">@${U.esc(p.username || '—')} · ${U.esc(p.email || '—')}</p>

            <div class="tabs" style="margin-bottom:14px">
                <button class="tab active" onclick="Admin.switchUserTab(this,'ud-overview')">Overview</button>
                <button class="tab" onclick="Admin.switchUserTab(this,'ud-tx')">Transactions</button>
                <button class="tab" onclick="Admin.switchUserTab(this,'ud-games')">Games</button>
                <button class="tab" onclick="Admin.switchUserTab(this,'ud-refs')">Referrals</button>
            </div>

            <div id="ud-overview">
                <div class="detail-grid">
                    <div>
                        <div class="detail-row"><span>Status</span><span>${U.statusLabel(p.status)}</span></div>
                        <div class="detail-row"><span>Balance</span><span>${U.money(w.balance || 0, false)} ETB</span></div>
                        <div class="detail-row"><span>Bonus</span><span>${U.money(w.bonus_balance || 0, false)} ETB</span></div>
                        <div class="detail-row"><span>Currency</span><span>${U.esc(w.currency || 'ETB')}</span></div>
                    </div>
                    <div>
                        <div class="detail-row"><span>Phone</span><span>${U.esc(p.phone || '—')}</span></div>
                        <div class="detail-row"><span>Referral Code</span><span>${U.esc(p.referral_code || '—')}</span></div>
                        <div class="detail-row"><span>Joined</span><span>${U.date(p.created_at)}</span></div>
                        <div class="detail-row"><span>Roles</span><span>${roles.join(', ') || 'PLAYER'}</span></div>
                    </div>
                </div>
            </div>

            <div id="ud-tx" style="display:none">
                ${tx.length ? tx.map(t => `
                    <div class="detail-row"><span>${U.esc(t.type)} · ${U.dateTime(t.created_at)}</span>
                    <span style="color:${Number(t.amount) > 0 ? 'var(--success-2)' : '#fca5a5'}">${Number(t.amount) > 0 ? '+' : ''}${U.money(t.amount, false)}</span></div>`).join('')
                    : '<p style="color:var(--text-3);text-align:center;padding:20px">No transactions</p>'}
            </div>

            <div id="ud-games" style="display:none">
                ${games.length ? games.map(g => `
                    <div class="detail-row"><span>${U.esc(g.games?.name || 'Game')} · ${U.date(g.joined_at)}</span>
                    <span>${U.statusLabel(g.status)}</span></div>`).join('')
                    : '<p style="color:var(--text-3);text-align:center;padding:20px">No games played</p>'}
            </div>

            <div id="ud-refs" style="display:none">
                ${refs.length ? refs.map(r => `
                    <div class="detail-row"><span>@${U.esc(r.referred?.username || 'user')}</span>
                    <span>${U.statusLabel(r.status)}</span></div>`).join('')
                    : '<p style="color:var(--text-3);text-align:center;padding:20px">No referrals</p>'}
            </div>

            <div class="modal-actions">
                ${p.status === 'active'
                    ? `<button class="btn btn-warning" onclick="Admin.setUserStatus('${userId}','suspended');Admin.closeModal()">Suspend User</button>
                       <button class="btn btn-danger"  onclick="Admin.setUserStatus('${userId}','banned');Admin.closeModal()">Ban User</button>`
                    : `<button class="btn btn-success" onclick="Admin.setUserStatus('${userId}','active');Admin.closeModal()">Activate User</button>`}
                <button class="btn btn-ghost" onclick="Admin.closeModal()">Close</button>
            </div>
        `, true);
    },

    switchUserTab(el, id) {
        document.querySelectorAll('#modalContent .tab').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        ['ud-overview','ud-tx','ud-games','ud-refs'].forEach(x => {
            const e = document.getElementById(x);
            if (e) e.style.display = x === id ? '' : 'none';
        });
    },

    async setUserStatus(userId, status) {
        if (!confirm('Set this user status to "' + status + '"?')) return;
        const { data, error } = await sb.rpc('admin_set_user_status', {
            p_user_id: userId, p_status: status
        });
        if (error) return U.toast('Failed', error.message, 'error');
        U.toast('User updated', 'Status: ' + status, 'success');
        Admin.loadUsers();
    },

    /* ------------------------------------------------------------------ */
    /* DEPOSITS                                                            */
    /* ------------------------------------------------------------------ */
    filterDeposits(status, el) {
        STATE.adminDepositFilter = status;
        document.querySelectorAll('#view-deposits .tab').forEach(t => t.classList.remove('active'));
        el?.classList.add('active');
        Admin.loadDeposits();
    },

    async loadDeposits() {
        const tbody = document.getElementById('depositsTableBody');
        tbody.innerHTML = `<tr><td colspan="7" class="center-loading"><div class="spinner"></div> Loading…</td></tr>`;

        let q = sb.from('deposits')
            .select('*, profiles!deposits_user_id_fkey(username, email)')
            .order('created_at', { ascending: false }).limit(150);
        if (STATE.adminDepositFilter) q = q.eq('status', STATE.adminDepositFilter);

        const { data, error } = await q;
        if (error) return tbody.innerHTML = U.emptyRow(7, '⚠️', 'Failed to load', error.message);

        if (!data?.length) return tbody.innerHTML = U.emptyRow(7, '💵', 'No deposits', 'Nothing here');

        tbody.innerHTML = data.map(d => `
            <tr>
                <td><b>@${U.esc(d.profiles?.username || '—')}</b><br><span style="font-size:.72rem;color:var(--text-3)">${U.esc(d.profiles?.email || '')}</span></td>
                <td><b style="color:var(--accent-2)">${U.money(d.amount, false)}</b></td>
                <td>${U.esc((d.provider || '').toUpperCase())}</td>
                <td style="font-size:.72rem">${U.esc(d.provider_reference || '—')}</td>
                <td><span class="pill ${d.status === 'completed' ? 'pill-green' : d.status === 'pending' ? 'pill-yellow' : d.status === 'failed' ? 'pill-red' : 'pill-blue'}">${U.statusLabel(d.status)}</span></td>
                <td>${U.dateTime(d.created_at)}</td>
                <td>
                    ${d.status === 'pending' ? `
                        <div class="row-actions">
                            <button class="btn btn-success btn-sm" onclick="Admin.processDeposit('${d.id}', true)">✓ Approve</button>
                            <button class="btn btn-danger btn-sm"  onclick="Admin.processDeposit('${d.id}', false)">✕ Reject</button>
                        </div>` : '—'}
                </td>
            </tr>`).join('');
    },

    async processDeposit(id, approve) {
        if (!confirm(approve ? 'Approve this deposit and credit the wallet?' : 'Reject this deposit request?')) return;
        const note = prompt('Note (optional):', '') || '';
        const { data, error } = await sb.rpc('process_deposit', {
            p_deposit_id: id,
            p_approve: approve,
            p_note: note
        });
        if (error) return U.toast('Failed', error.message, 'error');
        U.toast(approve ? 'Deposit approved' : 'Deposit rejected', '', 'success');
        Admin.loadDeposits();
        Admin.updateBadges();
    },

    /* ------------------------------------------------------------------ */
    /* WITHDRAWALS                                                         */
    /* ------------------------------------------------------------------ */
    filterWithdrawals(status, el) {
        STATE.adminWithdrawFilter = status;
        document.querySelectorAll('#view-withdrawals .tab').forEach(t => t.classList.remove('active'));
        el?.classList.add('active');
        Admin.loadWithdrawals();
    },

    async loadWithdrawals() {
        const tbody = document.getElementById('withdrawalsTableBody');
        tbody.innerHTML = `<tr><td colspan="8" class="center-loading"><div class="spinner"></div> Loading…</td></tr>`;

        let q = sb.from('withdrawals')
            .select('*, profiles!withdrawals_user_id_fkey(username, email)')
            .order('requested_at', { ascending: false }).limit(150);
        if (STATE.adminWithdrawFilter) q = q.eq('status', STATE.adminWithdrawFilter);

        const { data, error } = await q;
        if (error) return tbody.innerHTML = U.emptyRow(8, '⚠️', 'Failed to load', error.message);
        if (!data?.length) return tbody.innerHTML = U.emptyRow(8, '🏦', 'No withdrawals', 'Nothing here');

        tbody.innerHTML = data.map(w => `
            <tr>
                <td><b>@${U.esc(w.profiles?.username || '—')}</b></td>
                <td><b style="color:var(--accent-2)">${U.money(w.amount, false)}</b></td>
                <td>${U.money(w.net_amount || (w.amount - (w.fee||0)), false)}</td>
                <td>${U.esc((w.provider || '').toUpperCase())}</td>
                <td style="font-size:.72rem">${U.esc(w.destination || '—')}</td>
                <td><span class="pill ${w.status === 'completed' ? 'pill-green' : w.status === 'pending' ? 'pill-yellow' : w.status === 'rejected' ? 'pill-red' : 'pill-blue'}">${U.statusLabel(w.status)}</span></td>
                <td>${U.dateTime(w.requested_at)}</td>
                <td>
                    ${w.status === 'pending' ? `
                        <div class="row-actions">
                            <button class="btn btn-success btn-sm" onclick="Admin.processWithdrawal('${w.id}', true)">✓ Approve</button>
                            <button class="btn btn-danger btn-sm"  onclick="Admin.processWithdrawal('${w.id}', false)">✕ Reject</button>
                        </div>` : '—'}
                </td>
            </tr>`).join('');
    },

    async processWithdrawal(id, approve) {
        if (!confirm(approve ? 'Approve this withdrawal? Funds will be released.' : 'Reject this withdrawal? Funds will be returned to the wallet.')) return;
        const note = prompt('Note (optional):', '') || '';
        const ref  = approve ? (prompt('Provider reference (optional):', '') || null) : null;
        const { error } = await sb.rpc('process_withdrawal', {
            p_withdrawal_id: id,
            p_approve: approve,
            p_note: note,
            p_reference: ref
        });
        if (error) return U.toast('Failed', error.message, 'error');
        U.toast(approve ? 'Withdrawal approved' : 'Withdrawal rejected', '', 'success');
        Admin.loadWithdrawals();
        Admin.updateBadges();
    },

    /* ------------------------------------------------------------------ */
    /* TRANSACTIONS                                                        */
    /* ------------------------------------------------------------------ */
    debouncedTxSearch: U.debounce(function () {
        STATE.adminTxFilter.search = document.getElementById('txSearchInput').value || '';
        Admin.loadTransactions();
    }, 400),

    async loadTransactions() {
        const tbody = document.getElementById('transactionsTableBody');
        tbody.innerHTML = `<tr><td colspan="8" class="center-loading"><div class="spinner"></div> Loading…</td></tr>`;

        const type = document.getElementById('txTypeFilter')?.value || '';
        const search = (STATE.adminTxFilter.search || '').trim();

        let q = sb.from('wallet_transactions')
            .select('*, profiles!wallet_transactions_user_id_fkey(username)')
            .order('created_at', { ascending: false }).limit(200);
        if (type) q = q.eq('type', type);
        if (search) q = q.ilike('reference', '%' + search + '%');

        const { data, error } = await q;
        if (error) return tbody.innerHTML = U.emptyRow(8, '⚠️', 'Failed to load', error.message);
        if (!data?.length) return tbody.innerHTML = U.emptyRow(8, '🧾', 'No transactions', 'Nothing here');

        tbody.innerHTML = data.map(t => {
            const credit = Number(t.amount) > 0;
            return `
                <tr>
                    <td style="font-size:.72rem">${U.dateTime(t.created_at)}</td>
                    <td>@${U.esc(t.profiles?.username || '—')}</td>
                    <td><span class="pill pill-purple">${U.esc(t.type)}</span></td>
                    <td><b style="color:${credit ? 'var(--success-2)' : '#fca5a5'}">${credit ? '+' : ''}${U.money(t.amount, false)}</b></td>
                    <td>${U.money(t.balance_before, false)}</td>
                    <td>${U.money(t.balance_after, false)}</td>
                    <td><span class="pill ${t.status === 'completed' ? 'pill-green' : t.status === 'pending' ? 'pill-yellow' : 'pill-red'}">${U.statusLabel(t.status)}</span></td>
                    <td style="font-size:.72rem">${U.esc(t.reference || '—')}</td>
                </tr>`;
        }).join('');
    },

    /* ------------------------------------------------------------------ */
    /* PROMOTIONS                                                          */
    /* ------------------------------------------------------------------ */
    async loadPromotions() {
        const tbody = document.getElementById('promotionsTableBody');
        const { data, error } = await sb.from('promotions')
            .select('*').order('created_at', { ascending: false });
        if (error) return tbody.innerHTML = U.emptyRow(7, '⚠️', 'Failed to load', error.message);
        if (!data?.length) return tbody.innerHTML = U.emptyRow(7, '🎁', 'No promotions', 'Create one to get started');

        tbody.innerHTML = data.map(p => `
            <tr>
                <td><b>${U.esc(p.title)}</b></td>
                <td><span class="pill pill-purple">${U.esc(p.type.replace(/_/g,' '))}</span></td>
                <td>${p.bonus_amount > 0 ? U.money(p.bonus_amount, false) + ' ETB' : '—'}</td>
                <td>${U.date(p.start_date)}</td>
                <td>${p.end_date ? U.date(p.end_date) : '—'}</td>
                <td><span class="pill ${p.status === 'active' ? 'pill-green' : p.status === 'draft' ? 'pill-grey' : 'pill-yellow'}">${U.esc(p.status)}</span></td>
                <td>
                    <div class="row-actions">
                        <button class="btn btn-ghost btn-sm" onclick="Admin.openPromoForm('${p.id}')">Edit</button>
                        <button class="btn btn-danger btn-sm" onclick="Admin.deletePromotion('${p.id}')">Delete</button>
                    </div>
                </td>
            </tr>`).join('');
    },

    async openPromoForm(id) {
        let p = null;
        if (id) {
            const { data } = await sb.from('promotions').select('*').eq('id', id).maybeSingle();
            p = data;
        }
        const types = ['general','welcome_bonus','special_game','referral','jackpot','announcement'];
        const statuses = ['draft','active','paused','expired'];
        const typeOpts = types.map(t => `<option value="${t}" ${p?.type === t ? 'selected' : ''}>${t.replace(/_/g,' ')}</option>`).join('');
        const statusOpts = statuses.map(s => `<option value="${s}" ${p?.status === s ? 'selected' : ''}>${s}</option>`).join('');

        U.modal(`
            <h3>${id ? 'Edit Promotion' : 'Create Promotion'}</h3>
            <div class="field"><label>Title</label><input class="input" id="pfTitle" value="${U.esc(p?.title || '')}"></div>
            <div class="field"><label>Description</label><textarea class="input" id="pfDescription" rows="3">${U.esc(p?.description || '')}</textarea></div>
            <div class="form-row">
                <div class="field"><label>Type</label><select class="input" id="pfType">${typeOpts}</select></div>
                <div class="field"><label>Status</label><select class="input" id="pfStatus">${statusOpts}</select></div>
            </div>
            <div class="form-row">
                <div class="field"><label>Bonus Amount (ETB)</label><input class="input" type="number" id="pfBonus" value="${p?.bonus_amount || 0}" min="0" step="1"></div>
                <div class="field"><label>Bonus Type</label>
                    <select class="input" id="pfBonusType">
                        <option value="fixed" ${p?.bonus_type === 'fixed' ? 'selected' : ''}>Fixed</option>
                        <option value="percentage" ${p?.bonus_type === 'percentage' ? 'selected' : ''}>Percentage</option>
                    </select>
                </div>
            </div>
            <div class="field"><label>Image URL</label><input class="input" id="pfImage" value="${U.esc(p?.image_url || '')}" placeholder="https://…"></div>
            <div class="field"><label>Link</label><input class="input" id="pfLink" value="${U.esc(p?.link || '')}" placeholder="#games"></div>
            <div class="form-row">
                <div class="field"><label>Start</label><input class="input" type="datetime-local" id="pfStart" value="${p?.start_date ? new Date(new Date(p.start_date).getTime() - new Date(p.start_date).getTimezoneOffset() * 60000).toISOString().slice(0,16) : new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0,16)}"></div>
                <div class="field"><label>End</label><input class="input" type="datetime-local" id="pfEnd" value="${p?.end_date ? new Date(new Date(p.end_date).getTime() - new Date(p.end_date).getTimezoneOffset() * 60000).toISOString().slice(0,16) : ''}"></div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-ghost" onclick="Admin.closeModal()">Cancel</button>
                <button class="btn btn-primary" id="pfSaveBtn" onclick="Admin.savePromotion(${id ? `'${id}'` : 'null'})">${id ? 'Save' : 'Create'}</button>
            </div>
        `, true);
    },

    async savePromotion(id) {
        const body = {
            title: document.getElementById('pfTitle').value.trim(),
            description: document.getElementById('pfDescription').value.trim() || null,
            type: document.getElementById('pfType').value,
            status: document.getElementById('pfStatus').value,
            bonus_amount: Number(document.getElementById('pfBonus').value || 0),
            bonus_type: document.getElementById('pfBonusType').value,
            image_url: document.getElementById('pfImage').value.trim() || null,
            link: document.getElementById('pfLink').value.trim() || null,
            start_date: new Date(document.getElementById('pfStart').value).toISOString(),
            end_date: document.getElementById('pfEnd').value ? new Date(document.getElementById('pfEnd').value).toISOString() : null
        };
        if (!body.title) return U.toast('Title is required', '', 'error');

        const btn = document.getElementById('pfSaveBtn');
        btn.disabled = true; btn.textContent = 'Saving…';

        let error;
        if (id) {
            const r = await sb.from('promotions').update(body).eq('id', id);
            error = r.error;
        } else {
            const r = await sb.from('promotions').insert(body);
            error = r.error;
        }
        btn.disabled = false;
        if (error) return U.toast('Failed', error.message, 'error');
        U.toast('Saved', '', 'success');
        Admin.closeModal();
        Admin.loadPromotions();
    },

    async deletePromotion(id) {
        if (!confirm('Delete this promotion?')) return;
        const { error } = await sb.from('promotions').delete().eq('id', id);
        if (error) return U.toast('Failed', error.message, 'error');
        U.toast('Deleted', '', 'success');
        Admin.loadPromotions();
    },

    /* ------------------------------------------------------------------ */
    /* BANNERS                                                             */
    /* ------------------------------------------------------------------ */
    async loadBanners() {
        const tbody = document.getElementById('bannersTableBody');
        const { data, error } = await sb.from('banners').select('*').order('sort_order', { ascending: true });
        if (error) return tbody.innerHTML = U.emptyRow(6, '⚠️', 'Failed to load', error.message);
        if (!data?.length) return tbody.innerHTML = U.emptyRow(6, '🖼️', 'No banners', 'Create one');

        tbody.innerHTML = data.map(b => `
            <tr>
                <td><img src="${U.esc(b.image_url || '')}" style="width:100px;height:44px;object-fit:cover;border-radius:8px;border:1px solid var(--border)" onerror="this.style.display='none'"></td>
                <td><b>${U.esc(b.title)}</b><br><span style="font-size:.72rem;color:var(--text-3)">${U.esc(b.subtitle || '')}</span></td>
                <td>${U.esc(b.position)}</td>
                <td>${b.sort_order}</td>
                <td><span class="pill ${b.status === 'active' ? 'pill-green' : 'pill-grey'}">${U.esc(b.status)}</span></td>
                <td>
                    <div class="row-actions">
                        <button class="btn btn-ghost btn-sm" onclick="Admin.openBannerForm('${b.id}')">Edit</button>
                        <button class="btn btn-danger btn-sm" onclick="Admin.deleteBanner('${b.id}')">Delete</button>
                    </div>
                </td>
            </tr>`).join('');
    },

    async openBannerForm(id) {
        let b = null;
        if (id) b = (await sb.from('banners').select('*').eq('id', id).maybeSingle()).data;

        U.modal(`
            <h3>${id ? 'Edit Banner' : 'Create Banner'}</h3>
            <div class="field"><label>Title</label><input class="input" id="bfTitle" value="${U.esc(b?.title || '')}"></div>
            <div class="field"><label>Subtitle</label><input class="input" id="bfSubtitle" value="${U.esc(b?.subtitle || '')}"></div>
            <div class="field"><label>Image URL</label><input class="input" id="bfImage" value="${U.esc(b?.image_url || '')}" placeholder="https://…"></div>
            <div class="field"><label>Link</label><input class="input" id="bfLink" value="${U.esc(b?.link || '')}" placeholder="#games"></div>
            <div class="form-row">
                <div class="field"><label>Position</label><input class="input" id="bfPosition" value="${U.esc(b?.position || 'home_hero')}"></div>
                <div class="field"><label>Sort Order</label><input class="input" type="number" id="bfSort" value="${b?.sort_order ?? 0}"></div>
            </div>
            <div class="field"><label>Status</label>
                <select class="input" id="bfStatus">
                    <option value="active" ${b?.status === 'active' ? 'selected' : ''}>Active</option>
                    <option value="inactive" ${b?.status === 'inactive' ? 'selected' : ''}>Inactive</option>
                </select>
            </div>
            <div class="modal-actions">
                <button class="btn btn-ghost" onclick="Admin.closeModal()">Cancel</button>
                <button class="btn btn-primary" id="bfSaveBtn" onclick="Admin.saveBanner(${id ? `'${id}'` : 'null'})">${id ? 'Save' : 'Create'}</button>
            </div>
        `);
    },

    async saveBanner(id) {
        const body = {
            title: document.getElementById('bfTitle').value.trim(),
            subtitle: document.getElementById('bfSubtitle').value.trim() || null,
            image_url: document.getElementById('bfImage').value.trim() || null,
            link: document.getElementById('bfLink').value.trim() || null,
            position: document.getElementById('bfPosition').value.trim() || 'home_hero',
            sort_order: Number(document.getElementById('bfSort').value || 0),
            status: document.getElementById('bfStatus').value
        };
        if (!body.title) return U.toast('Title is required', '', 'error');
        const btn = document.getElementById('bfSaveBtn');
        btn.disabled = true; btn.textContent = 'Saving…';
        const r = id ? await sb.from('banners').update(body).eq('id', id)
                     : await sb.from('banners').insert(body);
        btn.disabled = false;
        if (r.error) return U.toast('Failed', r.error.message, 'error');
        U.toast('Saved', '', 'success');
        Admin.closeModal();
        Admin.loadBanners();
    },

    async deleteBanner(id) {
        if (!confirm('Delete this banner?')) return;
        const { error } = await sb.from('banners').delete().eq('id', id);
        if (error) return U.toast('Failed', error.message, 'error');
        Admin.loadBanners();
    },

    /* ------------------------------------------------------------------ */
    /* NOTIFICATIONS (admin)                                               */
    /* ------------------------------------------------------------------ */
    async loadAdminNotifications() {
        const tbody = document.getElementById('notificationsTableBody');
        const { data, error } = await sb.from('notifications')
            .select('*, profiles(username)')
            .order('created_at', { ascending: false }).limit(120);
        if (error) return tbody.innerHTML = U.emptyRow(5, '⚠️', 'Failed to load', error.message);
        if (!data?.length) return tbody.innerHTML = U.emptyRow(5, '🔔', 'No notifications', 'Send one to get started');

        tbody.innerHTML = data.map(n => `
            <tr>
                <td style="font-size:.72rem">${U.dateTime(n.created_at)}</td>
                <td>${n.user_id ? '@' + U.esc(n.profiles?.username || 'user') : '<span class="pill pill-purple">BROADCAST</span>'}</td>
                <td><b>${U.esc(n.title)}</b></td>
                <td><span class="pill pill-blue">${U.esc(n.type)}</span></td>
                <td>${n.is_read ? '✓' : '—'}</td>
            </tr>`).join('');
    },

    openNotifForm() {
        U.modal(`
            <h3>Send Notification</h3>
            <p class="modal-sub">Broadcast to all users or target a specific username</p>
            <div class="field"><label>Recipient Username (leave blank for broadcast)</label><input class="input" id="nfUser" placeholder="e.g. abebe123"></div>
            <div class="field"><label>Title</label><input class="input" id="nfTitle" placeholder="New game starting soon!"></div>
            <div class="field"><label>Message</label><textarea class="input" id="nfBody" rows="3" placeholder="Details…"></textarea></div>
            <div class="field"><label>Type</label>
                <select class="input" id="nfType">
                    <option value="announcement">Announcement</option>
                    <option value="promotion">Promotion</option>
                    <option value="system">System</option>
                </select>
            </div>
            <div class="modal-actions">
                <button class="btn btn-ghost" onclick="Admin.closeModal()">Cancel</button>
                <button class="btn btn-primary" id="nfSendBtn" onclick="Admin.sendNotification()">Send</button>
            </div>
        `);
    },

    async sendNotification() {
        const username = document.getElementById('nfUser').value.trim();
        const title = document.getElementById('nfTitle').value.trim();
        const body  = document.getElementById('nfBody').value.trim();
        const type  = document.getElementById('nfType').value;
        if (!title) return U.toast('Title required', '', 'error');

        let userId = null;
        if (username) {
            const { data: p } = await sb.from('profiles').select('id').eq('username', username).maybeSingle();
            if (!p) return U.toast('User not found', '', 'error');
            userId = p.id;
        }

        const btn = document.getElementById('nfSendBtn');
        btn.disabled = true; btn.textContent = 'Sending…';
        const { error } = await sb.from('notifications').insert({
            user_id: userId, title, body: body || null, type
        });
        btn.disabled = false;
        if (error) return U.toast('Failed', error.message, 'error');
        U.toast('Notification sent', '', 'success');
        Admin.closeModal();
        Admin.loadAdminNotifications();
    },

    /* ------------------------------------------------------------------ */
    /* REFERRALS (admin)                                                   */
    /* ------------------------------------------------------------------ */
    async loadAdminReferrals() {
        const tbody = document.getElementById('referralsTableBody');
        const { data, error } = await sb.from('referrals')
            .select('*, referrer:referrer_id(username), referred:referred_id(username), referral_rewards(amount, status)')
            .order('created_at', { ascending: false }).limit(200);
        if (error) return tbody.innerHTML = U.emptyRow(6, '⚠️', 'Failed to load', error.message);

        const list = data || [];
        document.getElementById('aRefTotal').textContent = list.length;
        document.getElementById('aRefQualified').textContent = list.filter(r => r.status === 'qualified' || r.status === 'rewarded').length;
        const totalPaid = list.reduce((s, r) => s + (r.referral_rewards || []).filter(x => x.status === 'paid').reduce((a,x) => a + Number(x.amount || 0), 0), 0);
        document.getElementById('aRefPaid').textContent = U.money(totalPaid, false);

        if (!list.length) return tbody.innerHTML = U.emptyRow(6, '🤝', 'No referrals yet', 'Users who invite friends will appear here');

        tbody.innerHTML = list.map(r => {
            const reward = (r.referral_rewards || [])[0];
            return `
                <tr>
                    <td>@${U.esc(r.referrer?.username || '—')}</td>
                    <td>@${U.esc(r.referred?.username || '—')}</td>
                    <td><code style="font-size:.75rem">${U.esc(r.code)}</code></td>
                    <td><span class="pill ${r.status === 'rewarded' ? 'pill-green' : r.status === 'qualified' ? 'pill-blue' : 'pill-yellow'}">${U.statusLabel(r.status)}</span></td>
                    <td>${reward ? U.money(reward.amount, false) + ' (' + reward.status + ')' : '—'}</td>
                    <td>${U.date(r.created_at)}</td>
                </tr>`;
        }).join('');
    },

    /* ------------------------------------------------------------------ */
    /* REPORTS                                                             */
    /* ------------------------------------------------------------------ */
    async loadReports() {
        const days = Number(document.getElementById('reportRange')?.value || 30);
        const since = new Date(Date.now() - days * 86400000).toISOString();

        const [deps, wds, bets, wins, topWinners] = await Promise.all([
            sb.from('wallet_transactions').select('amount, created_at').eq('type','deposit').eq('status','completed').gte('created_at', since),
            sb.from('wallet_transactions').select('amount, created_at').eq('type','withdrawal').eq('status','completed').gte('created_at', since),
            sb.from('wallet_transactions').select('amount, created_at').eq('type','bet').gte('created_at', since),
            sb.from('wallet_transactions').select('amount, created_at').eq('type','win').eq('status','completed').gte('created_at', since),
            sb.from('game_winners')
                .select('user_id, prize_amount, profiles(username)')
                .in('status', ['verified','paid'])
                .gte('claimed_at', since)
        ]);

        const dList = deps.data || [];
        const wList = wds.data || [];
        const bList = bets.data || [];
        const pList = wins.data || [];

        document.getElementById('rDeposits').textContent    = U.money(dList.reduce((s,x)=>s+Number(x.amount||0),0), false);
        document.getElementById('rWithdrawals').textContent = U.money(wList.reduce((s,x)=>s+Math.abs(Number(x.amount||0)),0), false);
        document.getElementById('rRevenue').textContent     = U.money(bList.reduce((s,x)=>s+Math.abs(Number(x.amount||0)),0), false);
        document.getElementById('rPrizes').textContent      = U.money(pList.reduce((s,x)=>s+Number(x.amount||0),0), false);

        // Group by day
        const byDay = {};
        const mkKey = d => new Date(d).toISOString().slice(0,10);
        for (let i = days - 1; i >= 0; i--) {
            const k = mkKey(Date.now() - i * 86400000);
            byDay[k] = { dep: 0, wit: 0, bet: 0 };
        }
        dList.forEach(x => { const k = mkKey(x.created_at); if (byDay[k]) byDay[k].dep += Number(x.amount||0); });
        wList.forEach(x => { const k = mkKey(x.created_at); if (byDay[k]) byDay[k].wit += Math.abs(Number(x.amount||0)); });
        bList.forEach(x => { const k = mkKey(x.created_at); if (byDay[k]) byDay[k].bet += Math.abs(Number(x.amount||0)); });

        const labels = Object.keys(byDay).map(k => new Date(k).toLocaleDateString('en-GB', { day:'2-digit', month:'short' }));

        if (window.Chart) {
            const textColor = document.documentElement.getAttribute('data-theme') === 'dark' ? '#b4b4d4' : '#3a3a60';
            const gridColor = document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,.05)' : 'rgba(15,15,45,.06)';
            const opts = () => ({
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { labels: { color: textColor, font: { size: 11 } } } },
                scales: {
                    x: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
                    y: { beginAtZero: true, ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } }
                }
            });

            if (STATE.charts.rFin) STATE.charts.rFin.destroy();
            STATE.charts.rFin = new Chart(document.getElementById('reportFinanceChart'), {
                type: 'line',
                data: { labels, datasets: [
                    { label: 'Deposits',    data: Object.values(byDay).map(x=>x.dep), borderColor: '#10b981', fill: false, tension: .3 },
                    { label: 'Withdrawals', data: Object.values(byDay).map(x=>x.wit), borderColor: '#ef4444', fill: false, tension: .3 }
                ]},
                options: opts()
            });

            if (STATE.charts.rRev) STATE.charts.rRev.destroy();
            STATE.charts.rRev = new Chart(document.getElementById('reportRevenueChart'), {
                type: 'bar',
                data: { labels, datasets: [{ label: 'Ticket Sales', data: Object.values(byDay).map(x=>x.bet), backgroundColor: '#f5b400' }] },
                options: opts()
            });
        }

        // Top winners
        const map = {};
        (topWinners.data || []).forEach(w => {
            const u = w.profiles?.username || 'user';
            if (!map[u]) map[u] = { wins: 0, total: 0 };
            map[u].wins++;
            map[u].total += Number(w.prize_amount || 0);
        });
        const rows = Object.entries(map).map(([u,v]) => ({u, ...v}))
            .sort((a,b) => b.total - a.total).slice(0, 10);
        document.getElementById('topWinnersBody').innerHTML = rows.length
            ? rows.map(r => `<tr><td>@${U.esc(r.u)}</td><td>${r.wins}</td><td><b style="color:var(--accent-2)">${U.money(r.total, false)}</b></td></tr>`).join('')
            : U.emptyRow(3, '🏆', 'No winners in this period', '');
    },

    /* ------------------------------------------------------------------ */
    /* AUDIT LOG                                                           */
    /* ------------------------------------------------------------------ */
    debouncedAuditSearch: U.debounce(function () {
        STATE.adminAuditFilter.search = document.getElementById('auditSearchInput').value || '';
        Admin.loadAudit();
    }, 400),

    async loadAudit() {
        const tbody = document.getElementById('auditTableBody');
        const action = document.getElementById('auditActionFilter')?.value || '';
        const search = (STATE.adminAuditFilter.search || '').trim();

        let q = sb.from('audit_logs')
            .select('*').order('created_at', { ascending: false }).limit(200);
        if (action) q = q.eq('action', action);
        if (search) q = q.ilike('actor_email', '%' + search + '%');

        const { data, error } = await q;
        if (error) return tbody.innerHTML = U.emptyRow(6, '⚠️', 'Failed to load', error.message);
        if (!data?.length) return tbody.innerHTML = U.emptyRow(6, '🛡️', 'No audit entries', 'Actions will show up here');

        tbody.innerHTML = data.map(a => `
            <tr>
                <td style="font-size:.72rem;white-space:nowrap">${U.dateTime(a.created_at)}</td>
                <td>${U.esc(a.actor_email || a.actor_id?.slice(0,8) || '—')}</td>
                <td>${a.actor_role ? `<span class="pill pill-purple">${U.esc(a.actor_role)}</span>` : '—'}</td>
                <td><b>${U.esc(a.action)}</b></td>
                <td style="font-size:.72rem">${U.esc(a.entity_type || '—')}</td>
                <td style="font-size:.72rem;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    ${U.esc(JSON.stringify(a.details || {}).slice(0, 120))}
                </td>
            </tr>`).join('');
    },

    /* ------------------------------------------------------------------ */
    /* SETTINGS                                                            */
    /* ------------------------------------------------------------------ */
    async loadSettings() {
        const { data } = await sb.from('system_settings').select('*');
        const map = {};
        (data || []).forEach(s => { map[s.key] = s.value; });
        STATE.settings = map;

        document.getElementById('setCurrency').value          = map.currency?.code || 'ETB';
        document.getElementById('setMinDeposit').value        = map.min_deposit?.amount ?? 10;
        document.getElementById('setMaxDeposit').value        = map.max_deposit?.amount ?? 100000;
        document.getElementById('setMinWithdrawal').value     = map.min_withdrawal?.amount ?? 50;
        document.getElementById('setWithdrawalFee').value     = map.withdrawal_fee?.amount ?? 0;
        document.getElementById('setWelcomeBonus').value      = map.welcome_bonus?.amount ?? 20;
        document.getElementById('setWelcomeEnabled').value    = String(map.welcome_bonus?.enabled ?? true);
        document.getElementById('setReferralReward').value    = map.referral_reward?.amount ?? 25;
        document.getElementById('setReferralEnabled').value   = String(map.referral_reward?.enabled ?? true);
        document.getElementById('setCallInterval').value      = map.default_call_interval?.seconds ?? 8;
        document.getElementById('setJackpot').value           = map.jackpot?.amount ?? 125000;
        document.getElementById('setProviders').value         = (map.payment_providers?.list || ['telebirr','chapa','cbe_birr']).join(',');
        document.getElementById('setPlatformName').value      = map.platform?.name || 'Bingo Ethiopia';
        document.getElementById('setSupportEmail').value      = map.platform?.support_email || 'support@bingo.et';
        document.getElementById('setSupportPhone').value      = map.platform?.support_phone || '';
    },

    async saveSettings() {
        const updates = [
            { key: 'currency', value: { code: document.getElementById('setCurrency').value.trim() || 'ETB', symbol: 'Br' } },
            { key: 'min_deposit', value: { amount: Number(document.getElementById('setMinDeposit').value) } },
            { key: 'max_deposit', value: { amount: Number(document.getElementById('setMaxDeposit').value) } },
            { key: 'min_withdrawal', value: { amount: Number(document.getElementById('setMinWithdrawal').value) } },
            { key: 'withdrawal_fee', value: { amount: Number(document.getElementById('setWithdrawalFee').value) } },
            { key: 'welcome_bonus', value: { enabled: document.getElementById('setWelcomeEnabled').value === 'true', amount: Number(document.getElementById('setWelcomeBonus').value) } },
            { key: 'referral_reward', value: { enabled: document.getElementById('setReferralEnabled').value === 'true', amount: Number(document.getElementById('setReferralReward').value) } },
            { key: 'default_call_interval', value: { seconds: Number(document.getElementById('setCallInterval').value) } },
            { key: 'jackpot', value: { amount: Number(document.getElementById('setJackpot').value), currency: 'ETB' } },
            { key: 'payment_providers', value: { list: document.getElementById('setProviders').value.split(',').map(x => x.trim()).filter(Boolean) } },
            { key: 'platform', value: {
                name: document.getElementById('setPlatformName').value.trim() || 'Bingo Ethiopia',
                support_email: document.getElementById('setSupportEmail').value.trim(),
                support_phone: document.getElementById('setSupportPhone').value.trim()
            }}
        ];

        for (const u of updates) {
            const { error } = await sb.from('system_settings')
                .upsert({ key: u.key, value: u.value }, { onConflict: 'key' });
            if (error) return U.toast('Failed to save ' + u.key, error.message, 'error');
        }

        U.toast('Settings saved', '', 'success');
        STATE.settings = {};
        updates.forEach(u => STATE.settings[u.key] = u.value);
    }
};

window.Admin = Admin;

/* =============================================================================
 * 18. BOOT
 * ============================================================================= */

async function boot() {
    // Theme
    let theme = 'dark';
    try { theme = localStorage.getItem('bingo_theme') || 'dark'; } catch (e) {}
    U.applyTheme(theme);

    // Footer year
    const fy = document.getElementById('footerYear');
    if (fy) fy.textContent = new Date().getFullYear();

    // Referral capture from ?ref=CODE
    try {
        const params = new URLSearchParams(window.location.search);
        const ref = params.get('ref');
        if (ref && PAGE === 'player') {
            const el = document.getElementById('regReferral');
            if (el && !el.value) el.value = ref.toUpperCase();
            // auto-open register if not signed in
            const { data: { session } } = await sb.auth.getSession();
            if (!session) {
                setTimeout(() => App.go('register'), 300);
            }
        }
    } catch (e) {}

    // Initial session
    const { data: { session } } = await sb.auth.getSession();

    if (PAGE === 'admin') {
        if (session?.user) {
            await Auth.hydrate(session.user);
            if (Auth.isStaff()) {
                Admin.enter();
            } else {
                await Auth.logout();
            }
        }
        // Watch auth changes
        sb.auth.onAuthStateChange(async (_ev, sess) => {
            if (sess?.user) {
                await Auth.hydrate(sess.user);
                if (Auth.isStaff() && !document.getElementById('adminApp').classList.contains('ready')) {
                    Admin.enter();
                }
            }
        });
    } else {
        if (session?.user) {
            await Auth.hydrate(session.user);
        }
        App.refreshAuthUI();
        App.startRealtimeNotifications();
        App.loadHome();

        // Watch auth changes
        sb.auth.onAuthStateChange(async (_ev, sess) => {
            if (sess?.user) {
                await Auth.hydrate(sess.user);
                App.refreshAuthUI();
                App.startRealtimeNotifications();
                // Update last_seen
                sb.from('profiles')
                  .update({ last_seen_at: new Date().toISOString(), is_online: true })
                  .eq('id', sess.user.id)
                  .then(() => {});
            } else {
                STATE.user = null; STATE.profile = null; STATE.wallet = null; STATE.roles = [];
                App.refreshAuthUI();
            }
        });

        // Heartbeat
        setInterval(() => {
            if (STATE.user) {
                sb.from('profiles')
                  .update({ last_seen_at: new Date().toISOString() })
                  .eq('id', STATE.user.id)
                  .then(() => {});
            }
        }, 120000);
    }
}

// Run boot after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

})();
