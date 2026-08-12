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

export default db;
