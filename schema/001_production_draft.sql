-- VERSION 001 ? REVIEW DRAFT ONLY. Do not execute without explicit approval.
-- Fresh empty schema only. Confirm target and emptiness independently before installation.
-- MariaDB DDL commits implicitly; partial installations require manual review.
-- No database selection, credentials, seed data, or checkout enablement.

CREATE TABLE media_assets (

    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    storage_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,


    mime_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

    byte_size BIGINT UNSIGNED NOT NULL,

    sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

    width_px INT UNSIGNED NOT NULL,

    height_px INT UNSIGNED NOT NULL,

    state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'staged',

    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE KEY uq_media_storage (storage_key),

    KEY ix_media_hash (sha256),

    CONSTRAINT ck_media_type CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),

    CONSTRAINT ck_media_shape CHECK (byte_size BETWEEN 1 AND 5242880 AND width_px BETWEEN 1 AND 8192 AND height_px BETWEEN 1 AND 8192),

    CONSTRAINT ck_media_state CHECK (state IN ('staged','ready','quarantined'))

  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE categories (

    id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,

    name VARCHAR(255) NOT NULL,

    slug VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

    image_asset_id BIGINT UNSIGNED NULL,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    sort_order INT NOT NULL DEFAULT 0,

    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

    UNIQUE KEY uq_category_slug (slug),

    KEY ix_category_active_sort (is_active,sort_order,id),

    CONSTRAINT fk_category_image FOREIGN KEY (image_asset_id) REFERENCES media_assets(id),

    CONSTRAINT ck_category_text CHECK (CHAR_LENGTH(TRIM(id)) > 0 AND CHAR_LENGTH(TRIM(name)) > 0 AND CHAR_LENGTH(TRIM(slug)) > 0),

    CONSTRAINT ck_category_active CHECK (is_active IN (0,1))

  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE subcategories (

    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    category_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

    name VARCHAR(191) NOT NULL,

    slug VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

    featured_asset_id BIGINT UNSIGNED NOT NULL,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    sort_order INT NOT NULL DEFAULT 0,

    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

    UNIQUE KEY uq_subcategory_slug (category_id,slug),

    UNIQUE KEY uq_subcategory_name (category_id,name),

    UNIQUE KEY uq_subcategory_owner (id,category_id),

    KEY ix_subcategory_active_sort (category_id,is_active,sort_order,id),

    CONSTRAINT fk_subcategory_category FOREIGN KEY (category_id) REFERENCES categories(id),

    CONSTRAINT fk_subcategory_media FOREIGN KEY (featured_asset_id) REFERENCES media_assets(id),

    CONSTRAINT ck_subcategory_name CHECK (CHAR_LENGTH(TRIM(name)) BETWEEN 2 AND 80 AND CHAR_LENGTH(TRIM(slug)) > 0),

    CONSTRAINT ck_subcategory_active CHECK (is_active IN (0,1))

  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE products (

    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    slug VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

    title VARCHAR(255) NOT NULL,

    sku VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

    category_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

    subcategory_id BIGINT UNSIGNED NULL,

    mrp_paise BIGINT UNSIGNED NOT NULL,

    sale_price_paise BIGINT UNSIGNED NOT NULL,

    subtitle TEXT NULL,

    description TEXT NULL,

    material VARCHAR(255) NULL,

    stone VARCHAR(255) NULL,

    rating DECIMAL(3,2) NOT NULL DEFAULT 0,

    reviews_count INT UNSIGNED NOT NULL DEFAULT 0,

    is_active BOOLEAN NOT NULL DEFAULT FALSE,

    archived_at DATETIME(6) NULL,

    row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,

    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

    UNIQUE KEY uq_product_slug (slug),

    UNIQUE KEY uq_product_sku (sku),

    KEY ix_product_listing (is_active,archived_at,created_at,id),

    KEY ix_product_category_price (category_id,is_active,sale_price_paise,id),

    KEY ix_product_subcategory_owner (subcategory_id,category_id),

    CONSTRAINT fk_product_category FOREIGN KEY (category_id) REFERENCES categories(id),

    CONSTRAINT fk_product_subcategory_owner FOREIGN KEY (subcategory_id,category_id) REFERENCES subcategories(id,category_id),

    CONSTRAINT ck_product_text CHECK (CHAR_LENGTH(TRIM(title)) > 0 AND CHAR_LENGTH(TRIM(slug)) > 0 AND CHAR_LENGTH(TRIM(sku)) > 0),

    CONSTRAINT ck_product_prices CHECK (sale_price_paise <= mrp_paise AND mrp_paise <= 999999999999),

    CONSTRAINT ck_product_rating CHECK (rating BETWEEN 0 AND 5),

    CONSTRAINT ck_product_active CHECK (is_active IN (0,1))

  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_aliases (

    alias VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,

    product_id BIGINT UNSIGNED NOT NULL,

    CONSTRAINT fk_alias_product FOREIGN KEY (product_id) REFERENCES products(id),

    CONSTRAINT ck_alias_text CHECK (CHAR_LENGTH(TRIM(alias)) > 0)

  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_variants (

    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    product_id BIGINT UNSIGNED NOT NULL,

    label VARCHAR(191) NOT NULL,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    sort_order INT NOT NULL DEFAULT 0,

    UNIQUE KEY uq_variant_label (product_id,label),

    UNIQUE KEY uq_variant_owner (id,product_id),

    CONSTRAINT fk_variant_product FOREIGN KEY (product_id) REFERENCES products(id),

    CONSTRAINT ck_variant_text CHECK (CHAR_LENGTH(TRIM(label)) > 0),

    CONSTRAINT ck_variant_active CHECK (is_active IN (0,1))

  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_images (

    product_id BIGINT UNSIGNED NOT NULL,

    position SMALLINT UNSIGNED NOT NULL,

    asset_id BIGINT UNSIGNED NOT NULL,

    alt_text VARCHAR(255) NOT NULL DEFAULT '',

    PRIMARY KEY (product_id,position),

    UNIQUE KEY uq_product_asset (product_id,asset_id),

    CONSTRAINT fk_product_image_product FOREIGN KEY (product_id) REFERENCES products(id),

    CONSTRAINT fk_product_image_asset FOREIGN KEY (asset_id) REFERENCES media_assets(id)

  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_badges (

    product_id BIGINT UNSIGNED NOT NULL,

    label VARCHAR(100) NOT NULL,

    position SMALLINT UNSIGNED NOT NULL,

    PRIMARY KEY (product_id,label),

    UNIQUE KEY uq_badge_position (product_id,position),

    CONSTRAINT fk_badge_product FOREIGN KEY (product_id) REFERENCES products(id),

    CONSTRAINT ck_badge_label CHECK (CHAR_LENGTH(TRIM(label)) > 0)

  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inventory (

    product_id BIGINT UNSIGNED PRIMARY KEY,

    on_hand INT UNSIGNED NOT NULL DEFAULT 0,

    reserved INT UNSIGNED NOT NULL DEFAULT 0,

    row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,

    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

    CONSTRAINT fk_inventory_product FOREIGN KEY (product_id) REFERENCES products(id),

    CONSTRAINT ck_inventory_balance CHECK (reserved <= on_hand AND on_hand <= 2147483647)

  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_users (

  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  singleton_slot TINYINT UNSIGNED NOT NULL DEFAULT 1,

  login_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

  password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

  is_active TINYINT(1) NOT NULL DEFAULT 1,

  credential_version BIGINT UNSIGNED NOT NULL DEFAULT 1,

  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  last_login_at DATETIME(6) NULL,

  PRIMARY KEY (id),

  UNIQUE KEY uq_admin_singleton (singleton_slot),

  UNIQUE KEY uq_admin_login_id (login_id),

  CONSTRAINT ck_admin_singleton CHECK (singleton_slot = 1),

  CONSTRAINT ck_admin_login_nonempty CHECK (CHAR_LENGTH(TRIM(login_id)) > 0),

  CONSTRAINT ck_admin_password_hash CHECK (CHAR_LENGTH(password_hash) BETWEEN 20 AND 255),

  CONSTRAINT ck_admin_active CHECK (is_active IN (0,1)),

  CONSTRAINT ck_admin_credential_version CHECK (credential_version > 0)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_sessions (

  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  admin_user_id BIGINT UNSIGNED NOT NULL,

  token_hash BINARY(32) NOT NULL,

  credential_version BIGINT UNSIGNED NOT NULL,

  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  expires_at DATETIME(6) NOT NULL,

  revoked_at DATETIME(6) NULL,

  last_seen_at DATETIME(6) NULL,

  PRIMARY KEY (id),

  UNIQUE KEY uq_admin_session_token (token_hash),

  KEY ix_admin_session_user_expiry (admin_user_id, expires_at),

  KEY ix_admin_session_expiry (expires_at),

  CONSTRAINT fk_admin_session_user FOREIGN KEY (admin_user_id) REFERENCES admin_users(id),

  CONSTRAINT ck_admin_session_credential_version CHECK (credential_version > 0),

  CONSTRAINT ck_admin_session_expiry CHECK (expires_at > created_at),

  CONSTRAINT ck_admin_session_revoked CHECK (revoked_at IS NULL OR revoked_at >= created_at)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_audit_logs (

  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  admin_user_id BIGINT UNSIGNED NULL,

  action VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

  resource_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,

  resource_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,

  outcome VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

  occurred_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  metadata_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,

  PRIMARY KEY (id),

  KEY ix_admin_audit_actor_time (admin_user_id, occurred_at),

  KEY ix_admin_audit_action_time (action, occurred_at),

  CONSTRAINT fk_admin_audit_user FOREIGN KEY (admin_user_id) REFERENCES admin_users(id),

  CONSTRAINT ck_admin_audit_action CHECK (CHAR_LENGTH(TRIM(action)) > 0),

  CONSTRAINT ck_admin_audit_outcome CHECK (outcome IN ('success','failure')),

  CONSTRAINT ck_admin_audit_json CHECK (metadata_json IS NULL OR JSON_VALID(metadata_json))

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE orders (

    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,

    customer_name VARCHAR(255) NOT NULL,

    email VARCHAR(254) NULL,

    phone VARCHAR(32) NOT NULL,

    city VARCHAR(255) NOT NULL,

    address TEXT NOT NULL,

    country VARCHAR(100) NOT NULL,

    delivery_notes TEXT NULL,

    admin_notes TEXT NULL,

    tracking_number VARCHAR(191) NULL,

    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',

    payment_status VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',

    payment_method VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'razorpay',

    currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'INR',

    subtotal_paise BIGINT UNSIGNED NOT NULL,

    shipping_paise BIGINT UNSIGNED NOT NULL DEFAULT 6000,

    total_paise BIGINT UNSIGNED NOT NULL,

    access_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

    paid_at DATETIME(6) NULL,

    archived_at DATETIME(6) NULL,

    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

    UNIQUE KEY uq_order_financial (id,total_paise,currency),

    KEY ix_order_status_created (status,created_at,id),

    KEY ix_order_payment_created (payment_status,created_at,id),

    KEY ix_order_created (created_at,id),

    KEY ix_order_phone (phone), KEY ix_order_email (email),

    CONSTRAINT ck_order_customer CHECK (CHAR_LENGTH(TRIM(customer_name)) > 0 AND CHAR_LENGTH(TRIM(phone)) > 0 AND CHAR_LENGTH(TRIM(city)) > 0 AND CHAR_LENGTH(TRIM(address)) > 0 AND CHAR_LENGTH(TRIM(country)) > 0),

    CONSTRAINT ck_order_method CHECK (payment_method = 'razorpay' AND currency = 'INR'),

    CONSTRAINT ck_order_status CHECK (status IN ('pending','confirmed','shipped','delivered','cancelled','returned')),

    CONSTRAINT ck_order_payment CHECK (payment_status IN ('pending','paid','review_required','closed_unpaid')),

    CONSTRAINT ck_order_total CHECK (subtotal_paise BETWEEN 1 AND 999999999999 AND shipping_paise = 6000 AND CAST(total_paise AS DECIMAL(22,0)) = CAST(subtotal_paise AS DECIMAL(22,0)) + shipping_paise),

    CONSTRAINT ck_order_paid_time CHECK ((payment_status = 'paid' AND paid_at IS NOT NULL) OR payment_status <> 'paid')

  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE order_items (

    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

    line_number SMALLINT UNSIGNED NOT NULL,

    product_id BIGINT UNSIGNED NOT NULL,

    variant_id BIGINT UNSIGNED NOT NULL,

    title_snapshot VARCHAR(255) NOT NULL,

    sku_snapshot VARCHAR(191) NOT NULL,

    category_snapshot VARCHAR(255) NOT NULL,

    variant_snapshot VARCHAR(191) NOT NULL,

    quantity INT UNSIGNED NOT NULL,

    unit_price_paise BIGINT UNSIGNED NOT NULL,

    mrp_paise BIGINT UNSIGNED NOT NULL,

    line_total_paise BIGINT UNSIGNED NOT NULL,

    UNIQUE KEY uq_order_line (order_id,line_number),

    UNIQUE KEY uq_order_variant (order_id,variant_id),

    UNIQUE KEY uq_item_owner (id,order_id,product_id),

    CONSTRAINT fk_item_order FOREIGN KEY (order_id) REFERENCES orders(id),

    CONSTRAINT fk_item_variant_owner FOREIGN KEY (variant_id,product_id) REFERENCES product_variants(id,product_id),

    CONSTRAINT ck_item_qty CHECK (quantity BETWEEN 1 AND 999 AND line_number > 0),

    CONSTRAINT ck_item_price CHECK (unit_price_paise <= mrp_paise AND mrp_paise <= 999999999999 AND CAST(line_total_paise AS DECIMAL(22,0)) = CAST(unit_price_paise AS DECIMAL(22,0)) * quantity)

  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Durable checkout structures. All state changes must be in application transactions.
CREATE TABLE checkout_requests (
  scope_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (scope_hash, idempotency_key),
  UNIQUE KEY uq_checkout_order (order_id),
  CONSTRAINT fk_checkout_order FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inventory_reservations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'held',
  review_after DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  closed_at DATETIME(6) NULL,
  UNIQUE KEY uq_reservation_order (order_id),
  UNIQUE KEY uq_reservation_owner (id,order_id),
  KEY ix_reservation_review (state,review_after),
  CONSTRAINT fk_reservation_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT ck_reservation_state CHECK (state IN ('held','consumed','released')),
  CONSTRAINT ck_reservation_closed CHECK ((state='held' AND closed_at IS NULL) OR (state<>'held' AND closed_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reservation_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reservation_id BIGINT UNSIGNED NOT NULL,
  order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_item_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  UNIQUE KEY uq_reserved_order_item (order_item_id),
  UNIQUE KEY uq_reservation_item_owner (id,product_id),
  KEY ix_reservation_lines (reservation_id,product_id,id),
  CONSTRAINT fk_reservation_item_reservation FOREIGN KEY (reservation_id,order_id) REFERENCES inventory_reservations(id,order_id),
  CONSTRAINT fk_reservation_item_order_item FOREIGN KEY (order_item_id,order_id,product_id) REFERENCES order_items(id,order_id,product_id),
  CONSTRAINT ck_reservation_quantity CHECK (quantity BETWEEN 1 AND 999)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inventory_movements (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  reservation_item_id BIGINT UNSIGNED NULL,
  operation_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'adjust',
  on_hand_delta INT NOT NULL,
  reserved_delta INT NOT NULL DEFAULT 0,
  reason VARCHAR(255) NOT NULL,
  actor_ref VARCHAR(64) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_movement_operation (operation_key),
  UNIQUE KEY uq_movement_reservation_kind (reservation_item_id,kind),
  KEY ix_movement_product_created (product_id,created_at,id),
  CONSTRAINT fk_movement_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_movement_reservation_item FOREIGN KEY (reservation_item_id,product_id) REFERENCES reservation_items(id,product_id),
  CONSTRAINT ck_movement_kind CHECK (
    (kind='adjust' AND reservation_item_id IS NULL AND on_hand_delta<>0 AND reserved_delta=0) OR
    (kind='reserve' AND reservation_item_id IS NOT NULL AND on_hand_delta=0 AND reserved_delta>0) OR
    (kind='consume' AND reservation_item_id IS NOT NULL AND on_hand_delta<0 AND reserved_delta=on_hand_delta) OR
    (kind='release' AND reservation_item_id IS NOT NULL AND on_hand_delta=0 AND reserved_delta<0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_attempts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_number INT UNSIGNED NOT NULL,
  account_ref VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  environment VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  receipt_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  expected_amount_paise BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'INR',
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'creating',
  reconcile_after DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_attempt_order_number (order_id,attempt_number),
  UNIQUE KEY uq_attempt_provider (account_ref,environment,provider_order_id),
  UNIQUE KEY uq_attempt_receipt (account_ref,environment,receipt_key),
  UNIQUE KEY uq_attempt_owner (id,order_id),
  KEY ix_attempt_reconcile (state,reconcile_after),
  CONSTRAINT fk_attempt_financial FOREIGN KEY (order_id,expected_amount_paise,currency) REFERENCES orders(id,total_paise,currency),
  CONSTRAINT ck_attempt_environment CHECK (environment IN ('test','live')),
  CONSTRAINT ck_attempt_state CHECK (state IN ('creating','unknown','ready','captured','closed')),
  CONSTRAINT ck_attempt_number CHECK (attempt_number>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_ref VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  environment VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_event_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  provider_payment_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  amount_paise BIGINT UNSIGNED NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL,
  provider_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'received',
  last_error_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  processed_at DATETIME(6) NULL,
  UNIQUE KEY uq_event_identity (account_ref,environment,provider_event_id),
  KEY ix_event_processing (state,id),
  CONSTRAINT ck_event_environment CHECK (environment IN ('test','live')),
  CONSTRAINT ck_event_state CHECK (state IN ('received','retry','processed','quarantined'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_receipts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  attempt_id BIGINT UNSIGNED NOT NULL,
  order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_ref VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  environment VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_payment_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amount_paise BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  captured_at DATETIME(6) NULL,
  verified_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  evidence_source VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  UNIQUE KEY uq_receipt_provider (account_ref,environment,provider_payment_id),
  CONSTRAINT fk_receipt_attempt FOREIGN KEY (attempt_id,order_id) REFERENCES payment_attempts(id,order_id),
  CONSTRAINT fk_receipt_financial FOREIGN KEY (order_id,amount_paise,currency) REFERENCES orders(id,total_paise,currency),
  CONSTRAINT ck_receipt_environment CHECK (environment IN ('test','live'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE outbox_jobs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  dedupe_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',
  available_at DATETIME(6) NOT NULL,
  lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_outbox_dedupe (dedupe_key),
  KEY ix_outbox_ready (state,available_at,id),
  CONSTRAINT fk_outbox_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT ck_outbox_kind CHECK (kind IN ('create_provider_order','reconcile_payment','review_reservation')),
  CONSTRAINT ck_outbox_state CHECK (state IN ('pending','leased','done','review_required'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
