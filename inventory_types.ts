// ── Additions to frontend/src/types/index.ts ──────────────────────────────

export interface StockItem {
  id: string;
  plant_id: string | null;
  code: string;              // PA-XXXXXXX
  name: string;
  description: string;
  category: string;
  part_class: string;
  unit: string;
  quantity: number;
  min_quantity: number | null;
  unit_cost: number | null;
  warehouse: string;
  location: string;
  supplier_id: string | null;
  interal_product_id: string | null;
  notes: string;
  is_low_stock: boolean;
}

export interface StockItemListResponse {
  total: number;
  low_stock_count: number;
  items: StockItem[];
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  fax: string | null;
  website: string | null;
  currency: string;
  notes: string | null;
  is_active: boolean;
}

export interface InventoryCategories {
  categories: string[];
  part_classes: string[];
  warehouses: string[];
}

export interface InventoryDashboard {
  total_items: number;
  low_stock_count: number;
  zero_stock_count: number;
  by_category: { category: string; count: number }[];
}
