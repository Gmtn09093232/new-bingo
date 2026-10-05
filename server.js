/* =============================================================================
 *  server.js  —  Tiny static file server for the Bingo platform on Render.
 *  It only serves the 4 core files (index.html, admin.html, app.js, database.sql)
 *  and any other static assets. All real backend logic lives in Supabase.
 * ============================================================================= */

const express     = require('express');
const compression = require('compression');
const path        = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

app.disable('x-powered-by');
app.use(compression());

/* ---------- Security headers ---------- */
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options',        'SAMEORIGIN');
    res.setHeader('Referrer-Policy',        'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy',     'geolocation=(), microphone=(), camera=()');
    next();
});

/* ---------- Explicit routes (clean URLs) ---------- */
app.get('/admin',  (req, res) => res.sendFile(path.join(ROOT, 'admin.html')));
app.get('/admin/', (req, res) => res.sendFile(path.join(ROOT, 'admin.html')));

/* ---------- Cache policy ---------- */
app.use(express.static(ROOT, {
    extensions: ['html'],
    setHeaders(res, filePath) {
        // Never cache the HTML shell or app.js so updates roll out instantly
        if (/\.(html?|js)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=86400');
        }
    }
}));

/* ---------- Health check (Render pings this) ---------- */
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

/* ---------- SPA-style fallback: unknown paths → home ---------- */
app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).send('Not found');
    res.sendFile(path.join(ROOT, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Bingo platform serving on port ${PORT}`);
});
