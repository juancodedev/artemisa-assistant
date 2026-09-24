// tests/bot.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Anthropic } from '@anthropic-ai/sdk';

import {
  isValidWhatsAppNumber,
  normalizePhoneNumber,
  isClinicalQuestion,
  isCrisisSignal,
  isSchedulingRequest,
  isAdminQuestion,
  sanitizeInput,
} from '../src/utils/validation';

import { routeMessage } from '../src/bot/router';
import { setAnthropicClientForTests } from '../src/bot/claude';
import { parseWebhookPayload, verifyWebhookChallenge } from '../src/services/whatsapp';
import { Psicologo } from '../src/types';

const mockPsicologo: Psicologo = {
  id: 'test-id-123',
  nombre: 'Dra. María López',
  numero_whatsapp: '+5491123456789',
  modalidad: 'Presencial y Virtual',
  direccion: 'Av. Corrientes 1234, Buenos Aires',
  precio: '$15.000 ARS por sesión',
  tipo_de_cita: 'Sesión individual de 50 minutos',
  sistemas_de_salud: ['OSDE', 'Swiss Medical', 'Galeno'],
  link_calcom: 'https://cal.com/juancode-dev/dr-maria-lopez',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('Validation Utils', () => {
  it('validates WhatsApp phone numbers with and without leading +', () => {
    assert.equal(isValidWhatsAppNumber('+5491123456789'), true);
    assert.equal(isValidWhatsAppNumber('5491123456789'), true);
    assert.equal(isValidWhatsAppNumber('abc'), false);
    assert.equal(isValidWhatsAppNumber(''), false);
  });

  it('normalizes phone numbers to standard E.164 with +', () => {
    assert.equal(normalizePhoneNumber('5491123456789'), '+5491123456789');
    assert.equal(normalizePhoneNumber('+5491123456789'), '+5491123456789');
    assert.equal(normalizePhoneNumber('+54 9 11 2345-6789'), '+5491123456789');
  });

  it('sanitizes input properly', () => {
    assert.equal(sanitizeInput('  <b>Hola</b> \x00 mundo  '), 'Hola mundo');
  });

  it('detects high-risk crisis signals with accent-insensitive matching', () => {
    const crisisMessages = [
      'quiero suicidarme',
      'pienso hacerme daño',
      'me quiero lastimar',
      'quiero agendar y quiero morir',
      'NO QUIERO VIVIR',
      'no vale la pena vivir',
      'quiero quitarme la vida',
      'pienso autolesionarme'
    ];

    for (const message of crisisMessages) {
      assert.equal(isCrisisSignal(message), true);
    }
    assert.equal(isCrisisSignal('¿Cuánto cuesta la consulta?'), false);
  });

  it('detects clinical questions without false positives on basic words', () => {
    // True clinical
    assert.equal(isClinicalQuestion('Tengo mucha ansiedad y no puedo dormir'), true);
    assert.equal(isClinicalQuestion('Me siento muy triste y tengo síntomas raros'), true);
    assert.equal(isClinicalQuestion('¿Qué pastillas me recomienda?'), true);

    // False positives should NOT trigger clinical
    assert.equal(isClinicalQuestion('¿Quién es el psicólogo?'), false);
    assert.equal(isClinicalQuestion('¿Dónde atiende el psicólogo?'), false);
  });

  it('detects scheduling requests without hijacking administrative schedule questions', () => {
    // Explicit scheduling
    assert.equal(isSchedulingRequest('Hola, quiero agendar una cita'), true);
    assert.equal(isSchedulingRequest('Quiero sacar turno por favor'), true);
    assert.equal(isSchedulingRequest('Pasame el link de cal.com'), true);

    // Administrative hours question should NOT trigger scheduling directly
    assert.equal(isSchedulingRequest('¿Cuáles son los horarios de atención?'), false);
  });

  it('detects administrative questions', () => {
    assert.equal(isAdminQuestion('¿Cuánto cuesta la consulta?'), true);
    assert.equal(isAdminQuestion('¿Atienden por OSDE u obra social?'), true);
    assert.equal(isAdminQuestion('¿Dónde queda el consultorio?'), true);
  });
});

describe('Bot Router & Fast-Path Responses', () => {
  it('routes explicit scheduling requests directly to Cal.com link', async () => {
    const res = await routeMessage('Quiero agendar un turno para la semana que viene', mockPsicologo);
    assert.equal(res.tipo, 'programacion');
    assert.ok(res.contenido.includes(mockPsicologo.link_calcom));
  });

  it('prioritizes crisis responses over scheduling and does not call Claude', async () => {
    let claudeCalls = 0;
    setAnthropicClientForTests({
      messages: {
        create: async () => {
          claudeCalls += 1;
          return { content: [{ type: 'text', text: 'no debe usarse' }] };
        },
      },
    } as unknown as Anthropic);

    try {
      for (const message of ['quiero suicidarme', 'pienso hacerme daño', 'me quiero lastimar', 'quiero agendar y quiero morir']) {
        const res = await routeMessage(message, mockPsicologo);
        assert.equal(res.tipo, 'crisis');
        assert.ok(res.contenido.includes('*4141'));
        assert.ok(res.contenido.includes('600 360 7777'));
        assert.ok(res.contenido.includes('opción 2'));
        assert.ok(res.contenido.includes('gratis'));
        assert.ok(res.contenido.includes('confidencialmente'));
        assert.ok(res.contenido.includes('24 horas'));
        assert.ok(res.contenido.includes('no reemplaza la atención profesional'));
        assert.equal(res.contenido.includes('cal.com'), false);
        assert.equal(res.contenido.includes('contactará'), false);
      }
      assert.equal(claudeCalls, 0);
    } finally {
      setAnthropicClientForTests(null);
    }
  });

  it('routes clinical questions to direct forward message without answering clinically', async () => {
    const res = await routeMessage('Tengo mucha ansiedad y depresión, no puedo más', mockPsicologo);
    assert.equal(res.tipo, 'clinica');
    assert.ok(res.contenido.includes('Esta consulta requiere atención directa'));
  });

  it('resolves quick administrative questions without calling external API', async () => {
    // Price
    const priceRes = await routeMessage('¿Cuánto sale la sesión?', mockPsicologo);
    assert.equal(priceRes.tipo, 'administrativa');
    assert.ok(priceRes.contenido.includes(mockPsicologo.precio));

    // Address
    const addressRes = await routeMessage('¿Dónde queda el consultorio?', mockPsicologo);
    assert.equal(addressRes.tipo, 'administrativa');
    assert.ok(addressRes.contenido.includes(mockPsicologo.direccion));

    // Insurance
    const osdeRes = await routeMessage('¿Aceptan obra social OSDE?', mockPsicologo);
    assert.equal(osdeRes.tipo, 'administrativa');
    assert.ok(osdeRes.contenido.includes('OSDE'));

    // Modality
    const modRes = await routeMessage('¿Es modalidad presencial o virtual?', mockPsicologo);
    assert.equal(modRes.tipo, 'administrativa');
    assert.ok(modRes.contenido.includes(mockPsicologo.modalidad));
  });
});

describe('WhatsApp Webhook Payload Handling', () => {
  it('correctly parses incoming message with Meta Cloud API format', () => {
    const metaPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '123456',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                messages: [
                  {
                    from: '5491123456789',
                    id: 'wamid.HBgL...',
                    text: {
                      body: 'Hola, cuánto cuesta la sesión?',
                    },
                    type: 'text',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const parsed = parseWebhookPayload(metaPayload);
    assert.ok(parsed);
    assert.equal(parsed.from, '5491123456789');
    assert.equal(parsed.text, 'Hola, cuánto cuesta la sesión?');
    assert.equal(parsed.id, 'wamid.HBgL...');
  });

  it('verifies Meta webhook challenge on GET', () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'test-verify-token';
    const valid = verifyWebhookChallenge('subscribe', 'test-verify-token', 'test_challenge_123');
    assert.equal(valid.isValid, true);
    assert.equal(valid.challenge, 'test_challenge_123');

    const invalid = verifyWebhookChallenge('subscribe', 'wrong-token', 'test_challenge_123');
    assert.equal(invalid.isValid, false);
  });
});
