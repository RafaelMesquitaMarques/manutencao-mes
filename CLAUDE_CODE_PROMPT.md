# FOLIOT MES — INVENTORY MODULE IMPLEMENTATION
# Prompt for Claude Code — Session 2026-06-07
# ─────────────────────────────────────────────────────────────────────────────
#
# PROJECT CONTEXT
# Stack: FastAPI (Python 3.12) + SQLAlchemy async + TimescaleDB + React 18 +
#        Vite + TypeScript + Tailwind CSS (dark) + AG Grid + Zustand
# Repo:  manutencao-mes/
# Auth:  JWT Bearer (get_current_user dependency)
# PKs:   UUID everywhere
# Enums: SAEnum(native_enum=False) — VARCHAR, never a native ENUM
# Names: everything in English (tables, columns, functions, routes)
#
# ─────────────────────────────────────────────────────────────────────────────
# TASK: Implement the complete Inventory module.
# All the required files are in this package.
# Follow the instructions below in the order given.
# ─────────────────────────────────────────────────────────────────────────────

> **Historical document — already executed on 2026-06-07. Do not run it again.**
> It is kept as a record of how the Inventory module was bootstrapped; the
> module has evolved a lot since then. Step 11 drops the entire `public`
> schema, which would now wipe all production data.

## STEP 1 — BACKEND: ORM models

Edit `backend/app/models/models.py`:

### 1a. Add the Supplier class (BEFORE the existing StockItem class):

```python
class Supplier(Base):
    __tablename__ = "suppliers"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code = Column(String(50), nullable=True)
    name = Column(String(300), nullable=False)
    phone = Column(String(100), nullable=True)
    email = Column(String(200), nullable=True)
    fax = Column(String(100), nullable=True)
    website = Column(String(300), nullable=True)
    currency = Column(String(10), default="CAD")
    notes = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True)
```

### 1b. REPLACE the existing StockItem class with this expanded version:

```python
class StockItem(Base):
    __tablename__ = "stock_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    code = Column(String(100), nullable=False, unique=True)
    name = Column(String(200), nullable=True)
    description = Column(Text, nullable=True)
    category = Column(String(200), nullable=True)
    part_class = Column(String(200), nullable=True)
    unit = Column(String(50), default="Unitaire")
    quantity = Column(Float, default=0.0)
    min_quantity = Column(Float, nullable=True)
    unit_cost = Column(Float, nullable=True)
    warehouse = Column(String(100), nullable=True)
    location = Column(String(100), nullable=True)
    supplier_id = Column(UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=True)
    supplier = Column(String(300), nullable=True)
    interal_product_id = Column(String(50), nullable=True)
    notes = Column(Text, nullable=True)
```

---

## STEP 2 — BACKEND: Inventory route

Copy the `inventory.py` file from this package to:
→ `backend/app/api/routes/inventory.py`
(replaces the existing stub that returned [])

---

## STEP 3 — BACKEND: Register the route in main.py

Edit `backend/app/main.py`. Find where the routers are registered and
REPLACE the inventory router include with the new one:

```python
from app.api.routes.inventory import router as inventory_router
# If it already exists (app.include_router(inventory_router) with the old stub),
# just reloading the module is enough once the new file is copied.
# Make sure this line exists:
app.include_router(inventory_router)
```

---

## STEP 4 — IMPORT SCRIPT

Copy the `import_inventory.py` file from this package to:
→ `backend/scripts/import_inventory.py`

---

## STEP 5 — FRONTEND: TypeScript types

Edit `frontend/src/types/index.ts` and ADD at the end of the file:

```typescript
export interface StockItem {
  id: string;
  plant_id: string | null;
  code: string;
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
```

---

## STEP 6 — FRONTEND: API client

Copy the `inventory_api.ts` file from this package to:
→ `frontend/src/api/inventory.ts`

---

## STEP 7 — FRONTEND: Pages

Create the `frontend/src/pages/Inventory/` folder and copy:
- `InventoryList.tsx`    → `frontend/src/pages/Inventory/InventoryList.tsx`
- `InventoryDetail.tsx`  → `frontend/src/pages/Inventory/InventoryDetail.tsx`
- `NewInventoryItem.tsx` → `frontend/src/pages/Inventory/NewInventoryItem.tsx`

---

## STEP 8 — FRONTEND: Routes (App.tsx)

Edit `frontend/src/App.tsx`:

### 8a. Add the imports:
```tsx
import InventoryList    from './pages/Inventory/InventoryList';
import InventoryDetail  from './pages/Inventory/InventoryDetail';
import NewInventoryItem from './pages/Inventory/NewInventoryItem';
```

### 8b. Add the routes inside <Routes>:
```tsx
<Route path="/inventory"      element={<InventoryList />} />
<Route path="/inventory/new"  element={<NewInventoryItem />} />
<Route path="/inventory/:id"  element={<InventoryDetail />} />
```

---

## STEP 9 — FRONTEND: Sidebar

Edit `frontend/src/components/layout/Sidebar.tsx`:

### 9a. Add the icon import (if it does not exist yet):
```tsx
import { Package } from 'lucide-react';
```

### 9b. Add it to the "Core" navigation group (next to Work Orders, Equipment etc.):
```tsx
{ path: '/inventory', icon: Package, label: t('nav.inventory', 'Inventaire') }
```

---

## STEP 10 — FRONTEND: i18n

