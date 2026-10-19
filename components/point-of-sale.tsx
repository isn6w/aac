'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Database, Product } from '@/lib/supabase/database.types';
import { calculateChange, calculateSaleLine } from '@/lib/pos-calculation.mjs';
import { createPixPayload } from '@/lib/pix-emv.mjs';
import QRCode from 'qrcode';

type SaleLine = {
  product: Product;
  quantity: string;
  unitPrice: string;
  discount: string;
};
type PaymentMethod = 'cash' | 'pix' | 'credit' | 'debit';
type CheckoutStep = 'review' | 'awaiting-payment';
type PaymentSettings = Database['public']['Tables']['payment_settings']['Row'];
type MercadoPagoStatus = 'idle' | 'creating' | 'pending' | 'approved' | 'rejected' | 'expired';

function parseMoneyCents(value: string) {
  const normalized = value.trim();
  if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(normalized)) return null;
  const [reais, cents = ''] = normalized.replace(/\./g, '').split(',');
  const amount = Number(reais) * 100 + Number(cents.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 2147483647 ? amount : null;
}

function parseQuantityMilli(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) return null;
  const milli = Math.round(Number(normalized) * 1000);
  return Number.isSafeInteger(milli) && milli > 0 ? milli : null;
}

function parseDiscountBps(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const bps = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(bps) && bps >= 0 && bps <= 10000 ? bps : null;
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatMoneyInput(cents: number) {
  return (cents / 100).toFixed(2).replace('.', ',');
}

function formatQuantity(milli: number) {
  return (milli / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

function normalizePixLabel(value: string, maxLength: number) {
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  return normalized.slice(0, maxLength);
}

function buildPixPayload(totalCents: number, reference: string, settings: PaymentSettings | null) {
  if (!settings?.pix_key.trim()) return null;
  return createPixPayload({
    amountCents: totalCents,
    pixKey: settings.pix_key.trim(),
    merchantName: normalizePixLabel(settings.merchant_name, 25),
    merchantCity: normalizePixLabel(settings.merchant_city, 15),
    reference
  });
}

function getErrorMessage(code?: string) {
  if (code === '42501') return 'Sua conta não tem permissão para finalizar a venda ou alterar preço/desconto.';
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42P01') {
    return 'Aplique as migrations de vendas em ordem: 20261010190000_sales_and_markup_invoice_import.sql e depois 20261010193500_sale_installments.sql.';
  }
  if (code === 'P0001') return 'O estoque ou os dados de pagamento mudaram. Revise a venda e tente novamente.';
  return 'Não foi possível finalizar a venda. Verifique a conexão e tente novamente.';
}

export default function PointOfSale() {
  const [products, setProducts] = useState<Product[]>([]);
  const [canEditPriceAndDiscount, setCanEditPriceAndDiscount] = useState(false);
  const [pricingPermissionMessage, setPricingPermissionMessage] = useState('');
  const [lines, setLines] = useState<SaleLine[]>([]);
  const [selectedLineProductId, setSelectedLineProductId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [paymentSettings, setPaymentSettings] = useState<PaymentSettings | null>(null);
  const [paymentSettingsError, setPaymentSettingsError] = useState('');
  const [receivedInput, setReceivedInput] = useState('');
  const [installments, setInstallments] = useState(1);
  const [checkoutStep, setCheckoutStep] = useState<CheckoutStep>('review');
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [pixQrDataUrl, setPixQrDataUrl] = useState('');
  const [pixPayload, setPixPayload] = useState('');
  const [pixError, setPixError] = useState('');
  const [payerEmail, setPayerEmail] = useState('');
  const [mercadoPagoQr, setMercadoPagoQr] = useState('');
  const [mercadoPagoCopyCode, setMercadoPagoCopyCode] = useState('');
  const [mercadoPagoTicket, setMercadoPagoTicket] = useState('');
  const [mercadoPagoStatus, setMercadoPagoStatus] = useState<MercadoPagoStatus>('idle');
  const [isPixFinalizationVerified, setIsPixFinalizationVerified] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const checkoutDialogRef = useRef<HTMLDialogElement>(null);
  const finalizationInProgressRef = useRef(false);
  const automaticFinalizationStartedRef = useRef(false);
  const mercadoPagoIdempotencyKeyRef = useRef<string | null>(null);

  const loadProducts = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
      let canEdit = false;
      let permissionMessage = '';
      if (claimsError || !claimsData?.claims?.sub) {
        permissionMessage = 'Não foi possível verificar suas permissões. Preços e descontos ficarão bloqueados.';
      } else {
        const { data: profile, error: profileError } = await supabase.from('profiles')
          .select('role')
          .eq('user_id', claimsData.claims.sub)
          .maybeSingle();
        if (profileError) {
          console.error('POS role query failed:', profileError.code);
          permissionMessage = 'Não foi possível verificar seu perfil. Preços e descontos ficarão bloqueados.';
        } else {
          canEdit = profile?.role === 'admin' || profile?.role === 'manager';
          if (!canEdit) permissionMessage = 'Preço e desconto por item exigem perfil de administrador ou gerente.';
        }
      }
      setCanEditPriceAndDiscount(canEdit);
      setPricingPermissionMessage(permissionMessage);

      const { data, error } = await supabase.from('products')
        .select('id, product_code, barcode, name, unit, unit_price_cents, stock_quantity, active, created_at, updated_at')
        .eq('active', true)
        .order('name');
      if (error) {
        console.error('POS product query failed:', error.code);
        setMessage('Não foi possível carregar o catálogo para a venda.');
        setMessageIsError(true);
        return false;
      }
      setProducts(data);
      const { data: paymentConfig, error: paymentConfigError } = await supabase.from('payment_settings')
        .select('*').eq('id', true).maybeSingle();
      if (paymentConfigError) {
        console.error('POS Pix settings query failed:', paymentConfigError.code);
        setPaymentSettings(null);
        setPaymentSettingsError('Aplique a migration 20261010195000_pix_payment_settings.sql para configurar pagamentos Pix.');
      } else if (!paymentConfig) {
        setPaymentSettings(null);
        setPaymentSettingsError('Cadastre a chave Pix em Configurações adicionais antes de receber por Pix.');
      } else {
        setPaymentSettings(paymentConfig);
        setPaymentSettingsError('');
      }
      return true;
    } catch {
      setMessage('Não foi possível carregar o catálogo para a venda. Verifique a conexão.');
      setMessageIsError(true);
      return false;
    }
  }, []);

  useEffect(() => {
    void loadProducts().finally(() => setIsLoading(false));
  }, [loadProducts]);

  const cartLines = useMemo(() => lines.map(line => {
    const quantityMilli = parseQuantityMilli(line.quantity);
    const unitPriceCents = parseMoneyCents(line.unitPrice);
    const discountBps = parseDiscountBps(line.discount);
    const calculation = quantityMilli !== null && unitPriceCents !== null && discountBps !== null
      ? calculateSaleLine({ quantityMilli, unitPriceCents, discountBps })
      : null;
    return { ...line, quantityMilli, unitPriceCents, discountBps, calculation };
  }), [lines]);
  const totalCents = cartLines.reduce((sum, line) => sum + (line.calculation?.totalCents ?? 0), 0);
  const receivedCents = paymentMethod === 'cash' ? parseMoneyCents(receivedInput) : totalCents;
  const changeCents = receivedCents === null ? null : calculateChange({
    totalCents,
    receivedCents,
    paymentMethod
  });
  const matchingProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('pt-BR');
    if (!query) return [];
    return products.filter(product => [product.id, product.name, product.product_code, product.barcode ?? '']
      .some(value => value.toLocaleLowerCase('pt-BR').includes(query))).slice(0, 8);
  }, [products, search]);

  useEffect(() => {
    if (!isCheckoutOpen || paymentMethod !== 'pix'
      || paymentSettings?.pix_payment_mode === 'mercadopago') {
      setPixQrDataUrl('');
      setPixPayload('');
      if (paymentMethod !== 'pix' || !isCheckoutOpen) setPixError('');
      return;
    }

    if (!paymentSettings) {
      setPixError(paymentSettingsError || 'Configure a chave Pix em Configurações adicionais.');
      return;
    }
    const payload = buildPixPayload(totalCents, `AAC${Date.now().toString(36).toUpperCase()}`, paymentSettings);
    if (!payload) {
      setPixError('Cadastre uma chave Pix válida em Configurações adicionais.');
      setPixQrDataUrl('');
      setPixPayload('');
      return;
    }

    setPixPayload(payload);
    setPixError('');
    void QRCode.toDataURL(payload, { width: 280, margin: 2, errorCorrectionLevel: 'M' })
      .then(setPixQrDataUrl)
      .catch(() => setPixError('Não foi possível gerar o QR Code Pix.'));
  }, [isCheckoutOpen, paymentMethod, paymentSettings, paymentSettingsError, totalCents]);

  useEffect(() => {
    const dialog = checkoutDialogRef.current;
    if (isCheckoutOpen && dialog && !dialog.open) dialog.showModal();
    if (!isCheckoutOpen && dialog?.open) dialog.close();
  }, [isCheckoutOpen]);

  function cancelCurrentSale() {
    if (!lines.length || isSaving) return;
    if (!window.confirm('Cancelar a venda atual e remover todos os itens do carrinho?')) return;
    setLines([]);
    setSelectedLineProductId(null);
    setReceivedInput('');
    setMessage('Venda cancelada. O estoque não foi alterado.');
    setMessageIsError(false);
  }

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (isCheckoutOpen) return;
      const key = event.key.toLocaleLowerCase();
      if (key === 'f' && target instanceof HTMLElement && target.id === 'posProductSearch') {
        event.preventDefault();
        openCheckout();
        return;
      }
      if (target instanceof HTMLElement && (
        target.isContentEditable || target.id === 'posProductSearch'
        || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)
      )) return;

      if (key === 'f' || key === 'r') {
        event.preventDefault();
        openCheckout();
        return;
      }
      if (key === 'k') {
        event.preventDefault();
        cancelCurrentSale();
        return;
      }

      const selectedLine = selectedLineProductId ?? lines[0]?.product.id;
      if (key === 'i') {
        event.preventDefault();
        if (selectedLine) {
          setLines(current => current.filter(line => line.product.id !== selectedLine));
          setSelectedLineProductId(null);
        }
        return;
      }
      const fieldId = key === 'p' ? 'price' : key === 'q' ? 'quantity' : key === 'd' ? 'discount' : null;
      if (fieldId && selectedLine) {
        event.preventDefault();
        const field = document.getElementById(`pos-line-${fieldId}-${selectedLine}`);
        if (field instanceof HTMLInputElement && !field.disabled) field.focus();
      }
    }
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  });

  function addProduct(product: Product) {
    if (product.stock_quantity <= 0) {
      setMessage('Este produto está sem estoque disponível.');
      setMessageIsError(true);
      return;
    }
    setMessage('');
    setMessageIsError(false);
    setSelectedLineProductId(product.id);
    setLines(current => {
      const existing = current.find(line => line.product.id === product.id);
      if (existing) {
        return current.map(line => line.product.id === product.id
          ? { ...line, quantity: formatQuantity((parseQuantityMilli(line.quantity) ?? 0) + 1000) }
          : line);
      }
      return [...current, {
        product,
        quantity: '1',
        unitPrice: formatMoneyInput(product.unit_price_cents),
        discount: '0'
      }];
    });
    setSearch('');
    searchRef.current?.focus();
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const exactMatch = products.find(product =>
      product.id.toLocaleLowerCase('pt-BR') === search.trim().toLocaleLowerCase('pt-BR')
      || product.barcode === search.trim()
      || product.product_code.toLocaleLowerCase('pt-BR') === search.trim().toLocaleLowerCase('pt-BR')
    );
    const product = exactMatch ?? (matchingProducts.length === 1 ? matchingProducts[0] : null);
    if (product) addProduct(product);
    else if (matchingProducts.length > 1) {
      setMessage('Mais de um produto corresponde à busca. Selecione um item da lista.');
      setMessageIsError(false);
    } else {
      setMessage('Nenhum produto encontrado para este código ou descrição.');
      setMessageIsError(true);
    }
  }

  function updateLine(productId: string, field: 'quantity' | 'unitPrice' | 'discount', value: string) {
    setLines(current => current.map(line => line.product.id === productId ? { ...line, [field]: value } : line));
  }

  function handlePaymentMethodChange(method: PaymentMethod) {
    automaticFinalizationStartedRef.current = false;
    mercadoPagoIdempotencyKeyRef.current = null;
    setPixError('');
    setPixQrDataUrl('');
    setPixPayload('');
    setMercadoPagoQr('');
    setMercadoPagoCopyCode('');
    setMercadoPagoTicket('');
    setMercadoPagoStatus('idle');
    setIsPixFinalizationVerified(false);
    setPaymentMethod(method);
    setCheckoutStep(method === 'cash' ? 'review' : 'awaiting-payment');
    setReceivedInput('');
  }

  async function generateMercadoPagoPix() {
    if (mercadoPagoStatus === 'creating' || mercadoPagoTicket) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail.trim())) {
      setPixError('Informe um e-mail válido do pagador para gerar o Pix pelo Mercado Pago.');
      return;
    }
    setPixError('');
    setMercadoPagoStatus('creating');
    try {
      const response = await fetch('/api/payments/mercadopago', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': mercadoPagoIdempotencyKeyRef.current ?? (mercadoPagoIdempotencyKeyRef.current = crypto.randomUUID())
        },
        body: JSON.stringify({ amountCents: totalCents, payerEmail: payerEmail.trim() }),
        cache: 'no-store'
      });
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object') throw new Error('Resposta inválida do servidor.');
      const data = result as Record<string, unknown>;
      if (!response.ok) {
        setPixError(typeof data.error === 'string' ? data.error : 'Não foi possível gerar o QR Pix via Mercado Pago.');
        setMercadoPagoStatus('idle');
        return;
      }
      if (typeof data.qrCode !== 'string' || typeof data.qrCodeBase64 !== 'string' || typeof data.ticket !== 'string') {
        throw new Error('O servidor não retornou os dados do QR Pix.');
      }
      setMercadoPagoQr(`data:image/png;base64,${data.qrCodeBase64}`);
      setMercadoPagoCopyCode(data.qrCode);
      setMercadoPagoTicket(data.ticket);
      setMercadoPagoStatus('pending');
    } catch {
      setPixError('Não foi possível gerar o QR Pix. Verifique a conexão e tente novamente.');
      setMercadoPagoStatus('idle');
    }
  }

  async function copyPixCode(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setPixError('Código Pix copiado.');
    } catch {
      setPixError('Não foi possível copiar o código Pix. Use a leitura do QR Code.');
    }
  }

  function handleCartSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    openCheckout();
  }

  function openCheckout() {
    if (isSaving) return;
    setMessage('');
    setMessageIsError(false);
    if (!cartLines.length || cartLines.some(line =>
      !line.calculation || line.quantityMilli === null || line.unitPriceCents === null || line.discountBps === null
    )) {
      setMessage('Revise as quantidades, preços e descontos dos itens.');
      setMessageIsError(true);
      return;
    }
    if (cartLines.some(line => (line.quantityMilli ?? 0) > Math.round(line.product.stock_quantity * 1000))) {
      setMessage('A quantidade solicitada ultrapassa o estoque de pelo menos um produto.');
      setMessageIsError(true);
      return;
    }
    setPaymentMethod('cash');
    setInstallments(1);
    setReceivedInput('');
    setPixError('');
    setMercadoPagoQr('');
    setMercadoPagoCopyCode('');
    setMercadoPagoTicket('');
    setMercadoPagoStatus('idle');
    setIsPixFinalizationVerified(false);
    automaticFinalizationStartedRef.current = false;
    mercadoPagoIdempotencyKeyRef.current = null;
    setCheckoutStep('review');
    setIsCheckoutOpen(true);
  }

  function closeCheckout() {
    if (isSaving) return;
    if (paymentMethod === 'pix' && paymentSettings?.pix_payment_mode === 'mercadopago'
      && mercadoPagoStatus === 'pending' && mercadoPagoTicket) {
      setPixError('O QR Pix ainda está ativo. Aguarde a confirmação ou o vencimento antes de fechar.');
      return;
    }
    if (paymentMethod === 'pix' && mercadoPagoStatus === 'approved'
      && !window.confirm('O pagamento foi aprovado, mas a venda ainda não foi registrada. Fechar pode exigir conferência manual no histórico do Mercado Pago. Deseja continuar?')) return;
    setIsCheckoutOpen(false);
    setCheckoutStep('review');
  }

  async function finalizeSale(paymentWasConfirmedByApi = false) {
    if (!isCheckoutOpen || isSaving || finalizationInProgressRef.current) return;
    if (paymentMethod === 'pix' && paymentSettings?.pix_payment_mode === 'mercadopago'
      && !(paymentWasConfirmedByApi || isPixFinalizationVerified)) {
      setPixError('A venda será finalizada automaticamente após a confirmação do Mercado Pago.');
      return;
    }
    const amountReceivedCents = paymentMethod === 'cash' ? receivedCents : totalCents;
    if (amountReceivedCents === null || (paymentMethod === 'cash' && changeCents === null)) {
      setMessage('Informe um valor recebido igual ou superior ao total.');
      setMessageIsError(true);
      return;
    }
    if (paymentMethod === 'pix' && paymentSettings?.pix_payment_mode !== 'mercadopago' && !pixQrDataUrl) {
      setPixError('Configure uma chave Pix válida antes de confirmar o recebimento manual.');
      return;
    }

    finalizationInProgressRef.current = true;
    setIsSaving(true);
    try {
      const { data, error } = await createClient().rpc('record_sale', {
        p_lines: cartLines.map(line => ({
          product_id: line.product.id,
          quantity: (line.quantityMilli ?? 0) / 1000,
          unit_price_cents: line.unitPriceCents,
          discount_bps: line.discountBps
        })),
        p_payment_method: paymentMethod,
        p_amount_received_cents: amountReceivedCents,
        p_installments: paymentMethod === 'credit' ? installments : 1
      });
      if (error) {
        console.error('Sale finalization failed:', error.code);
        setMessage(paymentWasConfirmedByApi
          ? `O Mercado Pago confirmou o pagamento, mas a venda não foi gravada. ${getErrorMessage(error.code)} Não cobre o cliente novamente; confira o pagamento e faça a conciliação antes de encerrar.`
          : getErrorMessage(error.code));
        setMessageIsError(true);
        return;
      }
      const saleId = data && typeof data === 'object' && !Array.isArray(data) ? data.sale_id : null;
      const finalTotalCents = data && typeof data === 'object' && !Array.isArray(data) ? data.total_cents : null;
      const finalChangeCents = data && typeof data === 'object' && !Array.isArray(data) ? data.change_cents : null;
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || typeof saleId !== 'string'
        || typeof finalTotalCents !== 'number'
        || typeof finalChangeCents !== 'number') {
        setMessage('A venda foi processada, mas não foi possível confirmar o comprovante retornado. Atualize o catálogo antes de uma nova operação.');
        setMessageIsError(true);
        setLines([]);
        setReceivedInput('');
        setMercadoPagoTicket('');
        setMercadoPagoStatus('idle');
        setIsPixFinalizationVerified(false);
        await loadProducts();
        return;
      }
      setLines([]);
      setReceivedInput('');
      setIsCheckoutOpen(false);
      setCheckoutStep('review');
      setInstallments(1);
      const catalogReloaded = await loadProducts();
      setMessage(catalogReloaded
        ? `Venda concluída · ${saleId.slice(0, 8)} · total ${formatMoney(finalTotalCents)} · troco ${formatMoney(finalChangeCents)}.`
        : `Venda ${saleId.slice(0, 8)} concluída por ${formatMoney(finalTotalCents)}; não foi possível atualizar o catálogo. Recarregue antes da próxima venda.`);
      setMessageIsError(!catalogReloaded);
    } catch {
      setMessage(paymentWasConfirmedByApi
        ? 'O pagamento Pix foi confirmado, mas houve falha de comunicação ao gravar a venda. Confira as vendas e o estoque antes de tentar novamente; não cobre o cliente novamente.'
        : 'Não foi possível concluir a venda. Confira sua conexão e tente novamente.');
      setMessageIsError(true);
    } finally {
      finalizationInProgressRef.current = false;
      setIsSaving(false);
    }
  }

  useEffect(() => {
    if (!isCheckoutOpen || paymentMethod !== 'pix' || !mercadoPagoTicket
      || mercadoPagoStatus !== 'pending') return;
    let cancelled = false;
    let checking = false;
    async function checkPaymentStatus() {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch(`/api/payments/mercadopago?ticket=${encodeURIComponent(mercadoPagoTicket)}`, {
          cache: 'no-store'
        });
        const result: unknown = await response.json();
        if (!response.ok || !result || typeof result !== 'object') {
          const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
            ? result.error
            : 'Não foi possível consultar o pagamento; nova tentativa em instantes.';
          throw new Error(message);
        }
        const status = (result as { status?: unknown }).status;
        if (cancelled) return;
        if (status === 'approved') {
          setMercadoPagoStatus('approved');
          setIsPixFinalizationVerified(true);
          setPixError('');
        } else if (status === 'rejected' || status === 'expired') {
          setMercadoPagoStatus(status);
          setPixError(status === 'expired'
            ? 'O QR Pix expirou. Volte e gere um novo pagamento.'
            : 'O pagamento não foi aprovado. Gere um novo QR Pix ou escolha outra forma de pagamento.');
        } else if (status === 'pending') {
          setPixError('');
        } else {
          throw new Error('Resposta inválida ao consultar o pagamento.');
        }
      } catch (error) {
        if (!cancelled) setPixError(error instanceof Error
          ? error.message
          : 'Não foi possível consultar o pagamento; nova tentativa em instantes.');
      } finally {
        checking = false;
      }
    }
    void checkPaymentStatus();
    const interval = window.setInterval(() => void checkPaymentStatus(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [isCheckoutOpen, mercadoPagoStatus, mercadoPagoTicket, paymentMethod]);

  useEffect(() => {
    if (mercadoPagoStatus === 'approved' && isPixFinalizationVerified && isCheckoutOpen
      && !isSaving && !automaticFinalizationStartedRef.current) {
      automaticFinalizationStartedRef.current = true;
      void finalizeSale(true);
    }
  }, [mercadoPagoStatus, isPixFinalizationVerified, isCheckoutOpen, isSaving]);

  if (isLoading) return <p className="catalog-state" role="status">Carregando produtos para venda…</p>;

  return (
    <section className="pos-layout" aria-label="Ponto de venda">
      <form id="posSaleForm" className="pos-register catalog-form" onSubmit={handleCartSubmit}>
        <div className="pos-toolbar">
          <label className="catalog-search">
            Ler código de barras ou buscar produto
            <input
              id="posProductSearch"
              ref={searchRef}
              autoFocus
              value={search}
              onChange={event => setSearch(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Bipe ou digite o código, ID ou nome"
              autoComplete="off"
            />
          </label>
          <span className="pos-stock-hint">Bipe e pressione Enter · Q quantidade · P preço · D desconto · I remover item · K cancelar venda · F finalizar.</span>
          <button className="button button-secondary" type="button" onClick={cancelCurrentSale} disabled={!lines.length || isSaving}>
            Cancelar venda <kbd>K</kbd>
          </button>
        </div>
        {pricingPermissionMessage && <p className="pos-stock-hint" role="note">{pricingPermissionMessage}</p>}

        {matchingProducts.length > 0 && (
          <ul className="pos-product-matches" aria-label="Resultados da busca">
            {matchingProducts.map(product => (
              <li key={product.id}>
                <span><strong>{product.name}</strong><small>{product.product_code} · {product.stock_quantity} {product.unit} em estoque</small></span>
                <span>{formatMoney(product.unit_price_cents)}</span>
                <button className="button button-secondary" type="button" onClick={() => addProduct(product)}>Adicionar</button>
              </li>
            ))}
          </ul>
        )}

        <div className="pos-lines">
          {cartLines.length ? cartLines.map(line => (
            <article className="pos-line" key={line.product.id}>
              <div className="pos-line-title">
                <div><strong>{line.product.name}</strong><small>{line.product.product_code} · {line.product.stock_quantity} {line.product.unit} disponíveis</small></div>
                <button className="pos-remove" type="button" aria-label={`Remover ${line.product.name}`} onClick={() => {
                  setLines(current => current.filter(item => item.product.id !== line.product.id));
                  setSelectedLineProductId(current => current === line.product.id ? null : current);
                }}>Remover</button>
              </div>
              <label>Quantidade ({line.product.unit})
                <input id={`pos-line-quantity-${line.product.id}`} value={line.quantity} onFocus={() => setSelectedLineProductId(line.product.id)} onChange={event => updateLine(line.product.id, 'quantity', event.target.value)} inputMode="decimal" aria-label={`Quantidade de ${line.product.name}`} />
              </label>
              <label>Preço unitário (R$)
                <input id={`pos-line-price-${line.product.id}`} value={line.unitPrice} onFocus={() => setSelectedLineProductId(line.product.id)} onChange={event => updateLine(line.product.id, 'unitPrice', event.target.value)} inputMode="decimal" aria-label={`Preço unitário de ${line.product.name}`} disabled={!canEditPriceAndDiscount} />
              </label>
              <label>Desconto (%)
                <input id={`pos-line-discount-${line.product.id}`} value={line.discount} onFocus={() => setSelectedLineProductId(line.product.id)} onChange={event => updateLine(line.product.id, 'discount', event.target.value)} inputMode="decimal" aria-label={`Desconto percentual de ${line.product.name}`} disabled={!canEditPriceAndDiscount} />
              </label>
              <strong className="pos-line-total">{line.calculation ? formatMoney(line.calculation.totalCents) : 'Confira os valores'}</strong>
            </article>
          )) : (
            <div className="catalog-empty pos-empty"><h2>Nenhum item na venda</h2><p>Bipe um código de barras ou busque um produto para começar.</p></div>
          )}
        </div>
      </form>

      <aside className="pos-payment catalog-form">
        <div className="pos-total"><span>Total</span><strong>{formatMoney(totalCents)}</strong></div>
        <button
          className="button button-primary pos-finish"
          type="button"
          onClick={openCheckout}
          disabled={isSaving || !cartLines.length || totalCents <= 0 || cartLines.some(line => line.calculation === null)}
        >
          Finalizar venda <kbd>F</kbd>
        </button>
      </aside>
      {message && <p className={`pos-message${messageIsError ? ' pos-message-error' : ''}`} role={messageIsError ? 'alert' : 'status'}>{message}</p>}
      {isCheckoutOpen && (
          <dialog
            ref={checkoutDialogRef}
            className="checkout-dialog"
            aria-labelledby="checkoutTitle"
            onCancel={event => { event.preventDefault(); closeCheckout(); }}
          >
            <button className="checkout-close" type="button" onClick={closeCheckout} aria-label="Fechar finalização" disabled={isSaving || mercadoPagoStatus === 'pending'}>×</button>
            {messageIsError && message && <p className="form-message" role="alert">{message}</p>}
            {checkoutStep === 'review' ? (
              <>
                <p className="eyebrow">FINALIZAR VENDA</p>
                <h2 id="checkoutTitle">Recebimento em dinheiro</h2>
                <p className="checkout-total">{formatMoney(totalCents)}</p>
                <label className="checkout-field">Quanto o cliente entregou? (R$)
                  <input
                    autoFocus
                    value={receivedInput}
                    onChange={event => setReceivedInput(event.target.value)}
                    inputMode="decimal"
                    placeholder="Ex.: 100,00"
                  />
                </label>
                <div className="checkout-change">
                  <span>Troco</span>
                  <strong>{changeCents === null ? 'Informe o valor recebido' : formatMoney(changeCents)}</strong>
                </div>
                <label className="checkout-payment-select">Outra forma de pagamento
                  <select value={paymentMethod} onChange={event => handlePaymentMethodChange(event.target.value as PaymentMethod)}>
                    <option value="cash">Dinheiro</option>
                    <option value="pix">Pix</option>
                    <option value="debit">Cartão de débito</option>
                    <option value="credit">Cartão de crédito</option>
                  </select>
                </label>
                <button className="button button-primary checkout-action" type="button" onClick={() => void finalizeSale()} disabled={isSaving || changeCents === null}>
                  {isSaving ? 'Registrando venda…' : 'Confirmar recebimento e finalizar'}
                </button>
              </>
            ) : (
              <>
                <p className="eyebrow">PAGAMENTO</p>
                <h2 id="checkoutTitle">{paymentMethod === 'pix' ? 'Pague com Pix' : 'Aguardando pagamento'}</h2>
                {paymentMethod === 'pix' ? (
                  <div className="checkout-pix">
                    {paymentSettings?.pix_payment_mode === 'mercadopago' ? (
                      <>
                        {!mercadoPagoQr && (
                          <>
                            {!paymentSettings.pix_key && <p className="form-message" role="alert">{paymentSettingsError || 'Cadastre a chave Pix em Configurações adicionais.'}</p>}
                            <label className="checkout-field">E-mail do pagador
                              <input value={payerEmail} onChange={event => setPayerEmail(event.target.value)} type="email" autoComplete="email" maxLength={254} placeholder="cliente@exemplo.com" required />
                            </label>
                            <button className="button button-primary checkout-action" type="button" onClick={() => void generateMercadoPagoPix()} disabled={mercadoPagoStatus === 'creating' || !paymentSettings.pix_key}>
                              {mercadoPagoStatus === 'creating' ? 'Gerando QR Pix…' : 'Gerar QR Pix Mercado Pago'}
                            </button>
                          </>
                        )}
                        {mercadoPagoQr && <img className="pix-qr" src={mercadoPagoQr} alt="QR Code Pix criado pelo Mercado Pago" />}
                        <strong className="pix-amount">{formatMoney(totalCents)}</strong>
                        {mercadoPagoCopyCode && <button className="button button-secondary pix-copy" type="button" onClick={() => void copyPixCode(mercadoPagoCopyCode)}>Copiar código Pix</button>}
                        {mercadoPagoStatus === 'pending' && <p role="status">Aguardando confirmação automática do Mercado Pago…</p>}
                        {mercadoPagoStatus === 'approved' && <p role="status">Pagamento confirmado. Registrando a venda e atualizando o estoque…</p>}
                        {mercadoPagoStatus === 'rejected' && <p role="alert">Pagamento não aprovado. Gere outro QR ou escolha outra forma de pagamento.</p>}
                        {mercadoPagoStatus === 'expired' && <p role="alert">O QR Pix expirou. Gere um novo pagamento.</p>}
                        {(mercadoPagoStatus === 'rejected' || mercadoPagoStatus === 'expired') && (
                          <button className="button button-secondary" type="button" onClick={() => {
                            setMercadoPagoQr('');
                            setMercadoPagoCopyCode('');
                            setMercadoPagoTicket('');
                            setMercadoPagoStatus('idle');
                            setPixError('');
                            mercadoPagoIdempotencyKeyRef.current = null;
                          }}>Gerar outro QR Pix</button>
                        )}
                        {mercadoPagoStatus === 'approved' && !isSaving && (
                          <button className="button button-secondary" type="button" onClick={() => void finalizeSale(true)}>Tentar registrar venda novamente</button>
                        )}
                        <p>A confirmação é consultada no Mercado Pago; a venda só é registrada após a aprovação do pagamento.</p>
                      </>
                    ) : (
                      <>
                        {pixQrDataUrl ? <img className="pix-qr" src={pixQrDataUrl} alt="QR Code Pix para pagamento da venda" /> : <p className="form-message">{pixError || paymentSettingsError || 'Gerando QR Code Pix…'}</p>}
                        <strong className="pix-amount">{formatMoney(totalCents)}</strong>
                        {pixPayload && <button className="button button-secondary pix-copy" type="button" onClick={() => void copyPixCode(pixPayload)}>Copiar código Pix</button>}
                        <p>QR gerado sem conexão com API. Confira o pagamento no aplicativo do banco e confirme manualmente no PDV.</p>
                      </>
                    )}
                    {pixError && <p className="form-message" role="status">{pixError}</p>}
                  </div>
                ) : (
                  <div className="checkout-waiting">
                    <span className="payment-spinner" aria-hidden="true" />
                    <p>Aguardando confirmação na maquininha.</p>
                    {paymentMethod === 'credit' && (
                      <>
                        <label className="checkout-field">Parcelamento
                          <select value={installments} onChange={event => setInstallments(Number(event.target.value))}>
                            {Array.from({ length: 12 }, (_, index) => index + 1).map(count => (
                              <option key={count} value={count}>{count === 1 ? 'À vista (1x)' : `${count}x`}</option>
                            ))}
                          </select>
                        </label>
                        {installments > 1 && <strong>{installments}x de {formatMoney(Math.ceil(totalCents / installments))} (estimativa, sem taxas da operadora)</strong>}
                      </>
                    )}
                  </div>
                )}
                <label className="checkout-payment-select">Alterar forma de pagamento
                  <select
                    value={paymentMethod}
                    onChange={event => handlePaymentMethodChange(event.target.value as PaymentMethod)}
                    disabled={isSaving || mercadoPagoStatus === 'pending' || mercadoPagoStatus === 'approved'}
                  >
                    <option value="cash">Dinheiro</option>
                    <option value="pix">Pix</option>
                    <option value="debit">Cartão de débito</option>
                    <option value="credit">Cartão de crédito</option>
                  </select>
                </label>
                {(paymentMethod !== 'pix' || paymentSettings?.pix_payment_mode !== 'mercadopago') && (
                  <button className="button button-primary checkout-action" type="button" onClick={() => void finalizeSale()} disabled={isSaving || (paymentMethod === 'pix' && !pixQrDataUrl)}>
                    {isSaving ? 'Registrando venda…' : paymentMethod === 'pix' ? 'Confirmar pagamento Pix e finalizar' : 'Finalizar payout'}
                  </button>
                )}
                <button className="button button-secondary checkout-back" type="button" onClick={() => { setPaymentMethod('cash'); setCheckoutStep('review'); }} disabled={isSaving || mercadoPagoStatus === 'pending' || mercadoPagoStatus === 'approved'}>Voltar ao recebimento</button>
              </>
            )}
          </dialog>
      )}
    </section>
  );
}
