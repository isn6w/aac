import test from 'node:test';
import assert from 'node:assert/strict';
import { createPixPayload, crc16Ccitt } from '../lib/pix-emv.mjs';

test('uses CRC-16/CCITT-FALSE for Pix payload checksums', () => {
  assert.equal(crc16Ccitt('123456789'), '29B1');
});

test('builds a Pix BR Code with the sale amount and valid CRC', () => {
  const payload = createPixPayload({
    amountCents: 12345,
    pixKey: 'loja@example.com',
    merchantName: 'AAC COMERCIAL',
    merchantCity: 'SAO PAULO',
    reference: 'AAC123'
  });

  assert.ok(payload);
  assert.ok(payload.includes('5406123.45'));
  assert.ok(payload.includes('0014br.gov.bcb.pix'));
  assert.equal(payload.slice(-8, -4), '6304');
  assert.equal(payload.slice(-4), crc16Ccitt(payload.slice(0, -4)));
});

test('rejects invalid amounts and oversized Pix fields', () => {
  const input = {
    amountCents: 100,
    pixKey: 'loja@example.com',
    merchantName: 'AAC COMERCIAL',
    merchantCity: 'SAO PAULO',
    reference: 'AAC123'
  };
  assert.equal(createPixPayload({ ...input, amountCents: 0 }), null);
  assert.equal(createPixPayload({ ...input, pixKey: 'x'.repeat(78) }), null);
  assert.equal(createPixPayload({ ...input, reference: 'x'.repeat(26) }), null);
});
