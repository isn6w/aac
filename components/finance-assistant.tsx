'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Database } from '@/lib/supabase/database.types';
import { getDaysUntilDue, getPayableStatus } from '@/lib/finance-reminders.mjs';

type Payable = Database['public']['Tables']['invoice_payables']['Row'];
type Invoice = Pick<Database['public']['Tables']['purchase_invoices']['Row'],
  'id' | 'supplier_name' | 'invoice_number' | 'issue_date' | 'total_cents'>;
type FinanceRow = { payable: Payable; invoice: Invoice };
type Filter = 'all' | 'upcoming' | 'overdue' | 'paid';
type PayableDraft = { dueDate: string; tax: string; boletoReference: string };

function formatMoney(cents: number | null) {
  if (cents === null) return 'Não informado';
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString('pt-BR');
}

function parseTaxCents(value: string) {
  const normalized = value.trim();
  if (!normalized) return null;
  if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(normalized)) return Number.NaN;
  const [reais, cents = ''] = normalized.replace(/\./g, '').split(',');
  const amount = Number(reais) * 100 + Number(cents.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount <= 2147483647 ? amount : Number.NaN;
}

function messageForError(code?: string) {
  if (code === '42501') return 'Seu perfil precisa ser administrador ou gerente para acessar o financeiro.';
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42P01') {
    return 'Aplique a migration 20261013120000_invoice_payables.sql no Supabase.';
  }
  return 'Não foi possível concluir a operação. Verifique a conexão e tente novamente.';
}

