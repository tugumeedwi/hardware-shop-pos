import Dexie from 'dexie';

const db = new Dexie('HardwareShopDB');

db.version(2).stores({
  // Local mirror of server tables
  products: 'id, name, sku, category, is_tile, stock_quantity, price_per_piece, price_per_box, price_per_sqm, price_per_kg, active_pricing_methods, pieces_per_box, m2_per_piece, pieces_per_kg',
  customers: 'id, name, phone',

  // Sales created offline
  pendingSales: '++localId, saleData, status',

  // Changes waiting to be sent to server
  syncQueue: '++id, tableName, recordId, operation, payload, timestamp'
});

db.version(3).stores({
  // Local mirror of server tables (attributes = vertical-specific fields, e.g. IMEI)
  products: 'id, name, sku, category, is_tile, stock_quantity, price_per_piece, price_per_box, price_per_sqm, price_per_kg, active_pricing_methods, pieces_per_box, m2_per_piece, pieces_per_kg, attributes',
  customers: 'id, name, phone',

  // Sales created offline
  pendingSales: '++localId, saleData, status',

  // Changes waiting to be sent to server
  syncQueue: '++id, tableName, recordId, operation, payload, timestamp'
});

db.version(4).stores({
  // Local mirror of server tables
  // Non-indexable object columns (saleData, payload) are intentionally absent:
  // IndexedDB can only index primitives, and `payload` cannot be a keyPath.
  products: 'id, name, sku, category, is_tile, stock_quantity, price_per_piece, price_per_box, price_per_sqm, price_per_kg, active_pricing_methods, pieces_per_box, m2_per_piece, pieces_per_kg, attributes, is_deleted',
  customers: 'id, name, phone',

  // Sales created offline — offline_created_at is queried by the sync logic
  // (fixes a latent SchemaError in syncManager where 'saleData.offline_created_at'
  // was used as an index but never declared).
  pendingSales: '++localId, saleData.offline_created_at, status',

  // Changes waiting to be sent to server. attempts/nextRetryAt support
  // exponential backoff so a permanently failing item is not replayed
  // immediately on every sync pass.
  syncQueue: '++id, tableName, recordId, operation, timestamp, attempts, nextRetryAt'
});

db.version(5).stores({
  products: 'id, name, sku, category, is_tile, stock_quantity, price_per_piece, price_per_box, price_per_sqm, price_per_kg, active_pricing_methods, pieces_per_box, m2_per_piece, pieces_per_kg, attributes, is_deleted',
  customers: 'id, name, phone',
  pendingSales: '++localId, saleData.offline_created_at, status',
  syncQueue: '++id, tableName, recordId, operation, timestamp, attempts, nextRetryAt',

  // Cached tenant memberships so a user who is already signed in can open the
  // app (and select/keep their shop) during a network outage.
  memberships: 'tenant_id, role'
});

db.version(6).stores({
  // barcode added so supermarket EAN/UPC lookups work from the offline mirror.
  products: 'id, name, sku, barcode, category, is_tile, stock_quantity, price_per_piece, price_per_box, price_per_sqm, price_per_kg, active_pricing_methods, pieces_per_box, m2_per_piece, pieces_per_kg, attributes, is_deleted',
  customers: 'id, name, phone',
  pendingSales: '++localId, saleData.offline_created_at, status',
  syncQueue: '++id, tableName, recordId, operation, timestamp, attempts, nextRetryAt',
  memberships: 'tenant_id, role'
});

db.version(7).stores({
  // tax_rate indexed so offline POS/quote totals can compute VAT while the
  // cashier is offline; brand/supplier carried so supermarket products sync
  // faithfully through the mirror.
  products: 'id, name, sku, barcode, category, is_tile, stock_quantity, price_per_piece, price_per_box, price_per_sqm, price_per_kg, active_pricing_methods, pieces_per_box, m2_per_piece, pieces_per_kg, attributes, is_deleted, tax_rate, brand, supplier',
  customers: 'id, name, phone',
  pendingSales: '++localId, saleData.offline_created_at, status',
  syncQueue: '++id, tableName, recordId, operation, timestamp, attempts, nextRetryAt',
  memberships: 'tenant_id, role'
});

export default db;