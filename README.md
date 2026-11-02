# My B Shoppy API

Standalone Express backend. Install with `npm ci` and start with `npm start` on Node.js 22. Configure runtime environment variables separately; never commit credentials. For an isolated smoke test, set `DEPLOYMENT_PROFILE=isolated-test`, `NODE_ENV=production`, `MARIADB_ENABLED=false` and `CHECKOUT_ENABLED=false`.

Run tests with `npm test`. MariaDB connections and payment operations require separate configuration and authorization.

Legacy admin login requires both `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` in the runtime environment. The hash must be a salt and a 64-byte scrypt digest in hexadecimal, separated by a colon. When either setting is missing, admin login is unavailable. The isolated-test profile does not expose legacy admin login.
