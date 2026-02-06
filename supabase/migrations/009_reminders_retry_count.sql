-- Migration 009: Add retry_count to reminders
-- Prevents infinite retries on failed reminder deliveries

-- Add retry_count column (defaults to 0)
ALTER TABLE reminders 
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

-- Comment
COMMENT ON COLUMN reminders.retry_count IS 'Number of failed delivery attempts. Max 10 before auto-completion.';

-- Index for efficient getDue queries  
CREATE INDEX IF NOT EXISTS idx_reminders_due_with_retry 
  ON reminders (scheduled_at, is_completed, retry_count) 
  WHERE is_completed = false AND retry_count < 10;
