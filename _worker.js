// KMLナビ server (Cloudflare Pages, advanced mode).
// Static files come from the site; /api/* handles payment (Stripe), purchase codes and HERE (the key stays here).
//
// Environment variables (Cloudflare Pages > Settings > Variables and Secrets):
//   STRIPE_SECRET_KEY  Stripe secret key (sk_live_... / rk_live_...)
//   STRIPE_PRICE_NAVI  Stripe price id of 「KMLナビ プロ」 (price_...)
//   HERE_API_KEY       HERE API key
//   LICENSE_SECRET     any long random text (signs the purchase codes)
//   TRIAL_DAYS         optional, free days for new subscribers (default 30)
//   FIRST_CHARGE_FROM  optional, no first charge before this time (default 2027-01-01T00:00:00+09:00)
//   FREE_DAILY         optional, HERE calls per day for free users (default 300)
// Optional KV binding KN_KV: counts free HERE calls per day.

const STRIPE = 'https://api.stripe.com/v1/';
const OK_STATUS = ['active', 'trialing', 'past_due'];
const cache = new Map();   // per-isolate memo: price, subscription checks

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}
function b64u(buf) {
  let s = ''; const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  return atob(s);
}
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u((await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))).slice(0, 18));
}
// purchase code = KN1.<subscription id>.<signature>
async function makeCode(env, subId) { return 'KN1.' + b64u(new TextEncoder().encode(subId)) + '.' + await hmac(env.LICENSE_SECRET, subId); }
async function readCode(env, code) {
  const m = /^KN1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(code || '').trim());
  if (!m || !env.LICENSE_SECRET) return null;
  let subId; try { subId = unb64u(m[1]); } catch (e) { return null; }
  if (!/^sub_[A-Za-z0-9]+$/.test(subId)) return null;
  const sig = await hmac(env.LICENSE_SECRET, subId);
  if (sig.length !== m[2].length) return null;
  let diff = 0; for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0 ? subId : null;
}
async function stripe(env, path, params, method) {
  const opt = { method: method || (params ? 'POST' : 'GET'), headers: { authorization: 'Bearer ' + env.STRIPE_SECRET_KEY } };
  if (params) { opt.headers['content-type'] = 'application/x-www-form-urlencoded'; opt.body = new URLSearchParams(params).toString(); }
  const r = await fetch(STRIPE + path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || ('stripe ' + r.status)); e.status = r.status; throw e; }
  return j;
}
async function subInfo(env, subId, fresh) {
  const k = 'sub:' + subId, c = cache.get(k);
  if (!fresh && c && Date.now() - c.t < 10 * 60 * 1000) return c.v;
  const s = await stripe(env, 'subscriptions/' + encodeURIComponent(subId));
  const items = (s.items && s.items.data) || [];
  const v = {
    paid: OK_STATUS.includes(s.status) && (!env.STRIPE_PRICE_NAVI || items.some(it => it.price && it.price.id === env.STRIPE_PRICE_NAVI)),
    status: s.status, until: (s.current_period_end || (items[0] && items[0].current_period_end) || 0) * 1000,
    trialEnd: (s.trial_end || 0) * 1000, cancelAtEnd: !!s.cancel_at_period_end, customer: s.customer
  };
  cache.set(k, { t: Date.now(), v });
  return v;
}
async function whoPaid(env, request) {
  const subId = await readCode(env, request.headers.get('x-kn-code'));
  if (!subId) return null;
  try { const v = await subInfo(env, subId); return v.paid ? { subId, ...v } : null; } catch (e) { return null; }
}
async function freeQuota(env, request) {
  if (!env.KN_KV) return true;
  const ip = request.headers.get('cf-connecting-ip') || 'x', day = new Date().toISOString().slice(0, 10), key = 'q:' + day + ':' + ip;
  const n = parseInt(await env.KN_KV.get(key) || '0', 10) + 1;
  await env.KN_KV.put(key, String(n), { expirationTtl: 2 * 86400 });
  return n <= (parseInt(env.FREE_DAILY || '300', 10));
}
function num(v, lo, hi) { const n = parseFloat(v); return isFinite(n) && n >= lo && n <= hi ? n : null; }
function ll(v) { const m = /^(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)$/.exec(String(v || '')); return m ? m[1] + ',' + m[2] : null; }

