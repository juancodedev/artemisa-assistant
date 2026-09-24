// supabase/functions/webhook/index.ts
// Main entry point for Meta WhatsApp Business Cloud API Webhook

import {
  handleWebhookVerification,
  parseWebhookPayload,
  sendMessage,
} from '../_shared/whatsapp.ts';
import {
  getPsicologo,
  getOrCreateConversacion,
  appendMessagesToConversacion,
} from '../_shared/supabase.ts';
import { processIncomingMessage } from '../_shared/bot.ts';

Deno.serve(async (req: Request) => {
  try {
    // 1. Meta Webhook Handshake / Verification (GET)
    if (req.method === 'GET') {
      return handleWebhookVerification(req);
    }

    // 2. Reject other non-POST methods
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 3. Parse incoming webhook payload
    const body = await req.json();
    const parseResult = parseWebhookPayload(body);

    // Meta status notifications (sent, delivered, read) - ACK immediately with 200
    if (parseResult.isStatusNotification) {
      return new Response('STATUS_ACK', { status: 200 });
    }

    // Unrecognized or non-message webhook events
    if (!parseResult.isMessage || !parseResult.message) {
      return new Response('EVENT_ACK', { status: 200 });
    }

    const { from, text } = parseResult.message;

    // Handle messages without text (audio, images, stickers, documents)
    if (!text) {
      const mediaResponse =
        'Por el momento solo puedo procesar mensajes de texto. Para enviarme audios o documentos, por favor contactá directamente a tu psicólogo/a.';
      await sendMessage(from, mediaResponse);
      return new Response('MEDIA_MSG_HANDLED', { status: 200 });
    }

    // 4. Retrieve psychologist profile (Phase 1: default psychologist in DB)
    const psicologo = await getPsicologo();
    if (!psicologo) {
      console.error('No psychologist profile found in the database.');
      await sendMessage(
        from,
        'En este momento el servicio está temporalmente no disponible. Por favor contactá a tu profesional directamente.'
      );
      return new Response('PSICOLOGO_NOT_FOUND', { status: 200 });
    }

    // 5. Process the message through the bot routing & Claude pipeline
    const botResult = await processIncomingMessage(from, text, psicologo);

    // 6. Send the response back to the patient via WhatsApp Cloud API
    const sendResult = await sendMessage(from, botResult.response);
    if (!sendResult.success) {
      console.error('Failed to send WhatsApp response:', sendResult.error);
    }

    // 7. Persist interaction in Supabase database
    const conversacion = await getOrCreateConversacion(
      psicologo.id,
      botResult.normalizedPatientNumber
    );

    if (conversacion) {
      await appendMessagesToConversacion(conversacion.id, conversacion.historial, [
        {
          role: 'user',
          content: text,
          timestamp: new Date().toISOString(),
        },
        {
          role: 'assistant',
          content: botResult.response,
          timestamp: new Date().toISOString(),
        },
      ]);
    }

    return new Response(JSON.stringify({ status: 'ok', handled: true, sendResult }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Unhandled webhook error:', error);
    // Return 200 with error log so Meta does not retry indefinitely on server-side logic crashes
    return new Response(JSON.stringify({ error: 'Internal processing error' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
