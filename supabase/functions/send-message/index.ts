// supabase/functions/send-message/index.ts
// Supabase Edge Function entry point for protected outbound delivery.

import { handleSendMessage } from './handler.ts';

Deno.serve(handleSendMessage);
