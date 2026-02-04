-- ============================================
-- Migration: Fix RLS Policies for Admin Panel
-- Description: Разрешить authenticated пользователям управлять настройками
-- ============================================

-- Drop existing restrictive policy
DROP POLICY IF EXISTS "Service role can manage settings" ON settings;

-- Create new policies for settings
-- Service role - full access
CREATE POLICY "Service role full access on settings"
  ON settings FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Authenticated users - full access (for admin panel)
CREATE POLICY "Authenticated can manage settings"
  ON settings FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Also fix prompts to allow authenticated users to manage
DROP POLICY IF EXISTS "Service role can manage prompts" ON prompts;
DROP POLICY IF EXISTS "Authenticated can read prompts" ON prompts;

CREATE POLICY "Service role full access on prompts"
  ON prompts FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated can manage prompts"
  ON prompts FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ============================================
-- Comments
-- ============================================

COMMENT ON POLICY "Authenticated can manage settings" ON settings IS 'Allows admin panel users to update settings';
COMMENT ON POLICY "Authenticated can manage prompts" ON prompts IS 'Allows admin panel users to manage prompts';
