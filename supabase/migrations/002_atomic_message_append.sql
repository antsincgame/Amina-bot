-- Migration: Add atomic message append function
-- This function safely appends a message to a conversation's messages array
-- Prevents race conditions when multiple messages arrive simultaneously

CREATE OR REPLACE FUNCTION append_conversation_message(
  conversation_id UUID,
  new_message JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Update the conversation with the new message appended
  UPDATE conversations
  SET 
    messages = messages || new_message,
    updated_at = NOW()
  WHERE id = conversation_id;

  -- Check if conversation exists
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found: %', conversation_id;
  END IF;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION append_conversation_message(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION append_conversation_message(UUID, JSONB) TO service_role;

-- Add comment
COMMENT ON FUNCTION append_conversation_message(UUID, JSONB) IS 
'Atomically appends a message to conversation messages array. Prevents race conditions.';
