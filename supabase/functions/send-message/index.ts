// Supabase Edge Function - Send Message
// Utility function to send WhatsApp messages programmatically
// Can be called by other functions or via internal triggers

export async function handler(req: Request) {
  try {
    const { to, message } = await req.json();

    if (!to || !message) {
      return new Response('Missing required fields: to, message', { status: 400 });
    }

    const metaAppId = Deno.env.get('META_APP_ID');
    const phoneNumberId = Deno.env.get('META_PHONE_NUMBER_ID');
    const accessToken = Deno.env.get('META_ACCESS_TOKEN');

    if (!metaAppId || !phoneNumberId || !accessToken) {
      return new Response('WhatsApp credentials not configured', { status: 500 });
    }

    const url = `https://graph.facebook.com/v18.0/${metaAppId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message }
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return new Response(`WhatsApp API error: ${errorBody}`, { status: response.status });
    }

    const result = await response.json();
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });

  } catch (error) {
    console.error('Send message error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
