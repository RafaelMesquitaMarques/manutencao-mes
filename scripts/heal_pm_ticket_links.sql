-- Heal PM work-order ↔ ticket links.
--
-- Fixes two inconsistencies that left tickets stuck "open" after their work
-- order was completed (see _sync_ticket_from_wo reverse-link fallback):
--   1. work_orders.ticket_id lost even though the ticket still points back.
--   2. tickets left open/in-progress while their linked WO is completed/cancelled.
--
-- Idempotent and safe to re-run: each UPDATE is a no-op once healed.
-- Run inside a transaction so a failure rolls everything back.

BEGIN;

-- (1) Restore the missing forward link: work_orders.ticket_id ← ticket that
--     already references the WO via work_order_id.
UPDATE work_orders w
SET    ticket_id = t.id
FROM   maintenance_tickets t
WHERE  t.work_order_id = w.id
  AND  w.ticket_id IS NULL;

-- (2) Close tickets left open while their (reverse-linked) WO is completed.
UPDATE maintenance_tickets t
SET    status = 'completed',
       completed_at = COALESCE(t.completed_at, w.completed_at, now())
FROM   work_orders w
WHERE  t.work_order_id = w.id
  AND  w.status = 'completed'
  AND  t.status IN ('open','in_progress','on_hold_parts','on_hold_ext');

-- (2b) Cancel tickets whose WO was cancelled.
UPDATE maintenance_tickets t
SET    status = 'cancelled'
FROM   work_orders w
WHERE  t.work_order_id = w.id
  AND  w.status = 'cancelled'
  AND  t.status IN ('open','in_progress','on_hold_parts','on_hold_ext');

-- (3) Sync the linked alerts to match the healed ticket status
--     (mirrors _TICKET_TO_ALERT_STATUS: completed→resolved, cancelled→cancelled).
UPDATE maintenance_alerts a
SET    status = 'resolved'
FROM   maintenance_tickets t
WHERE  t.alert_id = a.id
  AND  t.status = 'completed'
  AND  a.status <> 'resolved';

UPDATE maintenance_alerts a
SET    status = 'cancelled'
FROM   maintenance_tickets t
WHERE  t.alert_id = a.id
  AND  t.status = 'cancelled'
  AND  a.status <> 'cancelled';

COMMIT;