export default function FinanceAssistant() {
  const [rows, setRows] = useState<FinanceRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, PayableDraft>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState<string | null>(null);
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [aiMessage, setAiMessage] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const loadPayables = useCallback(async () => {
    const supabase = createClient();
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
    if (claimsError || !claimsData?.claims?.sub) {
      setErrorMessage('Entre novamente para acessar o assistente financeiro.');
      setCanManage(false);
      return false;
    }
    const { data: profile, error: profileError } = await supabase.from('profiles')
      .select('role').eq('user_id', claimsData.claims.sub).maybeSingle();
    if (profileError) {
      setErrorMessage(messageForError(profileError.code));
      return false;
    }
    if (!profile || (profile.role !== 'admin' && profile.role !== 'manager')) {
      setCanManage(false);
      return true;
    }
    setCanManage(true);

    const { data: payables, error: payablesError } = await supabase.from('invoice_payables')
      .select('*').order('is_paid', { ascending: true }).order('due_date', { ascending: true });
    if (payablesError) {
      setErrorMessage(messageForError(payablesError.code));
      return false;
    }
    if (!payables?.length) {
      setRows([]);
      setErrorMessage('');
      return true;
    }

    const { data: invoices, error: invoicesError } = await supabase.from('purchase_invoices')
      .select('id,supplier_name,invoice_number,issue_date,total_cents')
      .in('id', payables.map(payable => payable.invoice_id));
    if (invoicesError || !invoices) {
      setErrorMessage(messageForError(invoicesError?.code));
      return false;
    }
    const invoiceById = new Map(invoices.map(invoice => [invoice.id, invoice]));
    setRows(payables.flatMap(payable => {
      const invoice = invoiceById.get(payable.invoice_id);
      return invoice ? [{ payable, invoice }] : [];
    }));
    setErrorMessage('');
    return true;
  }, []);

  useEffect(() => {
    void loadPayables().catch(() => setErrorMessage('Não foi possível carregar as contas a pagar.'))
      .finally(() => setIsLoading(false));
  }, [loadPayables]);

  const counts = useMemo(() => rows.reduce((result, row) => {
    const status = getPayableStatus(row.payable);
    if (status === 'overdue') result.overdue += 1;
    if (status === 'due-soon') result.dueSoon += 1;
    if (status === 'paid') result.paid += 1;
    return result;
  }, { overdue: 0, dueSoon: 0, paid: 0 }), [rows]);

  const visibleRows = useMemo(() => rows.filter(({ payable }) => {
    const status = getPayableStatus(payable);
    if (filter === 'paid') return status === 'paid';
    if (filter === 'overdue') return status === 'overdue';
    if (filter === 'upcoming') return status === 'due-soon' || status === 'upcoming';
    return true;
  }), [filter, rows]);

  function draftFor(row: FinanceRow): PayableDraft {
    return drafts[row.payable.invoice_id] ?? {
      dueDate: row.payable.due_date,
      tax: row.payable.tax_total_cents === null
        ? ''
        : (row.payable.tax_total_cents / 100).toFixed(2).replace('.', ','),
      boletoReference: row.payable.boleto_reference ?? ''
    };
  }

  async function saveDetails(row: FinanceRow) {
    const draft = draftFor(row);
    const taxTotalCents = parseTaxCents(draft.tax);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate)
      || (typeof taxTotalCents === 'number' && !Number.isFinite(taxTotalCents))
      || draft.boletoReference.length > 200) {
      setErrorMessage('Informe vencimento válido, impostos com valor válido e referência de até 200 caracteres.');
      return;
    }
    setIsSaving(row.payable.invoice_id);
    setErrorMessage('');
    setStatusMessage('');
    try {
      const { error } = await createClient().rpc('update_invoice_payable', {
        p_invoice_id: row.payable.invoice_id,
        p_due_date: draft.dueDate,
        p_tax_total_cents: taxTotalCents,
        p_boleto_reference: draft.boletoReference.trim() || null
      });
      if (error) throw new Error(messageForError(error.code));
      if (!await loadPayables()) return;
      setDrafts(current => { const next = { ...current }; delete next[row.payable.invoice_id]; return next; });
      setStatusMessage(`Dados do boleto da nota ${row.invoice.invoice_number} atualizados.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Não foi possível salvar os dados do boleto.');
    } finally {
      setIsSaving(null);
    }
  }

  async function setPaid(row: FinanceRow, isPaid: boolean) {
    setIsSaving(row.payable.invoice_id);
    setErrorMessage('');
    setStatusMessage('');
    try {
      const { error } = await createClient().rpc('set_invoice_payable_paid', {
        p_invoice_id: row.payable.invoice_id,
        p_is_paid: isPaid
      });
      if (error) throw new Error(messageForError(error.code));
      await loadPayables();
      setStatusMessage(isPaid
        ? `Nota ${row.invoice.invoice_number} marcada como paga.`
        : `Pagamento da nota ${row.invoice.invoice_number} reaberto.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Não foi possível atualizar o pagamento.');
    } finally {
      setIsSaving(null);
    }
  }

  async function requestAiReview() {
    setIsAnalyzing(true);
    setAiMessage('');
    try {
      const response = await fetch('/api/finance/reminders', { method: 'POST', cache: 'no-store' });
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object') throw new Error('Resposta inválida do assistente.');
      const data = result as { message?: unknown; error?: unknown };
      if (!response.ok) throw new Error(typeof data.error === 'string'
        ? data.error
        : 'Não foi possível analisar os vencimentos.');
      if (typeof data.message !== 'string') throw new Error('O assistente não retornou uma análise válida.');
      setAiMessage(data.message);
    } catch (error) {
      setAiMessage(error instanceof Error ? error.message : 'Não foi possível consultar o assistente de IA.');
    } finally {
      setIsAnalyzing(false);
    }
  }

  if (isLoading) return <p className="catalog-state" role="status">Carregando contas a pagar…</p>;
  if (canManage === false) return (
    <section className="setup-notice"><h2>Acesso restrito</h2><p>O assistente financeiro está disponível apenas para administradores e gerentes.</p></section>
  );

  return (
    <section className="finance-layout" aria-label="Assistente financeiro">
      <div className="finance-summary" aria-label="Resumo de vencimentos">
        <div><span>Vencidos</span><strong>{counts.overdue}</strong></div>
        <div><span>Vencem em até 7 dias</span><strong>{counts.dueSoon}</strong></div>
        <div><span>Pagos</span><strong>{counts.paid}</strong></div>
      </div>

      {(counts.overdue > 0 || counts.dueSoon > 0) && (
        <div className="finance-alert" role="status">
          <strong>Revisar vencimentos</strong>
          <span>{counts.overdue ? `${counts.overdue} boleto(s) vencido(s)` : ''}{counts.overdue && counts.dueSoon ? ' · ' : ''}{counts.dueSoon ? `${counts.dueSoon} vencem nos próximos 7 dias` : ''}.</span>
        </div>
      )}

      <section className="catalog-form finance-ai" aria-labelledby="financeAiTitle">
        <div><p className="eyebrow">ASSISTENTE DE PAGAMENTO</p><h2 id="financeAiTitle">Análise de vencimentos com IA</h2>
          <p>Receba uma síntese de prioridades. A chave da IA fica somente no servidor e os dados financeiros serão enviados ao provedor quando você solicitar a análise.</p></div>
        <button className="button button-secondary" type="button" onClick={() => void requestAiReview()} disabled={isAnalyzing || rows.length === 0}>
          {isAnalyzing ? 'Analisando vencimentos…' : 'Analisar com IA'}
        </button>
        {aiMessage && <p className="finance-ai-message" role="status">{aiMessage}</p>}
      </section>

      <section className="finance-payables" aria-labelledby="payablesTitle">
        <div className="finance-list-heading"><div><h2 id="payablesTitle">Notas e boletos</h2><p>Em aberto primeiro, ordenados do vencimento mais próximo ao mais distante.</p></div>
          <div className="finance-filters" role="group" aria-label="Filtrar boletos">
            {([['all', 'Todos'], ['upcoming', 'A vencer'], ['overdue', 'Vencidos'], ['paid', 'Pagos']] as const).map(([key, label]) => (
              <button className={filter === key ? 'finance-filter-active' : ''} key={key} type="button" onClick={() => setFilter(key)} aria-pressed={filter === key}>{label}</button>
            ))}
          </div>
        </div>
        {visibleRows.length ? (
          <div className="finance-list">
            {visibleRows.map(row => {
              const draft = draftFor(row);
              const payableStatus = getPayableStatus(row.payable);
              const daysUntilDue = getDaysUntilDue(row.payable.due_date);
              const statusLabel = payableStatus === 'paid' ? 'Pago'
                : payableStatus === 'overdue' ? `Vencido há ${Math.abs(daysUntilDue ?? 0)} dia(s)`
                  : payableStatus === 'due-soon' ? daysUntilDue === 0 ? 'Vence hoje' : `Vence em ${daysUntilDue} dia(s)`
                    : 'A vencer';
              return (
                <article className="finance-payable" key={row.payable.invoice_id}>
                  <div className="finance-payable-main">
                    <div className="finance-payable-title"><div><h3>{row.invoice.supplier_name}</h3><p>Nota {row.invoice.invoice_number} · emitida em {formatDate(row.invoice.issue_date)}</p></div>
                      <span className={`finance-status finance-status-${payableStatus}`}>{statusLabel}</span></div>
                    <dl className="finance-payable-values">
                      <div><dt>Vencimento</dt><dd>{formatDate(row.payable.due_date)}</dd></div>
                      <div><dt>Valor da nota</dt><dd>{formatMoney(row.invoice.total_cents)}</dd></div>
                      <div><dt>Impostos</dt><dd>{formatMoney(row.payable.tax_total_cents)}</dd></div>
                      <div><dt>Boleto</dt><dd>{row.payable.boleto_reference || 'Referência não informada'}</dd></div>
                    </dl>
                    <div className="finance-payable-actions">
                      <button className="button button-primary" type="button" onClick={() => void setPaid(row, !row.payable.is_paid)} disabled={isSaving === row.payable.invoice_id}>
                        {isSaving === row.payable.invoice_id ? 'Salvando…' : row.payable.is_paid ? 'Desfazer pagamento' : 'Marcar como pago'}
                      </button>
                      <details className="finance-edit">
                        <summary>Editar vencimento e boleto</summary>
                        <div className="finance-edit-fields">
                          <label>Data de vencimento<input type="date" value={draft.dueDate} onChange={event => setDrafts(current => ({ ...current, [row.payable.invoice_id]: { ...draft, dueDate: event.target.value } }))} /></label>
                          <label>Impostos da nota (R$)<input inputMode="decimal" placeholder="Não informado" value={draft.tax} onChange={event => setDrafts(current => ({ ...current, [row.payable.invoice_id]: { ...draft, tax: event.target.value } }))} /></label>
                          <label className="finance-reference-field">Linha digitável ou referência<input maxLength={200} value={draft.boletoReference} onChange={event => setDrafts(current => ({ ...current, [row.payable.invoice_id]: { ...draft, boletoReference: event.target.value } }))} /></label>
                          <button className="button button-secondary" type="button" onClick={() => void saveDetails(row)} disabled={isSaving === row.payable.invoice_id}>{isSaving === row.payable.invoice_id ? 'Salvando…' : 'Salvar dados'}</button>
                        </div>
                      </details>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="catalog-empty"><h3>{rows.length ? 'Nenhum boleto neste filtro' : 'Nenhuma nota cadastrada'}</h3><p>{rows.length ? 'Escolha outro filtro para consultar os boletos.' : 'Ao registrar uma nota em Entrada de notas, o título será criado aqui automaticamente.'}</p></div>
        )}
      </section>
      {errorMessage && <p className="pricing-message-error" role="alert">{errorMessage}</p>}
      {statusMessage && <p className="pricing-message" role="status">{statusMessage}</p>}
    </section>
  );
}