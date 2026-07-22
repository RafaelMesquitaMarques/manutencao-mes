"""Predictive intelligence engine (docs/predictive-intelligence.md).

Layered, explainable machine-health scoring:
  L0 configurable rules · L1 context-aware baseline anomaly · L2 trend ·
  L3 operational (microstops/production) · L4 reliability (MTBF) ·
  L5 pre-failure pattern similarity.

Everything is flag-gated per plant/machine (predictive_settings.mode) and
fully auditable (health snapshots with factor breakdown + engine/config
versions on every artifact).
"""
