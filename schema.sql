CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending','paid','failed','expired')),
  buyer_name TEXT NOT NULL,
  message TEXT DEFAULT '',
  website TEXT DEFAULT '',
  color TEXT DEFAULT '#d8ff38',
  image_url TEXT DEFAULT '',
  amount BIGINT NOT NULL CHECK(amount > 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  payment_type TEXT DEFAULT '',
  moderation_status TEXT NOT NULL DEFAULT 'visible' CHECK(moderation_status IN ('visible','hidden'))
);
CREATE TABLE IF NOT EXISTS order_pixels(
  order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,
  pixel_id SMALLINT NOT NULL CHECK(pixel_id BETWEEN 0 AND 9999),
  PRIMARY KEY(order_id,pixel_id)
);
CREATE INDEX IF NOT EXISTS idx_order_pixels_pixel_id ON order_pixels(pixel_id);
CREATE INDEX IF NOT EXISTS idx_orders_status_expires ON orders(status,expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(status,paid_at DESC);

CREATE TABLE IF NOT EXISTS pixel_claims(
  pixel_id SMALLINT PRIMARY KEY CHECK(pixel_id BETWEEN 0 AND 9999),
  order_id TEXT UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pixel_claims_expires ON pixel_claims(expires_at);
