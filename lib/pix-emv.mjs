/**
 * @param {string} id
 * @param {string} value
 */
function emvField(id, value) {
  return `${id}${String(new TextEncoder().encode(value).length).padStart(2, '0')}${value}`;
}

/**
 * @param {string} payload
 */
export function crc16Ccitt(payload) {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(payload)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * @param {object} input
 * @param {number} input.amountCents
 * @param {string} input.pixKey
 * @param {string} input.merchantName
 * @param {string} input.merchantCity
 * @param {string} input.reference
 */
export function createPixPayload({ amountCents, pixKey, merchantName, merchantCity, reference }) {
  if (
    !Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 2147483647
    || typeof pixKey !== 'string' || !/^[\x20-\x7e]{1,77}$/.test(pixKey)
    || typeof merchantName !== 'string' || !merchantName || new TextEncoder().encode(merchantName).length > 25
    || typeof merchantCity !== 'string' || !merchantCity || new TextEncoder().encode(merchantCity).length > 15
    || typeof reference !== 'string' || !/^[A-Za-z0-9]{1,25}$/.test(reference)
  ) return null;

  const merchantAccount = emvField('00', 'br.gov.bcb.pix') + emvField('01', pixKey);
  const additionalData = emvField('05', reference);
  const payload = [
    '000201',
    '010211',
    emvField('26', merchantAccount),
    '52040000',
    '5303986',
    emvField('54', (amountCents / 100).toFixed(2)),
    '5802BR',
    emvField('59', merchantName),
    emvField('60', merchantCity),
    emvField('62', additionalData),
    '6304'
  ].join('');
  return `${payload}${crc16Ccitt(payload)}`;
}