async function api(request, env, url) {
  const p = url.pathname, origin = url.origin;
  try {
    if (p === '/api/plan') {
      let c = cache.get('price');
      if (!c || Date.now() - c.t > 3600 * 1000) {
        const pr = await stripe(env, 'prices/' + encodeURIComponent(env.STRIPE_PRICE_NAVI));
        c = { t: Date.now(), v: { amount: pr.unit_amount, currency: pr.currency, interval: pr.recurring && pr.recurring.interval } };
        cache.set('price', c);
      }
      return json({ ...c.v, trialDays: parseInt(env.TRIAL_DAYS || '30', 10), here: !!env.HERE_API_KEY });
    }
    if (p === '/api/checkout' && request.method === 'POST') {
      const prm = {
        mode: 'subscription', 'line_items[0][price]': env.STRIPE_PRICE_NAVI, 'line_items[0][quantity]': '1',
        success_url: origin + '/create.html?paid={CHECKOUT_SESSION_ID}', cancel_url: origin + '/create.html',
        locale: 'ja', allow_promotion_codes: 'true', 'metadata[app]': 'kmlnavi', 'subscription_data[metadata][app]': 'kmlnavi'
      };
      // free trial, but the first charge is never before FIRST_CHARGE_FROM (default 1 Jan 2027, Japan time),
      // so nobody who signs up in 2026 is billed in 2026
      const td = Math.max(0, parseInt(env.TRIAL_DAYS || '30', 10) || 0);
      const from = Date.parse(env.FIRST_CHARGE_FROM || '2027-01-01T00:00:00+09:00');
      let end = Date.now() + td * 86400000;
      if (isFinite(from) && end < from) end = from;
      if (end > Date.now() + 48 * 3600000) prm['subscription_data[trial_end]'] = String(Math.ceil(end / 1000));
      const s = await stripe(env, 'checkout/sessions', prm);
      return json({ url: s.url });
    }
    if (p === '/api/claim') {
      const id = url.searchParams.get('session_id') || '';
      if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return json({ error: 'bad_session' }, 400);
      const s = await stripe(env, 'checkout/sessions/' + encodeURIComponent(id));
      if (s.status !== 'complete' || !s.subscription || (s.metadata && s.metadata.app && s.metadata.app !== 'kmlnavi')) return json({ error: 'not_complete' }, 409);
      const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription.id;
      const v = await subInfo(env, subId, true);
      return json({ code: await makeCode(env, subId), ...v, customer: undefined });
    }
    if (p === '/api/me') {
      const subId = await readCode(env, request.headers.get('x-kn-code'));
      if (!subId) return json({ paid: false, error: 'bad_code' });
      const v = await subInfo(env, subId, url.searchParams.get('fresh') === '1');
      return json({ ...v, customer: undefined });
    }
    if (p === '/api/portal' && request.method === 'POST') {
      const subId = await readCode(env, request.headers.get('x-kn-code'));
      if (!subId) return json({ error: 'bad_code' }, 401);
      const v = await subInfo(env, subId, true);
      const s = await stripe(env, 'billing_portal/sessions', { customer: v.customer, return_url: origin + '/create.html', locale: 'ja' });
      return json({ url: s.url });
    }
    if (p === '/api/here/route') {
      const q = url.searchParams, o = ll(q.get('origin')), d = ll(q.get('destination')), truck = q.get('mode') === 'truck';
      if (!o || !d) return json({ title: 'bad request' }, 400);
      const who = await whoPaid(env, request);
      if (truck && !who) return json({ title: 'pro', error: 'pro_required' }, 402);
      if (!who && !(await freeQuota(env, request))) return json({ title: 'daily limit' }, 429);
      let h = 'https://router.hereapi.com/v8/routes?origin=' + o + '&destination=' + d + '&return=polyline,actions&spans=functionalClass&apiKey=' + encodeURIComponent(env.HERE_API_KEY);
      if (truck) {
        const L = num(q.get('L'), 2, 60), W = num(q.get('W'), 1, 8), H = num(q.get('H'), 1, 8), T = num(q.get('T'), 1, 500), trailer = q.get('veh') === 'trailer';
        h += '&transportMode=truck&vehicle[type]=' + (trailer ? 'tractor' : 'straightTruck') + (trailer ? '&vehicle[trailerCount]=1' : '');
        if (T) h += '&vehicle[grossWeight]=' + Math.round(T * 1000);
        if (H) h += '&vehicle[height]=' + Math.round(H * 100);
        if (W) h += '&vehicle[width]=' + Math.round(W * 100);
        if (L) h += '&vehicle[length]=' + Math.round(L * 100);
        if (q.get('avoid') !== '0') h += '&avoid[features]=difficultTurns,uTurns';
      } else h += '&transportMode=car';
      const r = await fetch(h);
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (p === '/api/here/discover') {
      const q = url.searchParams, at = ll(q.get('at')), text = String(q.get('q') || '').slice(0, 80);
      if (!at || !text) return json({ title: 'bad request' }, 400);
      if (!(await whoPaid(env, request)) && !(await freeQuota(env, request))) return json({ title: 'daily limit' }, 429);
      const r = await fetch('https://discover.search.hereapi.com/v1/discover?at=' + at + '&q=' + encodeURIComponent(text) + '&lang=ja&limit=12&in=countryCode:JPN&apiKey=' + encodeURIComponent(env.HERE_API_KEY));
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    return json({ error: 'server', message: String(e && e.message || e) }, e && e.status === 404 ? 404 : 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(request, env, url);
    return env.ASSETS.fetch(request);
  }
};
