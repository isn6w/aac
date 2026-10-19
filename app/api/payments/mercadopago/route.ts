import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';

export const runtime = 'nodejs';

type PaymentSettings = Database['public']['Tables']['payment_settings']['Row'];
type ServerClient = SupabaseClient<Database>;
type PaymentTicket = {
  paymentId: string;
  userId: string;
  amountCents: number;
  externalReference: string;
  expiresAt: number;
};

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function getContext(requireMercadoPagoMode = true): Promise<
  | { client: ServerClient; userId: string; settings: PaymentSettings }
  | { response: Response }
> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    return { response: jsonError('A conexão segura com o Supabase não está configurada.', 503) };
  }

  const cookieStore = await cookies();
  const client = createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: cookiesToSet => {
        cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
      }
    }
  });
  const { data: claimsData, error: claimsError } = await client.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (claimsError || typeof userId !== 'string') {
    return { response: jsonError('Entre novamente para iniciar o pagamento.', 401) };
  }
  const { data: profile, error: profileError } = await client.from('profiles')
    .select('role').eq('user_id', userId).maybeSingle();
  if (profileError) {
    console.error('Mercado Pago profile lookup failed:', profileError.code);
    return { response: jsonError('Não foi possível verificar a permissão do operador.', 503) };
  }
  if (!profile || !['admin', 'manager', 'cashier'].includes(profile.role)) {
    return { response: jsonError('Seu perfil não pode iniciar pagamentos.', 403) };
  }

  const { data: settings, error: settingsError } = await client.from('payment_settings')
    .select('*').eq('id', true).maybeSingle();
  if (settingsError || !settings) {
    console.error('Pix settings lookup failed:', settingsError?.code ?? 'missing row');
    return { response: jsonError('As configurações Pix não estão disponíveis. Aplique a migration de pagamento Pix.', 503) };
  }
  if (requireMercadoPagoMode && (settings.pix_payment_mode !== 'mercadopago' || !settings.pix_key)) {
    return { response: jsonError('Ative o Mercado Pago e cadastre a chave Pix em Configurações.', 409) };
  }
  return { client, userId, settings };
}

function makeTicket(payload: PaymentTicket, accessToken: string) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', accessToken).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function readTicket(ticket: string, accessToken: string): PaymentTicket | null {
  if (ticket.length > 2048) return null;
  const [encodedPayload, signature, extra] = ticket.split('.');
  if (!encodedPayload || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', accessToken).update(encodedPayload).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.paymentId !== 'string' || !/^\d+$/.test(value.paymentId)
      || typeof value.userId !== 'string' || !/^[\da-f-]{36}$/i.test(value.userId)
      || typeof value.amountCents !== 'number' || !Number.isSafeInteger(value.amountCents)
      || typeof value.externalReference !== 'string'
      || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt)) return null;
    return value as PaymentTicket;
  } catch {
    return null;
  }
}

