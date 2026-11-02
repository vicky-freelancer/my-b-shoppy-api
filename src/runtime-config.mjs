export function parseTestOrigins(env = process.env) {
  const raw = env.TEST_ALLOWED_ORIGINS ?? '';
  if (raw === '') return [];
  const invalid = () => { throw new Error('Invalid isolated test origin configuration.'); };
  if (typeof raw !== 'string' || env.DEPLOYMENT_PROFILE !== 'isolated-test') invalid();
  const origins = raw.split(',').map(value => value.trim());
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { invalid(); }
    // Require canonical serialized origins. This also rejects URL normalization,
    // empty entries, explicit default ports, backslashes and trailing slashes.
    if (url.protocol !== 'https:' || !url.hostname || origin.includes('*') ||
        url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || url.origin !== origin) invalid();
  }
  return [...new Set(origins)];
}

export function loadDevelopmentEnv({ env = process.env, configure, envPath }) {
  if (env.DEPLOYMENT_PROFILE === 'isolated-test' || env.NODE_ENV === 'production') return;
  configure({ path: envPath });
}

export function registerLiveness(app) {
  app.get('/api/live', (_req, res) => res.set('Cache-Control', 'no-store').json({ ok: true }));
}

// Preserve the public health contract regardless of catalog/database readiness.
export function healthResponse(env = process.env) {
  const configured = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  return {
    ok: true,
    razorpayConfigured: configured,
    durableCheckoutReady: false,
    mode: !configured ? 'UNCONFIGURED' : env.RAZORPAY_KEY_ID.startsWith('rzp_test_') ? 'TEST' : 'LIVE',
  };
}
