'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Database } from '@/lib/supabase/database.types';
import QRCode from 'qrcode';
import { createPixPayload } from '@/lib/pix-emv.mjs';
import ThemeToggle from '@/components/theme-toggle';
import AccentColorPicker from '@/components/accent-color-picker';

type VariableFee = Database['public']['Tables']['pricing_variable_fees']['Row'];
type FixedExpense = Database['public']['Tables']['pricing_fixed_expenses']['Row'];
type PixPaymentMode = 'manual' | 'mercadopago';

function parseRateBps(value: string) {
  const normalized = value.trim();
  if (!/^\d{1,3}(?:,\d{1,2})?$/.test(normalized)) return null;
  const rate = Number(normalized.replace(',', '.'));
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? Math.round(rate * 100) : null;
}

function formatRate(bps: number) {
  return `${(bps / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}%`;
}

function normalizePixLabel(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parsePixAmountCents(value: string) {
  const normalized = value.trim();
  let whole: string;
  let fraction: string;
  if (normalized.includes(',')) {
    if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+),\d{1,2}$/.test(normalized)) return null;
    [whole, fraction] = normalized.replace(/\./g, '').split(',');
  } else if (normalized.includes('.')) {
    if (/^\d{1,3}(?:\.\d{3})+$/.test(normalized)) {
      whole = normalized.replace(/\./g, '');
      fraction = '';
    } else if (/^\d+\.\d{1,2}$/.test(normalized)) {
      [whole, fraction] = normalized.split('.');
    } else {
      return null;
    }
  } else {
    if (!/^\d+$/.test(normalized)) return null;
    whole = normalized;
    fraction = '';
  }
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 2147483647 ? amount : null;
}