### frontend/src/i18n/locales/en.json
Add inside the root object:
```json
"inventory": {
  "code": "Part No.",
  "description": "Description",
  "category": "Category",
  "partClass": "Part Class",
  "quantity": "Qty in stock",
  "minQty": "Min qty",
  "unit": "Unit",
  "location": "Location",
  "warehouse": "Warehouse",
  "cost": "Unit cost",
  "subtitle": "Parts & materials · Saint-Jérôme",
  "totalItems": "Total items",
  "lowStock": "Low stock",
  "zeroStock": "Out of stock",
  "categories": "Categories",
  "lowStockOnly": "Low stock only",
  "newItem": "New item",
  "searchPlaceholder": "Search by code, description…",
  "results": "results",
  "adjustQty": "Adjust stock"
}
```

### frontend/src/i18n/locales/fr.json
```json
"inventory": {
  "code": "N° Pièce",
  "description": "Description",
  "category": "Catégorie",
  "partClass": "Classe de pièce",
  "quantity": "Qté en stock",
  "minQty": "Qté min",
  "unit": "Unité",
  "location": "Emplacement",
  "warehouse": "Entrepôt",
  "cost": "Coût unit.",
  "subtitle": "Pièces & matériaux · Saint-Jérôme",
  "totalItems": "Total articles",
  "lowStock": "Stock faible",
  "zeroStock": "Rupture de stock",
  "categories": "Catégories",
  "lowStockOnly": "Stock faible uniquement",
  "newItem": "Nouvelle pièce",
  "searchPlaceholder": "Rechercher par code, description…",
  "results": "résultats",
  "adjustQty": "Ajuster le stock"
}
```

### frontend/src/i18n/locales/es.json
```json
"inventory": {
  "code": "N° Pieza",
  "description": "Descripción",
  "category": "Categoría",
  "partClass": "Clase de pieza",
  "quantity": "Cant. en stock",
  "minQty": "Cant. mín",
  "unit": "Unidad",
  "location": "Ubicación",
  "warehouse": "Almacén",
  "cost": "Costo unit.",
  "subtitle": "Piezas y materiales · Saint-Jérôme",
  "totalItems": "Total artículos",
  "lowStock": "Stock bajo",
  "zeroStock": "Sin stock",
  "categories": "Categorías",
  "lowStockOnly": "Solo stock bajo",
  "newItem": "Nueva pieza",
  "searchPlaceholder": "Buscar por código, descripción…",
  "results": "resultados",
  "adjustQty": "Ajustar stock"
}
```

---

## STEP 11 — DATABASE RESET AND REBUILD

Run in this order:

```bash
# 1. Reset schema (needed because of the new columns in stock_items)
docker exec mes_db psql -U mesadmin -d manutencao \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# 2. Rebuild and seed
docker compose up --build --no-deps -d backend
docker exec mes_backend python /app/scripts/seed.py

# 3. Copy the XMLs into the container
docker cp Inventory.xml mes_backend:/app/data/Inventory.xml
docker cp Suppliers.xml mes_backend:/app/data/Suppliers.xml

# (create the /app/data folder if needed)
docker exec mes_backend mkdir -p /app/data

# 4. Run the import
docker exec mes_backend python /app/scripts/import_inventory.py \
  --inventory /app/data/Inventory.xml \
  --suppliers /app/data/Suppliers.xml

# 5. Rebuild frontend
docker compose up --build --no-deps -d frontend
```

### Expected import output:
```
=== Foliot MES — Inventory Import ===
  Tables/columns ready.
  Plant PLT1 found: <uuid>
  Parsed 567 suppliers
  Suppliers: ~430 inserted, 0 already existed
  Parsed 5440 unique stock items
  Stock items: 5440 inserted, 0 updated
  Import complete.
```

---

## STEP 12 — VERIFICATION

```bash
# Confirm the imported items
docker exec mes_db psql -U mesadmin -d manutencao \
  -c "SELECT COUNT(*) FROM stock_items; SELECT COUNT(*) FROM suppliers;"

# Test the API
curl http://localhost/api/inventory/items?limit=5
curl http://localhost/api/inventory/dashboard
curl http://localhost/api/inventory/suppliers?limit=5
```

---

## FILES IN THIS PACKAGE

| File                   | Destination                                      |
|------------------------|--------------------------------------------------|
| `inventory.py`         | `backend/app/api/routes/inventory.py`            |
| `import_inventory.py`  | `backend/scripts/import_inventory.py`            |
| `models_additions.py`  | Reference — edit `models/models.py` manually     |
| `inventory_api.ts`     | `frontend/src/api/inventory.ts`                  |
| `inventory_types.ts`   | Append to the end of `frontend/src/types/index.ts` |
| `InventoryList.tsx`    | `frontend/src/pages/Inventory/InventoryList.tsx`  |
| `InventoryDetail.tsx`  | `frontend/src/pages/Inventory/InventoryDetail.tsx`|
| `NewInventoryItem.tsx` | `frontend/src/pages/Inventory/NewInventoryItem.tsx`|

---

## IMPORTANT NOTES FOR CLAUDE CODE

1. **Do not use `native_enum=True`** in SQLAlchemy — all enums are `SAEnum(native_enum=False)`
2. **The DB already exists** — do not recreate tables that already exist (plants, users, equipment etc.)
3. **The import script is idempotent** — it can safely be run multiple times
4. **The `/api/inventory/` route was already registered** in main.py, pointing to a stub — just replacing the route file is enough
5. **AG Grid Community** is already installed in the project (`ag-grid-community`, `ag-grid-react`)
6. **The `lucide-react` imports** already work in the project
7. **Tailwind dark mode** is configured — `dark:` classes are not needed, the theme is always dark
8. **`from app.db.session import get_db`** and **`from app.core.security import get_current_user`** are the project's standard dependencies
