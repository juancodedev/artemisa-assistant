// supabase/functions/send-message/handler.ts
// Protected internal outbound WhatsApp dispatcher.

import { isValidInternalFunctionRequest } from '../_shared/auth.ts';
import { sendMessage } from '../_shared/whatsapp.ts';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleSendMessage(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (!isValidInternalFunctionRequest(request)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let payload: { to?: unknown; message?: unknown };
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  if (typeof payload.to !== 'string' || typeof payload.message !== 'string') {
    return jsonResponse(
      { error: 'Missing required fields: to, message' },
      400
    );
  }

  const result = await sendMessage(payload.to, payload.message);
  if (!result.success) {
    return jsonResponse(
      { success: false, error: result.error },
      502
    );
  }

  return jsonResponse({ success: true, messageId: result.messageId }, 200);
}
