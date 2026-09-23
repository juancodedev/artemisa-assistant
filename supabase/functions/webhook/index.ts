// Supabase Edge Function - WhatsApp Webhook
// Receives incoming messages from Meta WhatsApp Business API
// This is the entry point when a patient sends a message

export async function handler(req: Request) {
  try {
    // Parse the incoming webhook payload from Meta
    const body = await req.json();

    // Meta sends either a verification challenge or a message entry
    // Handle verification first (GET request from Meta)
    if (req.method === 'GET') {
      const mode = body.object?.['hub.mode'];
      const challenge = body.object?.['hub.challenge'];
      const token = body.object?.['hub.verify_token'];

      const verifyToken = Deno.env.get('META_WEBHOOK_VERIFY_TOKEN') || 'artemisa-verify-token';

      if (mode === 'subscribe' && token === verifyToken && challenge) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    // Handle incoming messages (POST from Meta)
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messaging = value?.messages?.[0];

    if (!messaging || !messaging.from) {
      return new Response('No message found', { status: 400 });
    }

    const patientNumber = messaging.from; // WhatsApp number of the patient
    const messageText = messaging.message?.text?.body?.trim() || '';
    const messageId = messaging.id;

    if (!messageText) {
      return new Response('Empty message', { status: 400 });
    }

    // Log the incoming message
    console.log(`Received message from ${patientNumber}: "${messageText}"`);

    // Store the conversation in the database
    const supabaseClient = createClient();

    // Find or create conversation for this patient
    const conversations = await supabaseClient.get('conversaciones', `psicologo_id=eq.`); // Simplified
    const psicologo = await supabaseClient.get('psicologos');
    
    // If psicologo exists, create/update conversation
    if (psicologo.length > 0) {
      const psicologoId = psicologo[0].id;
      
      // Find existing conversation
      const existingConvs = await supabaseClient.get(
        'conversaciones',
        `psicologo_id=eq.${psicologoId}&numero_paciente=eq.${patientNumber}`
      );

      if (existingConvs.length > 0) {
        // Append to existing history
        const existingHistory = existingConvs[0].historial;
        const updatedHistory = [...existingHistory, { role: 'user', content: messageText, timestamp: new Date().toISOString() }];
        await supabaseClient.update('conversaciones', existingConvs[0].id, {
          historial: updatedHistory,
          ultima_actividad: new Date().toISOString()
        });
      } else {
        // Create new conversation
        await supabaseClient.insert('conversaciones', {
          psicologo_id: psicologoId,
          numero_paciente: patientNumber,
          historial: [{ role: 'user', content: messageText, timestamp: new Date().toISOString() }],
          ultima_actividad: new Date().toISOString()
        });
      }
    }

    // TODO: Forward the message to the bot logic and get a response
    // For now, send a placeholder response
    const botResponse = await processMessage(patientNumber, messageText);

    // Send the response back via WhatsApp
    if (botResponse) {
      await sendWhatsAppMessage(patientNumber, botResponse);
    }

    return new Response('OK', { status: 200 });

  } catch (error) {
    console.error('Webhook error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

// Process the incoming message and determine the response
async function processMessage(patientNumber: string, messageText: string): Promise<string | null> {
  const lowerMsg = messageText.toLowerCase().trim();

  // Check if the patient wants to schedule
  if (lowerMsg.includes('agendar') || lowerMsg.includes('reservar') || lowerMsg.includes('cita') || lowerMsg.includes('horario')) {
    // Return Cal.com link placeholder
    return 'Para agendar tu cita, visita: https://cal.com/dr-maria-lopez/30min';
  }

  // Check if the question is clinical/personal
  const clinicalKeywords = ['me duele', 'siento', 'sintomas', 'ansiedad', 'depresión', 'medicamento', 'tratamiento', 'pauta'];
  const isClinical = clinicalKeywords.some(kw => lowerMsg.includes(kw));

  if (isClinical) {
    return 'Esta consulta requiere atención directa con tu psicólogo. Te contactaremos a la brevedad. 🤝';
  }

  // Default: administrative question
  // In a real implementation, this would call Claude API
  return 'Gracias por tu mensaje. Tu psicólogo revisará tu consulta pronto. Para más información, escribe "horarios", "precio", "dirección" o "modalidad".';
}

// Send a message via WhatsApp Business API
async function sendWhatsAppMessage(to: string, message: string): Promise<void> {
  const metaAppId = Deno.env.get('META_APP_ID');
  const phoneNumberId = Deno.env.get('META_PHONE_NUMBER_ID');
  const accessToken = Deno.env.get('META_ACCESS_TOKEN');

  if (!metaAppId || !phoneNumberId || !accessToken) {
    throw new Error('Missing WhatsApp credentials');
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
    throw new Error(`Failed to send WhatsApp message: ${response.status}`);
  }
}
