# FOLIOT MES — IMPLEMENTAÇÃO DO MÓDULO INVENTÁRIO
# Prompt para Claude Code — Sessão 2026-06-07
# ─────────────────────────────────────────────────────────────────────────────
#
# CONTEXTO DO PROJETO
# Stack: FastAPI (Python 3.12) + SQLAlchemy async + TimescaleDB + React 18 +
#        Vite + TypeScript + Tailwind CSS (dark) + AG Grid + Zustand
# Repo:  manutencao-mes/
# Auth:  JWT Bearer (get_current_user dependency)
# PKs:   UUID everywhere
# Enums: SAEnum(native_enum=False) — VARCHAR, nunca ENUM nativo
# Nomes: tudo em inglês (tabelas, colunas, funções, rotas)
#
# ─────────────────────────────────────────────────────────────────────────────
# TAREFA: Implementar o módulo Inventário completo.
# Todos os arquivos necessários estão neste pacote.
# Siga as instruções abaixo na ordem indicada.
# ─────────────────────────────────────────────────────────────────────────────

## PASSO 1 — BACKEND: Modelos ORM

Edite `backend/app/models/models.py`:

### 1a. Adicione a classe Supplier (ANTES da classe StockItem existente):

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

### 1b. SUBSTITUA a classe StockItem existente por esta versão expandida:

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

## PASSO 2 — BACKEND: Rota de inventário

Copie o arquivo `inventory.py` deste pacote para:
→ `backend/app/api/routes/inventory.py`
(substitui o stub existente que retornava [])

---

## PASSO 3 — BACKEND: Registrar rota no main.py

Edite `backend/app/main.py`. Localize onde os routers são registrados e
SUBSTITUA o include do router de inventory pelo novo:

```python
from app.api.routes.inventory import router as inventory_router
# Se já existir: app.include_router(inventory_router) com o stub antigo,
# apenas recarregar o módulo já resolve após copiar o arquivo novo.
# Confirme que esta linha existe:
app.include_router(inventory_router)
```

---

## PASSO 4 — SCRIPT DE IMPORTAÇÃO

Copie o arquivo `import_inventory.py` deste pacote para:
→ `backend/scripts/import_inventory.py`

---

## PASSO 5 — FRONTEND: Tipos TypeScript

Edite `frontend/src/types/index.ts` e ADICIONE ao final do arquivo:

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

## PASSO 6 — FRONTEND: API client

Copie o arquivo `inventory_api.ts` deste pacote para:
→ `frontend/src/api/inventory.ts`

---

## PASSO 7 — FRONTEND: Páginas

Crie a pasta `frontend/src/pages/Inventory/` e copie:
- `InventoryList.tsx`    → `frontend/src/pages/Inventory/InventoryList.tsx`
- `InventoryDetail.tsx`  → `frontend/src/pages/Inventory/InventoryDetail.tsx`
- `NewInventoryItem.tsx` → `frontend/src/pages/Inventory/NewInventoryItem.tsx`

---

## PASSO 8 — FRONTEND: Rotas (App.tsx)

Edite `frontend/src/App.tsx`:

### 8a. Adicione os imports:
```tsx
import InventoryList    from './pages/Inventory/InventoryList';
import InventoryDetail  from './pages/Inventory/InventoryDetail';
import NewInventoryItem from './pages/Inventory/NewInventoryItem';
```

### 8b. Adicione as rotas dentro do <Routes>:
```tsx
<Route path="/inventory"      element={<InventoryList />} />
<Route path="/inventory/new"  element={<NewInventoryItem />} />
<Route path="/inventory/:id"  element={<InventoryDetail />} />
```

---

## PASSO 9 — FRONTEND: Sidebar

Edite `frontend/src/components/layout/Sidebar.tsx`:

### 9a. Adicione o import do ícone (se não existir):
```tsx
import { Package } from 'lucide-react';
```

### 9b. Adicione no grupo de navegação "Core" (junto com Work Orders, Equipment etc.):
```tsx
{ path: '/inventory', icon: Package, label: t('nav.inventory', 'Inventaire') }
```

---

## PASSO 10 — FRONTEND: i18n

### frontend/src/i18n/locales/en.json
Adicione dentro do objeto raiz:
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

## PASSO 11 — RESET DO BANCO E REBUILD

Execute na ordem:

```bash
# 1. Reset schema (necessário por causa das novas colunas em stock_items)
docker exec mes_db psql -U mesadmin -d manutencao \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# 2. Rebuild e seed
docker compose up --build --no-deps -d backend
docker exec mes_backend python /app/scripts/seed.py

# 3. Copiar XMLs para dentro do container
docker cp Inventory.xml mes_backend:/app/data/Inventory.xml
docker cp Suppliers.xml mes_backend:/app/data/Suppliers.xml

# (criar pasta /app/data se necessário)
docker exec mes_backend mkdir -p /app/data

# 4. Rodar importação
docker exec mes_backend python /app/scripts/import_inventory.py \
  --inventory /app/data/Inventory.xml \
  --suppliers /app/data/Suppliers.xml

# 5. Rebuild frontend
docker compose up --build --no-deps -d frontend
```

### Saída esperada do import:
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

## PASSO 12 — VERIFICAÇÃO

```bash
# Confirmar itens importados
docker exec mes_db psql -U mesadmin -d manutencao \
  -c "SELECT COUNT(*) FROM stock_items; SELECT COUNT(*) FROM suppliers;"

# Testar API
curl http://localhost/api/inventory/items?limit=5
curl http://localhost/api/inventory/dashboard
curl http://localhost/api/inventory/suppliers?limit=5
```

---

## ARQUIVOS NESTE PACOTE

| Arquivo                | Destino                                          |
|------------------------|--------------------------------------------------|
| `inventory.py`         | `backend/app/api/routes/inventory.py`            |
| `import_inventory.py`  | `backend/scripts/import_inventory.py`            |
| `models_additions.py`  | Referência — editar `models/models.py` manualmente |
| `inventory_api.ts`     | `frontend/src/api/inventory.ts`                  |
| `inventory_types.ts`   | Adicionar ao final de `frontend/src/types/index.ts` |
| `InventoryList.tsx`    | `frontend/src/pages/Inventory/InventoryList.tsx`  |
| `InventoryDetail.tsx`  | `frontend/src/pages/Inventory/InventoryDetail.tsx`|
| `NewInventoryItem.tsx` | `frontend/src/pages/Inventory/NewInventoryItem.tsx`|

---

## NOTAS IMPORTANTES PARA CLAUDE CODE

1. **Não use `native_enum=True`** no SQLAlchemy — todos os enums são `SAEnum(native_enum=False)`
2. **O DB já existe** — não recriar tabelas que já existem (plants, users, equipment etc.)
3. **O script de importação é idempotente** — pode ser rodado múltiplas vezes com segurança
4. **A rota `/api/inventory/` já estava registrada** no main.py apontando para um stub — apenas substituir o arquivo de rota já resolve
5. **AG Grid Community** já está instalado no projeto (`ag-grid-community`, `ag-grid-react`)
6. **Os imports de `lucide-react`** já funcionam no projeto
7. **Tailwind dark mode** está configurado — usar classes dark: não é necessário, o tema é sempre dark
8. **`from app.db.session import get_db`** e **`from app.core.security import get_current_user`** são as dependências padrão do projeto
