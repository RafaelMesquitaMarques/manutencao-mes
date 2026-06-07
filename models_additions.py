"""
ADDITIONS TO backend/app/models/models.py
Add these two model classes. Also modify existing StockItem.

─────────────────────────────────────────────────────────────────────────────
1. NEW MODEL: Supplier
─────────────────────────────────────────────────────────────────────────────
"""

import uuid
from sqlalchemy import Column, String, Boolean, Float, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from app.db.base import Base


class Supplier(Base):
    __tablename__ = "suppliers"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code = Column(String(50), nullable=True)          # e.g. "0001" from Interal
    name = Column(String(300), nullable=False)
    phone = Column(String(100), nullable=True)
    email = Column(String(200), nullable=True)
    fax = Column(String(100), nullable=True)
    website = Column(String(300), nullable=True)
    currency = Column(String(10), default="CAD")
    notes = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True)


"""
─────────────────────────────────────────────────────────────────────────────
2. REPLACE existing StockItem model with this expanded version
─────────────────────────────────────────────────────────────────────────────
"""

class StockItem(Base):
    __tablename__ = "stock_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)

    # Identification
    code = Column(String(100), nullable=False, unique=True)   # PA-XXXXXXX from Interal
    name = Column(String(200), nullable=True)                  # Short name / code from Interal
    description = Column(Text, nullable=True)                  # Full description

    # Classification
    category = Column(String(200), nullable=True)              # NO_PART_CATEGORY
    part_class = Column(String(200), nullable=True)            # NO_PART_CLASS

    # Stock
    unit = Column(String(50), default="Unitaire")              # Unitaire / Metre / Pied
    quantity = Column(Float, default=0.0)                      # Current stock (sum of locations)
    min_quantity = Column(Float, nullable=True)                # Reorder point

    # Cost
    unit_cost = Column(Float, nullable=True)

    # Location
    warehouse = Column(String(100), nullable=True)             # Primary warehouse (Mag1, A1…)
    location = Column(String(100), nullable=True)              # Bin location (Z4C, M3G…)

    # Supplier
    supplier_id = Column(UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=True)
    supplier = Column(String(300), nullable=True)              # Legacy plain text field kept for compat

    # Traceability
    interal_product_id = Column(String(50), nullable=True)     # ID_PRODUCT from Interal XML
    notes = Column(Text, nullable=True)
