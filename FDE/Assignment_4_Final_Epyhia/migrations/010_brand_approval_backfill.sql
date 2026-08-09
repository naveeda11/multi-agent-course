UPDATE runs
SET status = 'AWAITING_BRAND_APPROVAL'
WHERE status = 'EXECUTING'
  AND brand_document_id IN (
    SELECT id FROM brand_documents WHERE approval_status = 'PENDING'
  )
  AND EXISTS (
    SELECT 1 FROM tasks
    WHERE tasks.run_id = runs.id
      AND tasks.task_type IN ('WEB_BUILD', 'MARKETING_PACK')
      AND tasks.status = 'PENDING'
  );
