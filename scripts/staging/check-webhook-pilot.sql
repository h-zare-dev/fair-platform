-- Supply a UTC instant via psql -v since=... recorded before the smoke.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT processing_status, count(*) AS primary_batches, sum(event_count) AS children
FROM pasarguard_webhook_batches
WHERE source_instance_id = 'primary' AND received_at >= :'since'::timestamptz
GROUP BY processing_status ORDER BY processing_status;

SELECT e.action, e.billing_admin_id, e.external_user_id, e.event_status,
       e.source_enqueued_at
FROM pasarguard_events e JOIN pasarguard_webhook_batches b ON b.id = e.batch_id
WHERE b.source_instance_id = 'primary' AND b.received_at >= :'since'::timestamptz
ORDER BY b.received_at DESC, e.batch_index DESC LIMIT 30;

SELECT r.id AS run_id, a.expected_children, r.event_count AS analyzed_events,
       n.unique_events, n.occurrences, n.occurrences - n.unique_events AS repeats,
       a.expected_children - n.occurrences AS unaccounted_occurrences
FROM fair_replay_shadow_runs r
JOIN fair_replay_archives a USING (source_instance_id)
CROSS JOIN LATERAL (
  SELECT count(*) AS unique_events, coalesce(sum(e.occurrence_count), 0) AS occurrences
  FROM pasarguard_events e WHERE e.source_instance_id = r.source_instance_id
) n
WHERE r.id IN (4, 5) ORDER BY r.id;
COMMIT;
