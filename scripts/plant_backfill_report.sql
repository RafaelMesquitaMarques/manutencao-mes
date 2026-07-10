-- Multi-plant phase 1 — ambiguity report.
-- Lists every record whose plant could NOT be inferred by the documented rules
-- (machine → plant, equipment → plant, cost-center site rule), plus pending
-- business decisions. Nothing here was guessed: these rows keep plant_id NULL
-- until a human assigns them.
--
-- Run:  docker exec -i mes_db psql -U mesadmin -d manutencao -q -f - \
--         < scripts/plant_backfill_report.sql > docs/plant-backfill-review.csv
COPY (
  -- Orphan machines: the root of most NULLs below. Assign these first; the
  -- boot-time backfill then heals every dependent row automatically.
  SELECT 'machines'::text AS table_name, m.id::text AS record_id,
         COALESCE(m.name, m.code, '?') AS label,
         'department=' || COALESCE(m.department, '-') || '; active=' || m.is_active::text
           || '; equipment_link=' || COALESCE(e.name, '-') AS detail,
         'assign in Settings → Machines (or SQL)' AS suggested_action
  FROM machines m
  LEFT JOIN equipment e ON e.id = m.equipment_id
  WHERE m.plant_id IS NULL

  UNION ALL
  SELECT 'maintenance_tickets', t.id::text, t.ticket_number,
         'machine=' || COALESCE(m.name, '?') || '; opened=' || t.opened_at::date::text,
         'auto-heals once its machine gets a plant'
  FROM maintenance_tickets t LEFT JOIN machines m ON m.id = t.machine_id
  WHERE t.plant_id IS NULL

  UNION ALL
  SELECT 'maintenance_alerts', a.id::text, a.alert_number,
         'machine=' || COALESCE(m.name, '?') || '; created=' || a.created_at::date::text,
         'auto-heals once its machine gets a plant'
  FROM maintenance_alerts a LEFT JOIN machines m ON m.id = a.machine_id
  WHERE a.plant_id IS NULL

  UNION ALL
  SELECT 'work_orders', w.id::text, w.wo_number,
         'opened=' || w.opened_at::date::text,
         'no equipment/machine plant — review'
  FROM work_orders w WHERE w.plant_id IS NULL

  UNION ALL
  SELECT 'machine_stops', s.id::text, 'stop ' || s.started_at::date::text,
         'machine=' || COALESCE(m.name, '?'),
         'auto-heals once its machine gets a plant'
  FROM machine_stops s LEFT JOIN machines m ON m.id = s.machine_id
  WHERE s.plant_id IS NULL

  UNION ALL
  SELECT 'machine_interventions', i.id::text, 'intervention ' || i.called_at::date::text,
         'machine=' || COALESCE(m.name, '?') || '; status=' || i.status,
         'auto-heals once its machine gets a plant'
  FROM machine_interventions i LEFT JOIN machines m ON m.id = i.machine_id
  WHERE i.plant_id IS NULL

  UNION ALL
  SELECT 'machine_production_logs', 'aggregate', count(*)::text || ' rows',
         'machines: ' || string_agg(DISTINCT COALESCE(m.name, '?'), ', '),
         'auto-heals once machines get a plant'
  FROM machine_production_logs p LEFT JOIN machines m ON m.id = p.machine_id
  WHERE p.plant_id IS NULL HAVING count(*) > 0

  UNION ALL
  SELECT 'reject_logs', 'aggregate', count(*)::text || ' rows',
         'machines: ' || string_agg(DISTINCT COALESCE(m.name, '?'), ', '),
         'auto-heals once machines get a plant'
  FROM reject_logs r LEFT JOIN machines m ON m.id = r.machine_id
  WHERE r.plant_id IS NULL HAVING count(*) > 0

  UNION ALL
  SELECT 'machine_operators', 'aggregate', count(*)::text || ' rows',
         'machines: ' || string_agg(DISTINCT COALESCE(m.name, '?'), ', '),
         'auto-heals once machines get a plant'
  FROM machine_operators o LEFT JOIN machines m ON m.id = o.machine_id
  WHERE o.plant_id IS NULL HAVING count(*) > 0

  UNION ALL
  SELECT 'machine_history', 'aggregate', count(*)::text || ' rows',
         'machines: ' || string_agg(DISTINCT COALESCE(m.name, '?'), ', '),
         'auto-heals once machines get a plant'
  FROM machine_history h LEFT JOIN machines m ON m.id = h.machine_id
  WHERE h.plant_id IS NULL HAVING count(*) > 0

  UNION ALL
  SELECT 'job_orders', j.id::text, j.job_number,
         'machine=' || COALESCE(m.name, 'none'),
         'no machine link — review or leave global'
  FROM job_orders j LEFT JOIN machines m ON m.id = j.machine_id
  WHERE j.plant_id IS NULL

  UNION ALL
  SELECT 'adam_devices', d.id::text, d.name,
         'ip=' || d.ip_address || '; machine=' || COALESCE(m.name, 'none'),
         'link to a machine (Settings → Devices)'
  FROM adam_devices d LEFT JOIN machines m ON m.id = d.machine_id
  WHERE d.plant_id IS NULL

  UNION ALL
  SELECT 'purchase_orders', po.id::text, po.order_number,
         'supplier=' || s.name || '; date=' || po.order_date::text || '; no cost_center',
         'assign plant (no cost-center to infer from)'
  FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
  WHERE po.plant_id IS NULL

  UNION ALL
  SELECT 'maintenance_budgets', b.id::text, b.year::text || '-' || lpad(b.month::text, 2, '0'),
         'amount=' || b.amount::text || ' ' || b.currency,
         'global monthly budget — decide which plant(s) it covers'
  FROM maintenance_budgets b WHERE b.plant_id IS NULL

  UNION ALL
  SELECT 'suppliers', 'decision', count(*)::text || ' suppliers, all plant_id NULL',
         'shared/corporate list today',
         'BUSINESS DECISION: per-plant vs shared (assessment §8.3)'
  FROM suppliers HAVING count(*) > 0

  UNION ALL
  SELECT 'stock_items', 'decision', count(*)::text || ' items, all in ' || COALESCE(p.code, '?'),
         'Mirabel inventory was never separated',
         'BUSINESS DECISION: split Mirabel stock or shared SJ+MIRA warehouse (assessment §8.2)'
  FROM stock_items si LEFT JOIN plants p ON p.id = si.plant_id
  GROUP BY p.code HAVING count(*) > 0

  ORDER BY table_name, label
) TO STDOUT WITH CSV HEADER;