function formatPixMoney(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function errorText(code?: string) {
  if (code === 'PGRST204') return 'Aplique a migration 20261010173000_fixed_expenses_as_percentages.sql no Supabase para usar despesas fixas em percentual.';
  if (code === 'PGRST205' || code === '42P01') return 'Aplique as migrations de configurações, incluindo 20261010195000_pix_payment_settings.sql.';
  if (code === '42501') return 'Seu perfil precisa ser administrador ou gerente para alterar estas configurações.';
  if (code === '23505') return 'Já existe uma taxa ou despesa com esse nome.';
  return 'Não foi possível salvar. Confira os dados e tente novamente.';
}

export default function PricingSettings() {
  const [fees, setFees] = useState<VariableFee[]>([]);
  const [expenses, setExpenses] = useState<FixedExpense[]>([]);
  const activeExpenseRateBps = expenses.reduce(
    (sum, expense) => sum + (expense.active ? expense.rate_bps : 0),
    0
  );
  const [feeName, setFeeName] = useState('');
  const [feeRateInput, setFeeRateInput] = useState('');
  const [expenseName, setExpenseName] = useState('');
  const [expenseRateInput, setExpenseRateInput] = useState('');
  const [pixPaymentMode, setPixPaymentMode] = useState<PixPaymentMode>('manual');
  const [pixKey, setPixKey] = useState('');
  const [merchantName, setMerchantName] = useState('AAC COMERCIAL');
  const [merchantCity, setMerchantCity] = useState('BRASIL');
  const [pixAmountInput, setPixAmountInput] = useState('');
  const [pixPreviewDataUrl, setPixPreviewDataUrl] = useState('');
  const [pixPreviewPayload, setPixPreviewPayload] = useState('');
  const [pixPreviewError, setPixPreviewError] = useState('');
  const [isPixPaymentOpen, setIsPixPaymentOpen] = useState(false);
  const [isPixPaymentConfirmed, setIsPixPaymentConfirmed] = useState(false);
  const [pixPaymentAmountCents, setPixPaymentAmountCents] = useState<number | null>(null);
  const pixPaymentDialogRef = useRef<HTMLDialogElement>(null);
  const [editingFeeId, setEditingFeeId] = useState<string | null>(null);
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [hasLoadedSettings, setHasLoadedSettings] = useState(false);

  const loadSettings = useCallback(async () => {
    const supabase = createClient();
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
    if (claimsError || !claimsData?.claims?.sub) {
      setErrorMessage('Entre novamente para acessar as configurações.');
      return false;
    }
    const { data: profile, error: profileError } = await supabase
      .from('profiles').select('role').eq('user_id', claimsData.claims.sub).maybeSingle();
    if (profileError) {
      setErrorMessage(errorText(profileError.code));
      return false;
    }
    if (!profile || (profile.role !== 'admin' && profile.role !== 'manager')) {
      setCanManage(false);
      return false;
    }
    setCanManage(true);

    const [feesResult, expensesResult, paymentSettingsResult] = await Promise.all([
      supabase.from('pricing_variable_fees').select('*').order('name'),
      supabase.from('pricing_fixed_expenses')
        .select('id,name,rate_bps,monthly_amount_cents,active,created_at,updated_at')
        .order('name'),
      supabase.from('payment_settings').select('*').eq('id', true).maybeSingle()
    ]);
    const queryError = feesResult.error ?? expensesResult.error ?? paymentSettingsResult.error;
    if (queryError) {
      setErrorMessage(errorText(queryError.code));
      return false;
    }
    if (!feesResult.data || !expensesResult.data || !paymentSettingsResult.data) {
      setErrorMessage('Não foi possível carregar as configurações de preço.');
      return false;
    }
    setFees(feesResult.data);
    setExpenses(expensesResult.data);
    setPixPaymentMode(paymentSettingsResult.data.pix_payment_mode === 'mercadopago' ? 'mercadopago' : 'manual');
    setPixKey(paymentSettingsResult.data.pix_key);
    setMerchantName(paymentSettingsResult.data.merchant_name);
    setMerchantCity(paymentSettingsResult.data.merchant_city);
    setErrorMessage('');
    setHasLoadedSettings(true);
    return true;
  }, []);

  useEffect(() => {
    void loadSettings().catch(() => {
      setErrorMessage('Não foi possível carregar as configurações. Verifique sua conexão.');
    }).finally(() => setIsLoading(false));
  }, [loadSettings]);

  useEffect(() => {
    const dialog = pixPaymentDialogRef.current;
    if (isPixPaymentOpen && dialog && !dialog.open) dialog.showModal();
    if (!isPixPaymentOpen && dialog?.open) dialog.close();
  }, [isPixPaymentOpen]);

  async function runSave(action: () => Promise<{ error: { code?: string } | null }>, success: string) {
    setIsSaving(true);
    setErrorMessage('');
    setStatusMessage('');
    try {
      const { error } = await action();
      if (error) {
        setErrorMessage(errorText(error.code));
        return false;
      }
      if (!await loadSettings()) return false;
      setStatusMessage(success);
      return true;
    } catch {
      setErrorMessage('Não foi possível concluir a operação. Verifique sua conexão.');
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function saveFee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = feeName.trim();
    const rate = parseRateBps(feeRateInput);
    if (!name || name.length > 80 || rate === null) {
      setErrorMessage('Informe nome e percentual entre 0 e 100%.');
      return;
    }
    const ok = await runSave(async () => {
      const supabase = createClient();
      const result = editingFeeId
        ? await supabase.from('pricing_variable_fees').update({ name, rate_bps: rate }).eq('id', editingFeeId)
        : await supabase.from('pricing_variable_fees').insert({ name, rate_bps: rate });
      return { error: result.error };
    }, 'Taxa variável salva.');
    if (ok) {
      setFeeName('');
      setFeeRateInput('');
      setEditingFeeId(null);
    }
  }

  async function saveExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = expenseName.trim();
    const rate = parseRateBps(expenseRateInput);
    if (!name || name.length > 80 || rate === null) {
      setErrorMessage('Informe nome e percentual entre 0 e 100%.');
      return;
    }

    const ok = await runSave(async () => {
      const supabase = createClient();
      const result = editingExpenseId
        ? await supabase.from('pricing_fixed_expenses').update({ name, rate_bps: rate }).eq('id', editingExpenseId)
        : await supabase.from('pricing_fixed_expenses').insert({
            name,
            rate_bps: rate,
            monthly_amount_cents: 0
          });
      return { error: result.error };
    }, 'Percentual de despesa fixa salvo.');
    if (ok) {
      setExpenseName('');
      setExpenseRateInput('');
      setEditingExpenseId(null);
    }
  }

  async function savePixSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedPixKey = pixKey.trim();
    const normalizedMerchantName = merchantName.trim();
    const normalizedMerchantCity = merchantCity.trim();
    const pixMerchantName = normalizePixLabel(normalizedMerchantName);
    const pixMerchantCity = normalizePixLabel(normalizedMerchantCity);
    if (!/^[\x21-\x7e]{1,77}$/.test(normalizedPixKey)
      || !pixMerchantName || pixMerchantName.length > 25
      || !pixMerchantCity || pixMerchantCity.length > 15) {
      setErrorMessage('Informe uma chave Pix válida e o nome/cidade do recebedor nos limites indicados.');
      return;
    }
    await runSave(async () => {
      const { error } = await createClient().from('payment_settings').update({
        pix_payment_mode: pixPaymentMode,
        pix_key: normalizedPixKey,
        merchant_name: normalizedMerchantName,
        merchant_city: normalizedMerchantCity
      }).eq('id', true);
      return { error };
    }, 'Configurações de pagamento Pix salvas.');
  }

  async function generateSettingsPixQr() {
    const amountCents = parsePixAmountCents(pixAmountInput);
    if (amountCents === null) {
      setPixPreviewError('Informe um valor válido maior que R$ 0,00.');
      setPixPreviewDataUrl('');
      setPixPreviewPayload('');
      return;
    }
    const payload = createPixPayload({
      amountCents,
      pixKey: pixKey.trim(),
      merchantName: normalizePixLabel(merchantName).slice(0, 25),
      merchantCity: normalizePixLabel(merchantCity).slice(0, 15),
      reference: `AAC${Date.now().toString(36).toUpperCase()}`
    });
    if (!payload) {
      setPixPreviewError('Confira a chave Pix, o nome e a cidade do recebedor.');
      setPixPreviewDataUrl('');
      setPixPreviewPayload('');
      return;
    }
    setPixPreviewError('');
    setPixPreviewDataUrl('');
    setIsPixPaymentConfirmed(false);
    try {
      const dataUrl = await QRCode.toDataURL(payload, {
        width: 440,
        margin: 2,
        errorCorrectionLevel: 'M'
      });
      setPixPreviewPayload(payload);
      setPixPreviewDataUrl(dataUrl);
      setPixPaymentAmountCents(amountCents);
      setIsPixPaymentOpen(true);
    } catch {
      setPixPreviewError('Não foi possível gerar o QR Code Pix.');
    }
  }

  function closePixPayment() {
    setIsPixPaymentOpen(false);
    setIsPixPaymentConfirmed(false);
    setPixPreviewDataUrl('');
    setPixPreviewPayload('');
  }

  async function copySettingsPixPayload() {
    try {
      await navigator.clipboard.writeText(pixPreviewPayload);
      setPixPreviewError('Código Pix copiado.');
    } catch {
      setPixPreviewError('Não foi possível copiar o código Pix.');
    }
  }

  async function toggleFee(fee: VariableFee) {
    await runSave(async () => {
      const { error } = await createClient().from('pricing_variable_fees').update({ active: !fee.active }).eq('id', fee.id);
      return { error };
    }, fee.active ? 'Taxa desativada.' : 'Taxa ativada.');
  }

  async function toggleExpense(expense: FixedExpense) {
    await runSave(async () => {
      const { error } = await createClient().from('pricing_fixed_expenses').update({ active: !expense.active }).eq('id', expense.id);
      return { error };
    }, expense.active ? 'Despesa desativada.' : 'Despesa ativada.');
  }

  async function deleteFee(fee: VariableFee) {
    if (!window.confirm(`Excluir a taxa “${fee.name}”?`)) return;
    await runSave(async () => {
      const { error } = await createClient().from('pricing_variable_fees').delete().eq('id', fee.id);
      return { error };
    }, 'Taxa removida.');
  }

  async function deleteExpense(expense: FixedExpense) {
    if (!window.confirm(`Excluir a despesa “${expense.name}”?`)) return;
    await runSave(async () => {
      const { error } = await createClient().from('pricing_fixed_expenses').delete().eq('id', expense.id);
      return { error };
    }, 'Despesa removida.');
  }

  if (isLoading) return <p className="catalog-state" role="status">Carregando configurações…</p>;
  if (canManage !== true || !hasLoadedSettings) return (
    <section className="setup-notice" aria-labelledby="settingsAccessTitle">
      <h2 id="settingsAccessTitle">{canManage === false ? 'Acesso restrito' : 'Configurações indisponíveis'}</h2>
      <p>{canManage === false
        ? 'As configurações de preço estão disponíveis apenas para perfis de administrador e gerente.'
        : errorMessage || 'Não foi possível carregar os parâmetros de preço.'}</p>
    </section>
  );

  return (
    <section className="settings-layout" aria-label="Preferências do A.A.C.">
      <div className="settings-intro">
        <h2>Preferências do A.A.C.</h2>
        <p>Configure cálculos, recebimentos Pix e aparência do sistema.</p>
      </div>
      <details className="settings-additional settings-section">
        <summary>
          Parâmetros da calculadora
          <span className="settings-summary-description">Taxas variáveis, tributos e despesas fixas usadas na formação de preços.</span>
        </summary>
        <div className="settings-columns">
        <section className="catalog-form settings-card">
          <h2>Taxas variáveis personalizadas</h2>
          <p>Comissões, tarifas de venda e tributos: tudo cadastrado aqui compõe o percentual variável da calculadora.</p>
          <form className="settings-entry-form" onSubmit={saveFee}>
            <label className="pricing-field">Nome<input value={feeName} onChange={event => setFeeName(event.target.value)} maxLength={80} placeholder="Ex.: Comissão" required /></label>
            <label className="pricing-field">Percentual (%)<input value={feeRateInput} onChange={event => setFeeRateInput(event.target.value)} inputMode="decimal" placeholder="0,00" required /></label>
            <div className="settings-entry-actions">
              <button className="button button-primary" type="submit" disabled={isSaving}>{editingFeeId ? 'Salvar alterações' : 'Adicionar taxa'}</button>
              {editingFeeId && <button className="button button-secondary" type="button" onClick={() => { setEditingFeeId(null); setFeeName(''); setFeeRateInput(''); }}>Cancelar</button>}
            </div>
          </form>
          <ul className="settings-list">
            {fees.map(fee => (
              <li className={!fee.active ? 'settings-disabled' : ''} key={fee.id}>
                <span><strong>{fee.name}</strong><small>{formatRate(fee.rate_bps)} · {fee.active ? 'Ativa' : 'Inativa'}</small></span>
                <div>
                  <button className="button button-secondary" type="button" onClick={() => { setEditingFeeId(fee.id); setFeeName(fee.name); setFeeRateInput((fee.rate_bps / 100).toFixed(2).replace('.', ',')); }}>Editar</button>
                  <button className="button button-secondary" type="button" onClick={() => void toggleFee(fee)} disabled={isSaving}>{fee.active ? 'Desativar' : 'Ativar'}</button>
                  <button className="button button-secondary" type="button" onClick={() => void deleteFee(fee)} disabled={isSaving}>Excluir</button>
                </div>
              </li>
            ))}
            {fees.length === 0 && <li className="settings-empty">Nenhuma taxa personalizada cadastrada.</li>}
          </ul>
        </section>

        <section className="catalog-form settings-card">
          <h2>Despesas fixas (%)</h2>
          <p>Cadastre o percentual de cada conta sobre o preço de venda. A soma das despesas ativas será aplicada diretamente no markup da calculadora.</p>
          <p className="pricing-current-price">Percentual fixo ativo na calculadora: <strong>{formatRate(activeExpenseRateBps)}</strong></p>
          <form className="settings-entry-form" onSubmit={saveExpense}>
            <label className="pricing-field">Nome<input value={expenseName} onChange={event => setExpenseName(event.target.value)} maxLength={80} placeholder="Ex.: Energia" required /></label>
            <label className="pricing-field">Percentual (%)<input value={expenseRateInput} onChange={event => setExpenseRateInput(event.target.value)} inputMode="decimal" placeholder="0,00" required /></label>
            <div className="settings-entry-actions">
              <button className="button button-primary" type="submit" disabled={isSaving}>{editingExpenseId ? 'Salvar alterações' : 'Adicionar despesa'}</button>
              {editingExpenseId && <button className="button button-secondary" type="button" onClick={() => { setEditingExpenseId(null); setExpenseName(''); setExpenseRateInput(''); }}>Cancelar</button>}
            </div>
          </form>
          <ul className="settings-list">
            {expenses.map(expense => (
              <li className={!expense.active ? 'settings-disabled' : ''} key={expense.id}>
                <span><strong>{expense.name}</strong><small>{formatRate(expense.rate_bps)} · {expense.active ? 'Ativa' : 'Inativa'}</small></span>
                <div>
                  <button className="button button-secondary" type="button" onClick={() => { setEditingExpenseId(expense.id); setExpenseName(expense.name); setExpenseRateInput((expense.rate_bps / 100).toFixed(2).replace('.', ',')); }}>Editar</button>
                  <button className="button button-secondary" type="button" onClick={() => void toggleExpense(expense)} disabled={isSaving}>{expense.active ? 'Desativar' : 'Ativar'}</button>
                  <button className="button button-secondary" type="button" onClick={() => void deleteExpense(expense)} disabled={isSaving}>Excluir</button>
                </div>
              </li>
            ))}
            {expenses.length === 0 && <li className="settings-empty">Nenhuma despesa fixa cadastrada.</li>}
          </ul>
        </section>
        </div>
      </details>
      <details className="settings-additional">
        <summary>
          Configurações adicionais
          <span className="settings-summary-description">Preferências de recebimentos e integração Pix.</span>
        </summary>
        <form className="catalog-form settings-card pix-settings-form" onSubmit={savePixSettings}>
          <h2>Recebimentos Pix no PDV</h2>
          <p>A chave cadastrada será usada no QR do modo manual. No modo Mercado Pago, o pagamento é creditado na conta vinculada ao token privado; confirme que essa conta corresponde ao recebedor configurado.</p>
          <label className="pricing-field">Forma de confirmação
            <select value={pixPaymentMode} onChange={event => setPixPaymentMode(event.target.value as PixPaymentMode)}>
              <option value="manual">QR Pix sem API — confirmar manualmente</option>
              <option value="mercadopago">Mercado Pago API — confirmar pagamento automaticamente</option>
            </select>
          </label>
          <label className="pricing-field">Chave Pix do recebedor
            <input value={pixKey} onChange={event => { setPixKey(event.target.value); setPixPreviewDataUrl(''); setPixPreviewPayload(''); }} maxLength={77} autoComplete="off" placeholder="CPF/CNPJ, e-mail, telefone ou chave aleatória" required />
          </label>
          <div className="settings-entry-form">
            <label className="pricing-field">Nome do recebedor
              <input value={merchantName} onChange={event => { setMerchantName(event.target.value); setPixPreviewDataUrl(''); setPixPreviewPayload(''); }} maxLength={25} required />
            </label>
            <label className="pricing-field">Cidade do recebedor
              <input value={merchantCity} onChange={event => { setMerchantCity(event.target.value); setPixPreviewDataUrl(''); setPixPreviewPayload(''); }} maxLength={15} required />
            </label>
          </div>
          <div className="settings-pix-generator">
            <h3>Gerar QR Pix com valor</h3>
            <p>Gera um QR estático usando a chave acima e o valor informado. Não consulta API; a confirmação do pagamento é manual.</p>
            <label className="pricing-field">Valor a cobrar (R$)
              <input value={pixAmountInput} onChange={event => { setPixAmountInput(event.target.value); setPixPreviewDataUrl(''); setPixPreviewPayload(''); setPixPreviewError(''); }} inputMode="decimal" placeholder="Ex.: 125,90" />
            </label>
            <button className="button button-secondary" type="button" onClick={() => void generateSettingsPixQr()} disabled={!pixKey.trim()}>
              Gerar QR Code Pix
            </button>
            {pixPreviewError && <p className="form-message" role="status">{pixPreviewError}</p>}
          </div>
          <p className="settings-security-note">Para usar a API, configure <code>MP_ACCESS_TOKEN</code> como variável privada no servidor (local e Vercel). Nunca cole esse token aqui nem use um prefixo <code>NEXT_PUBLIC_</code>.</p>
          <button className="button button-primary" type="submit" disabled={isSaving}>Salvar configurações Pix</button>
        </form>
      </details>
      {isPixPaymentOpen && pixPreviewDataUrl && (
        <dialog
          ref={pixPaymentDialogRef}
          className="settings-pix-payment-dialog"
          aria-labelledby="settingsPixPaymentTitle"
          onCancel={event => {
            event.preventDefault();
            closePixPayment();
          }}
          onClose={() => setIsPixPaymentOpen(false)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || isPixPaymentConfirmed) return;
            if (event.target instanceof HTMLElement && event.target.closest('button')) return;
            event.preventDefault();
            setIsPixPaymentConfirmed(true);
          }}
        >
          <button className="checkout-close" type="button" onClick={closePixPayment} aria-label="Fechar pagamento Pix">×</button>
          <div className="settings-pix-payment-content">
            <p className="eyebrow">PAGAMENTO PIX MANUAL</p>
            <h2 id="settingsPixPaymentTitle">Leia o QR Code para pagar</h2>
            <img className="settings-pix-payment-qr" src={pixPreviewDataUrl} alt="QR Code Pix com valor informado" />
            <strong className="settings-pix-payment-amount">
              {formatPixMoney(pixPaymentAmountCents ?? 0)}
            </strong>
            <p className={`settings-pix-payment-status${isPixPaymentConfirmed ? ' settings-pix-payment-status-confirmed' : ''}`} role="status" aria-live="polite">
              {!isPixPaymentConfirmed && <span className="payment-spinner" aria-hidden="true" />}
              {isPixPaymentConfirmed ? 'Pagamento confirmado' : 'Aguardando confirmação'}
            </p>
            <button
              className="button settings-pix-confirm-button"
              type="button"
              autoFocus
              onClick={() => isPixPaymentConfirmed ? closePixPayment() : setIsPixPaymentConfirmed(true)}
            >
              {isPixPaymentConfirmed ? 'Fechar pagamento' : 'Pagamento confirmado'}
            </button>
            {!isPixPaymentConfirmed && (
              <button className="button button-secondary settings-pix-copy-button" type="button" onClick={() => void copySettingsPixPayload()}>
                Copiar código Pix
              </button>
            )}
            {pixPreviewError && <p className="settings-pix-payment-copy-status" role="status">{pixPreviewError}</p>}
          </div>
        </dialog>
      )}
      <details className="settings-additional">
        <summary>
          Personalização
          <span className="settings-summary-description">Ajuste a cor de destaque e o modo de exibição do A.A.C.</span>
        </summary>
        <section className="catalog-form settings-card personalization-card" aria-label="Personalização visual">
          <div>
            <h2>Aparência do sistema</h2>
            <p>Escolha uma cor de destaque e alterne entre os modos claro e escuro.</p>
          </div>
          <AccentColorPicker />
          <div className="personalization-theme">
            <span>Modo de exibição</span>
            <ThemeToggle />
          </div>
        </section>
      </details>
      {errorMessage && <p className="pricing-message pricing-message-error" role="alert">{errorMessage}</p>}
      {statusMessage && <p className="pricing-message" role="status">{statusMessage}</p>}
    </section>
  );
}
