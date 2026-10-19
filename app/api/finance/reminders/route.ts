import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { Database } from '@/lib/supabase/database.types';
import { generateGeminiReply, GeminiConfigurationError, GeminiRequestError } from '@/lib/gemini';

export const runtime = 'nodejs';

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) {
    return errorResponse('Origem da solicitação inválida.', 403);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return errorResponse('A conexão com o Supabase não está configurada.', 503);

  const cookieStore = await cookies();
  const supabase = createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: cookiesToSet => {
        cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
      }
    }
  });

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (claimsError || typeof userId !== 'string') return errorResponse('Entre novamente para analisar os vencimentos.', 401);

  const { data: profile, error: profileError } = await supabase.from('profiles')
    .select('role').eq('user_id', userId).maybeSingle();
  if (profileError) {
    console.error('Finance AI profile lookup failed:', profileError.code);
    return errorResponse('Não foi possível verificar a permissão do operador.', 503);
  }
  if (!profile || !['admin', 'manager'].includes(profile.role)) {
    return errorResponse('Seu perfil não pode acessar o assistente financeiro.', 403);
  }

  const { data: payables, error: payablesError } = await supabase.from('invoice_payables')
    .select('invoice_id,due_date,tax_total_cents,is_paid')
    .eq('is_paid', false).order('due_date', { ascending: true }).limit(100);
  if (payablesError || !payables) {
    console.error('Finance AI payable lookup failed:', payablesError?.code ?? 'missing data');
    return errorResponse('Não foi possível carregar os títulos para análise.', 503);
  }
  if (payables.length === 0) {
    return Response.json({ message: 'Não há boletos em aberto para analisar.' }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  const { data: invoices, error: invoicesError } = await supabase.from('purchase_invoices')
    .select('id,supplier_name,invoice_number,total_cents')
    .in('id', payables.map(payable => payable.invoice_id));
  if (invoicesError || !invoices) {
    console.error('Finance AI invoice lookup failed:', invoicesError?.code ?? 'missing data');
    return errorResponse('Não foi possível carregar as notas para análise.', 503);
  }

  const invoiceById = new Map(invoices.map(invoice => [invoice.id, invoice]));
  const today = new Date().toISOString().slice(0, 10);
  const todayTime = Date.parse(`${today}T00:00:00Z`);
  const analysisRows = payables.flatMap(payable => {
    const invoice = invoiceById.get(payable.invoice_id);
    if (!invoice) return [];
    const daysUntilDue = Math.round((Date.parse(`${payable.due_date}T00:00:00Z`) - todayTime) / 86400000);
    return [{
      supplier: invoice.supplier_name.slice(0, 160),
      invoiceNumber: invoice.invoice_number.slice(0, 80),
      dueDate: payable.due_date,
      daysUntilDue,
      amountCents: invoice.total_cents,
      taxCents: payable.tax_total_cents
    }];
  });
  if (!analysisRows.length) return errorResponse('Não há notas relacionadas aos títulos em aberto.', 503);

  let message: string;
  try {
    message = await generateGeminiReply(
      'Você é um assistente de controle de contas a pagar. Responda em português do Brasil, com resumo curto e lista priorizada por vencimento. Use somente os dados recebidos, destaque atrasos e boletos que vencem em até 7 dias, identifique impostos não informados e não invente valores nem afirme que um boleto foi pago. Encerre recomendando conferência humana antes de qualquer pagamento.',
      [{ role: 'user', content: JSON.stringify({ today, unpaidInvoices: analysisRows }) }],
      1200
    );
  } catch (error) {
    if (error instanceof GeminiConfigurationError) {
      return errorResponse('Configure GEMINI_API_KEY no ambiente privado do servidor. Os alertas de vencimento continuam disponíveis.', 503);
    }
    if (error instanceof GeminiRequestError) {
      console.error('Gemini finance analysis failed:', { kind: error.kind, status: error.status });
      if (error.kind === 'incomplete') return errorResponse('O Gemini não conseguiu concluir a análise. Tente novamente com menos títulos em aberto.', 502);
      if (error.kind === 'timeout') return errorResponse('O Gemini demorou mais de 45 segundos para responder. Tente novamente.', 504);
      if (error.kind === 'network') return errorResponse('O servidor não conseguiu alcançar a API do Gemini. Verifique DNS, firewall e acesso externo.', 502);
      if (error.status === 401 || error.status === 403) return errorResponse('A chave Gemini foi recusada. Confira GEMINI_API_KEY e as permissões da chave.', 502);
      if (error.status === 400 || error.status === 404) return errorResponse('O modelo Gemini configurado foi recusado. Confira GEMINI_MODEL.', 502);
      if (error.status === 429) return errorResponse('O limite gratuito ou a cota da API Gemini foi atingido. Aguarde e tente novamente.', 429);
    }
    return errorResponse('O Gemini retornou uma falha temporária ao analisar os vencimentos.', 502);
  }

  return Response.json({ message: message.slice(0, 4000) }, {
    headers: { 'Cache-Control': 'no-store' }
  });
}