function getAccessToken() {
  const accessToken = process.env.MP_ACCESS_TOKEN?.trim();
  return accessToken || null;
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) {
    return jsonError('Origem da solicitação inválida.', 403);
  }
  const context = await getContext();
  if ('response' in context) return context.response;
  const accessToken = getAccessToken();
  if (!accessToken) return jsonError('A integração Mercado Pago não está configurada no servidor.', 503);
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > 4096) return jsonError('Solicitação de pagamento inválida.', 413);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Solicitação de pagamento inválida.', 400);
  }
  if (!body || typeof body !== 'object') return jsonError('Solicitação de pagamento inválida.', 400);
  const requestBody = body as Record<string, unknown>;
  const amountCents = requestBody.amountCents;
  const email = requestBody.payerEmail;
  const idempotencyKey = request.headers.get('idempotency-key');
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents)
    || amountCents < 1 || amountCents > 2147483647
    || typeof email !== 'string' || email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || !idempotencyKey || !/^[\da-f-]{36}$/i.test(idempotencyKey)) {
    return jsonError('Informe um valor válido, o e-mail do pagador e uma chave de solicitação válida.', 400);
  }

  const externalReference = `AAC-${crypto.randomUUID()}`;
  const expiresAt = Date.now() + 15 * 60 * 1000;
  let paymentResponse: Response;
  try {
    paymentResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        transaction_amount: amountCents / 100,
        description: `Venda A.A.C. · ${context.settings.merchant_name}`,
        payment_method_id: 'pix',
        external_reference: externalReference,
        date_of_expiration: new Date(expiresAt).toISOString(),
        payer: { email }
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    console.error('Mercado Pago payment request could not reach the provider.');
    return jsonError('Não foi possível conectar ao Mercado Pago. Tente novamente.', 502);
  }
  if (!paymentResponse.ok) {
    console.error('Mercado Pago rejected payment creation:', paymentResponse.status);
    return jsonError('O Mercado Pago não conseguiu gerar o pagamento. Confira a configuração da conta.', 502);
  }

  let payment: unknown;
  try {
    payment = await paymentResponse.json();
  } catch {
    return jsonError('O Mercado Pago retornou uma resposta inválida.', 502);
  }
  if (!payment || typeof payment !== 'object') return jsonError('O Mercado Pago retornou uma resposta inválida.', 502);
  const value = payment as Record<string, unknown>;
  const interaction = value.point_of_interaction;
  const transactionData = interaction && typeof interaction === 'object'
    ? (interaction as Record<string, unknown>).transaction_data
    : null;
  const transaction = transactionData && typeof transactionData === 'object'
    ? transactionData as Record<string, unknown>
    : null;
  if ((typeof value.id !== 'number' && typeof value.id !== 'string')
    || !/^\d+$/.test(String(value.id))
    || value.external_reference !== externalReference
    || value.transaction_amount !== amountCents / 100
    || value.currency_id !== 'BRL'
    || typeof transaction?.qr_code !== 'string'
    || typeof transaction.qr_code_base64 !== 'string') {
    console.error('Mercado Pago response did not include Pix QR data.');
    return jsonError('O Mercado Pago não retornou os dados do QR Pix.', 502);
  }

  const ticket = makeTicket({
    paymentId: String(value.id),
    userId: context.userId,
    amountCents,
    externalReference,
    expiresAt
  }, accessToken);
  return Response.json({
    qrCode: transaction.qr_code,
    qrCodeBase64: transaction.qr_code_base64,
    ticket,
    expiresAt
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request) {
  const context = await getContext(false);
  if ('response' in context) return context.response;
  const accessToken = getAccessToken();
  if (!accessToken) return jsonError('A integração Mercado Pago não está configurada no servidor.', 503);
  const ticketValue = new URL(request.url).searchParams.get('ticket');
  const ticket = ticketValue ? readTicket(ticketValue, accessToken) : null;
  if (!ticket || ticket.userId !== context.userId) return jsonError('Referência de pagamento inválida.', 400);
  if (Date.now() > ticket.expiresAt) {
    return Response.json({ status: 'expired' }, { headers: { 'Cache-Control': 'no-store' } });
  }

  let paymentResponse: Response;
  try {
    paymentResponse = await fetch(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(ticket.paymentId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store', signal: AbortSignal.timeout(10000) }
    );
  } catch {
    console.error('Mercado Pago status request could not reach the provider.');
    return jsonError('Não foi possível consultar o pagamento. Nova tentativa em instantes.', 502);
  }
  if (!paymentResponse.ok) {
    console.error('Mercado Pago rejected payment status lookup:', paymentResponse.status);
    return jsonError('Não foi possível consultar o status do pagamento.', 502);
  }

  let payment: unknown;
  try {
    payment = await paymentResponse.json();
  } catch {
    return jsonError('O Mercado Pago retornou uma resposta inválida.', 502);
  }
  if (!payment || typeof payment !== 'object') return jsonError('O Mercado Pago retornou uma resposta inválida.', 502);
  const value = payment as Record<string, unknown>;
  const amountCents = typeof value.transaction_amount === 'number'
    ? Math.round(value.transaction_amount * 100)
    : null;
  if (String(value.id) !== ticket.paymentId
    || value.external_reference !== ticket.externalReference
    || amountCents !== ticket.amountCents
    || value.currency_id !== 'BRL') {
    console.error('Mercado Pago payment details did not match the signed checkout ticket.');
    return jsonError('Os dados do pagamento não correspondem a esta venda.', 409);
  }

  const status = value.status === 'approved'
    ? 'approved'
    : value.status === 'rejected' || value.status === 'cancelled' || value.status === 'refunded'
      ? 'rejected'
      : 'pending';
  return Response.json({ status }, { headers: { 'Cache-Control': 'no-store' } });
}
