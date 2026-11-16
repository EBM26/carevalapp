// Password protection for the whole site: every page, asset and /api route.
//
// Secrets (Pages → Settings → Variables and Secrets, or .dev.vars locally):
//   APP_PASSWORD    the password you type to sign in
//   SESSION_SECRET  random string, ≥ 32 chars, used only to sign the cookie
//
// Routes handled here:
//   POST /auth/login   form post { password, next } → sets cookie, redirects
//   GET  /auth/logout  clears cookie, redirects to /
// Unauthenticated: /api/* → 401 JSON; anything else → login page.
import { configError, passwordMatches, createSession, verifySession, SESSION_SECONDS } from '../public/auth.js';
import { STRINGS } from '../public/i18n.js';

// Served without a session so the login page can show its tab icon.
const PUBLIC_PATHS = new Set(['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png']);

// Production (https) uses a __Host- cookie, which browsers only accept with
// Secure, Path=/ and no Domain. Plain-http local dev can't set Secure cookies
// on every browser, so it falls back to an unprefixed, non-Secure cookie.
function cookieSpec(url) {
  const https = url.protocol === 'https:';
  return { name: https ? '__Host-session' : 'session', attrs: `Path=/; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}` };
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Only same-site relative paths, to avoid an open redirect. */
function safeNext(next) {
  const s = String(next || '/');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') && !s.startsWith('/auth/') && !/[\r\n]/.test(s) ? s : '/';
}

const json = (data, status) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

function pickLang(request) {
  return /^he\b|,\s*he\b/i.test(request.headers.get('accept-language') || '') ? 'he' : 'en';
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Login page. Rendered on the server in the Accept-Language language; a tiny
 * inline script then switches to the language saved by the app (localStorage
 * 'lang', same origin) and offers the same EN/HE toggle as the app header.
 */
function loginPage({ lang, next, errorKey, status }) {
  const keys = ['appTitle', 'langToggle', 'login.title', 'login.password', 'login.submit', 'login.wrong', 'login.notConfigured'];
  const pick = (l) => Object.fromEntries(keys.map((k) => [k, STRINGS[l][k]]));
  const strings = { en: pick('en'), he: pick('he') };
  const s = strings[lang];
  const html = `<!doctype html>
<html lang="${lang}" dir="${lang === 'he' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<meta name="robots" content="noindex">
<title>${esc(s.appTitle)}</title>
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  :root { --bg:#fff; --fg:#16181d; --muted:#5f6672; --line:#e3e6ea; --accent:#1f5fd6; --red:#c4262e; color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Arial, "Noto Sans Hebrew", sans-serif; }
  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 10px 16px; padding-block-start: max(10px, env(safe-area-inset-top)); border-block-end: 1px solid var(--line); }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 18px; }
  .brand img { width: 24px; height: 24px; }
  .ghost { appearance: none; border: 0; background: none; color: var(--accent); font: inherit; font-size: 15px; cursor: pointer; padding: 9px 4px; }
  main { max-width: 360px; margin: 12vh auto 0; padding: 0 16px; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
  input { font: inherit; font-size: 16px; width: 100%; min-height: 46px; padding: 8px 12px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); }
  input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
  button[type=submit] { margin-top: 14px; width: 100%; min-height: 46px; border: 0; border-radius: 10px;
    background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .error { color: var(--red); font-size: 14px; margin: 0 0 12px; }
</style>
</head>
<body>
<header class="topbar">
  <span class="brand"><img src="/favicon.svg" alt=""><span data-k="appTitle">${esc(s.appTitle)}</span></span>
  <button type="button" class="ghost" id="langToggle" data-k="langToggle">${esc(s.langToggle)}</button>
</header>
<main>
  <h1 data-k="login.title">${esc(s['login.title'])}</h1>
  ${errorKey ? `<p class="error" role="alert" data-k="${errorKey}">${esc(s[errorKey])}</p>` : ''}
  <form method="post" action="/auth/login">
    <input type="hidden" name="next" value="${esc(next)}">
    <label><span data-k="login.password">${esc(s['login.password'])}</span>
      <input type="password" name="password" autocomplete="current-password" required autofocus>
    </label>
    <button type="submit" data-k="login.submit">${esc(s['login.submit'])}</button>
  </form>
</main>
<script>
(function () {
  var S = ${JSON.stringify(strings).replace(/</g, '\\u003c')};
  var lang;
  try { lang = localStorage.getItem('lang'); } catch (e) {}
  function apply(l) {
    if (!S[l]) return;
    lang = l;
    document.documentElement.lang = l;
    document.documentElement.dir = l === 'he' ? 'rtl' : 'ltr';
    document.title = S[l].appTitle;
    document.querySelectorAll('[data-k]').forEach(function (el) { el.textContent = S[l][el.getAttribute('data-k')]; });
  }
  if (lang) apply(lang); else lang = document.documentElement.lang;
  // The #/route part of the URL never reaches the server; carry it through login.
  var nextInput = document.querySelector('input[name=next]');
  // (Plain string checks: this script lives in a template literal, where regex backslashes would be eaten.)
  var hash = location.hash;
  if (hash.indexOf('#/') === 0 && hash.length < 100 && nextInput.value.indexOf('#') < 0) nextInput.value += hash;
  document.getElementById('langToggle').addEventListener('click', function () {
    apply(lang === 'he' ? 'en' : 'he');
    try { localStorage.setItem('lang', lang); } catch (e) {}
  });
})();
</script>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' },
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (PUBLIC_PATHS.has(path)) return next();

  const isApi = path.startsWith('/api/');
  const lang = pickLang(request);
  const cookie = cookieSpec(url);

  // Fail closed if the secrets aren't set up.
  const misconfigured = configError(env);
  if (misconfigured) {
    return isApi
      ? json({ error: 'auth_not_configured', detail: misconfigured }, 503)
      : loginPage({ lang, next: '/', errorKey: 'login.notConfigured', status: 503 });
  }

  if (path === '/auth/logout') {
    return new Response(null, {
      status: 303,
      headers: { location: '/', 'set-cookie': `${cookie.name}=; ${cookie.attrs}; Max-Age=0`, 'cache-control': 'no-store' },
    });
  }

  if (path === '/auth/login') {
    if (request.method !== 'POST') return Response.redirect(new URL('/', url), 303);
    let form;
    try { form = await request.formData(); } catch { form = new FormData(); }
    const target = safeNext(form.get('next'));
    if (await passwordMatches(form.get('password'), env)) {
      const token = await createSession(env);
      return new Response(null, {
        status: 303,
        headers: {
          location: target,
          'set-cookie': `${cookie.name}=${token}; ${cookie.attrs}; Max-Age=${SESSION_SECONDS}`,
          'cache-control': 'no-store',
        },
      });
    }
    // Slow down guessing a little. (No lockout: there's no shared state.)
    await new Promise((r) => setTimeout(r, 600));
    return loginPage({ lang, next: target, errorKey: 'login.wrong', status: 401 });
  }

  if (await verifySession(readCookie(request, cookie.name), env)) return next();

  return isApi
    ? json({ error: 'unauthorized' }, 401)
    : loginPage({ lang, next: safeNext(path + url.search), errorKey: null, status: 401 });
}
