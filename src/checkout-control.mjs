export const CHECKOUT_UNAVAILABLE_CODE = 'CHECKOUT_TEMPORARILY_UNAVAILABLE';

// This interlock is code-owned, not another environment variable. Step 2B must
// replace the legacy checkout with a reviewed durable implementation before it
// can become true. CHECKOUT_ENABLED=true alone must not reopen the unsafe flow.
export const SECURE_CHECKOUT_READY = false;

export function createCheckoutControl({
  readFlag = () => process.env.CHECKOUT_ENABLED,
  isReady = () => SECURE_CHECKOUT_READY,
} = {}) {
  function isEnabled() {
    try { return readFlag() === 'true' && isReady() === true; }
    catch { return false; }
  }
  function status(_req, res) {
    const enabled = isEnabled();
    res.set('Cache-Control', 'no-store').json({ enabled, ...(enabled ? {} : { code: CHECKOUT_UNAVAILABLE_CODE }) });
  }
  function guard(_req, res, next) {
    if (isEnabled()) return next();
    return res.set('Cache-Control', 'no-store').set('Retry-After', '60').status(503).json({
      code: CHECKOUT_UNAVAILABLE_CODE,
      error: 'Checkout is temporarily unavailable. You can still browse and view your cart.',
    });
  }
  return { isEnabled, status, guard };
}
