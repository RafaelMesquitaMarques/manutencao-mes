"""One rule for what a spare part costs.

The inventory source (Inventory.xml, 5 400+ items) carries no price at all, so
``stock_items.unit_cost`` is empty for the whole catalog and every part
consumption was priced at nothing. Purchase receiving, on the other hand, does
record real money: it fills ``last_purchase_cost`` and a weighted
``average_cost`` on the stock item.

So the price of a part is, in order of trust:
  1. ``unit_cost``          — the catalog/standard price, when someone set one
  2. ``average_cost``       — weighted average of what was actually paid
  3. ``last_purchase_cost`` — the most recent invoice

Returning ``None`` (no price anywhere) is a legitimate answer and stays NULL all
the way to the UI: a part with no known price must read "no price", never $0.00.
"""
from __future__ import annotations

from typing import Optional

from app.models.models import StockItem


def unit_cost_of(stock: Optional[StockItem]) -> Optional[float]:
    """Best known unit price for a stock item, or None when there is none."""
    if stock is None:
        return None
    for value in (stock.unit_cost, stock.average_cost, stock.last_purchase_cost):
        if value is not None:
            return float(value)
    return None


def line_total(unit_cost: Optional[float], quantity: Optional[float]) -> Optional[float]:
    """Extended price for a consumption line, or None when the price is unknown."""
    if unit_cost is None or quantity is None:
        return None
    return round(float(unit_cost) * float(quantity), 2)
