import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';

type ContextDomain = 'inventory' | 'finance';
type ContextSnapshot = { domain: ContextDomain; available: boolean; records: unknown[]; note?: string };

function requestedDomains(question: string, previousQuestion: string): ContextDomain[] {
  const text = question.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  const previous = previousQuestion.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  const general = /\b(resumo|geral|negocio|empresa|banco de dados|meus dados|dados do sistema)\b/.test(text);
  const domains: ContextDomain[] = [];
  if (general || /\b(estoque|produto|produtos|catalogo|repor|saldo)\b/.test(text)) domains.push('inventory');
  if (general || /\b(nota|notas|boleto|financeiro|financas|pagar|pagamento|imposto|tributo|vencimento|vencer|fornecedor|compra)\b/.test(text)) domains.push('finance');
  if (!domains.length && /\b(eles|elas|deles|delas|desses|dessas|isso|esses|essas|quais|quantos|quantas)\b/.test(text)) {
    if (/\b(estoque|produto|produtos|catalogo|repor|saldo)\b/.test(previous)) domains.push('inventory');
    if (/\b(nota|notas|boleto|financeiro|financas|pagar|pagamento|imposto|tributo|vencimento|vencer|fornecedor|compra)\b/.test(previous)) domains.push('finance');
  }
  return domains;
}

export async function loadAssistantContext(
  supabase: SupabaseClient<Database>,
  question: string,
  previousQuestion = ''
) {
  const domains = requestedDomains(question, previousQuestion);
  if (!domains.length) return { snapshots: [] as ContextSnapshot[], generatedAt: new Date().toISOString() };

  const snapshots = await Promise.all(domains.map(async (domain): Promise<ContextSnapshot> => {
    if (domain === 'inventory') {
      const { data, error } = await supabase.from('products')
        .select('product_code,name,unit,unit_price_cents,stock_quantity')
        .eq('active', true).order('name').limit(100);
      if (error || !data) {
        console.error('Assistant inventory context query failed:', error?.code ?? 'missing data');
        return { domain, available: false, records: [], note: 'Catálogo indisponível para esta sessão.' };
      }
      return {
        domain,
        available: true,
        records: data.slice(0, 60).map(product => ({
          code: product.product_code,
          name: product.name,
          unit: product.unit,
          stockQuantity: product.stock_quantity,
          priceCents: product.unit_price_cents
        })),
        note: data.length >= 60 ? 'Amostra limitada aos primeiros 60 produtos por nome; não use para inferir totais do catálogo.' : undefined
      };
    }

    const { data: payables, error: payablesError } = await supabase.from('invoice_payables')
      .select('invoice_id,due_date,tax_total_cents,is_paid,paid_at')
      .order('due_date', { ascending: true }).limit(100);
    if (payablesError || !payables) {
      console.error('Assistant payable context query failed:', payablesError?.code ?? 'missing data');
      const note = payablesError?.code === 'PGRST205' || payablesError?.code === '42P01'
        ? 'Contas a pagar indisponíveis: aplique a migration financeira no Supabase.'
        : 'Contas a pagar indisponíveis para esta sessão.';
      return { domain, available: false, records: [], note };
    }
    if (!payables.length) return { domain, available: true, records: [], note: 'Nenhum título financeiro registrado.' };

    const { data: invoices, error: invoicesError } = await supabase.from('purchase_invoices')
      .select('id,supplier_name,invoice_number,issue_date,total_cents')
      .in('id', payables.map(payable => payable.invoice_id));
    if (invoicesError || !invoices) {
      console.error('Assistant invoice context query failed:', invoicesError?.code ?? 'missing data');
      return { domain, available: false, records: [], note: 'Notas indisponíveis para esta sessão.' };
    }

    const invoiceById = new Map(invoices.map(invoice => [invoice.id, invoice]));
    const today = new Date().toISOString().slice(0, 10);
    const todayUtc = Date.parse(`${today}T00:00:00.000Z`);
    const records = payables.flatMap(payable => {
      const invoice = invoiceById.get(payable.invoice_id);
      if (!invoice) return [];
      const daysUntilDue = Math.round((Date.parse(`${payable.due_date}T00:00:00.000Z`) - todayUtc) / 86400000);
      return [{
        supplier: invoice.supplier_name,
        invoiceNumber: invoice.invoice_number,
        issueDate: invoice.issue_date,
        dueDate: payable.due_date,
        daysUntilDue,
        amountCents: invoice.total_cents,
        taxCents: payable.tax_total_cents,
        status: payable.is_paid ? 'pago' : daysUntilDue < 0 ? 'vencido' : 'em aberto',
        paidAt: payable.paid_at
      }];
    });
    return {
      domain,
      available: true,
      records: records.slice(0, 60),
      note: records.length >= 60 ? 'Amostra limitada aos 60 títulos mais próximos por vencimento; não use para inferir totais financeiros.' : undefined
    };
  }));

  return { snapshots, generatedAt: new Date().toISOString() };
}