'use client';

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { Product } from '@/lib/supabase/database.types';
import { createClient } from '@/lib/supabase/client';
import {
  calculateDesiredPrice,
  calculateDesiredProfitRateBps,
  calculateMarkupPrice,
  calculateMinimumPriceCents
} from '@/lib/pricing-calculation.mjs';

const supabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
);

const productColumns = 'id, product_code, name, unit, unit_price_cents, active';
type PricingProduct = Pick<
  Product,
  'id' | 'product_code' | 'name' | 'unit' | 'unit_price_cents' | 'active'
>;
type VariableFee = import('@/lib/supabase/database.types').Database['public']['Tables']['pricing_variable_fees']['Row'];
type FixedExpense = import('@/lib/supabase/database.types').Database['public']['Tables']['pricing_fixed_expenses']['Row'];

function parseMoneyCents(value: string) {
  const normalized = value.trim();
  if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(normalized)) return null;

  const [reais, cents = ''] = normalized.replace(/\./g, '').split(',');
  const amount = Number(reais) * 100 + Number(cents.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount <= 2147483647 ? amount : null;
}

function parseRateBasisPoints(value: string) {
  const normalized = value.trim();
  if (!/^\d{1,3}(?:,\d{1,2})?$/.test(normalized)) return null;

  const rate = Number(normalized.replace(',', '.'));
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) return null;
  return Math.round(rate * 100);
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatRate(basisPoints: number) {
  return (basisPoints / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) + '%';
}

function formatCostInput(cents: number | null) {
  if (cents === null) return '';
  return (cents / 100).toFixed(2).replace('.', ',');
}

function normalizeProductSearch(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
}

function getErrorMessage(code?: string, resource?: string) {
  if (code === 'PGRST202') {
    return 'A migration da calculadora ainda não foi aplicada no Supabase.';
  }
  if (code === 'PGRST205' || code === '42P01') {
    if (resource === 'product_costs') {
      return 'A tabela de custos de produtos não está disponível. Aplique 20261007170000_product_markup_pricing.sql e 20261008120000_pricing_settings.sql no Supabase e atualize a página.';
    }
    if (
      resource === 'pricing_settings'
      || resource === 'pricing_variable_fees'
      || resource === 'pricing_fixed_expenses'
    ) {
      return 'As configurações da calculadora não estão disponíveis. Aplique 20261008120000_pricing_settings.sql no SQL Editor do Supabase e atualize o esquema da API.';
    }
    return 'A estrutura de preços ainda não está disponível no Supabase.';
  }
  if (code === 'PGRST204' && resource === 'pricing_fixed_expenses') {
    return 'Aplique a migration 20261010173000_fixed_expenses_as_percentages.sql no Supabase para calcular despesas fixas em percentual.';
  }
  if (code === '42501') {
    return 'Seu perfil não tem permissão para salvar preços. Solicite acesso de administrador ou gerente.';
  }
  if (code === 'P0001') {
    return 'O preço não é válido ou ficou abaixo do mínimo sem lucro. Confira as despesas e tente novamente.';
  }
  return 'Não foi possível concluir a operação. Verifique a conexão e tente novamente.';
}

export default function PriceCalculator() {
  const [products, setProducts] = useState<PricingProduct[]>([]);
  const [productCosts, setProductCosts] = useState<Record<string, number>>({});
  const [variableFees, setVariableFees] = useState<VariableFee[]>([]);
  const [fixedExpenses, setFixedExpenses] = useState<FixedExpense[]>([]);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [isProductSearchOpen, setIsProductSearchOpen] = useState(false);
  const [activeProductSuggestion, setActiveProductSuggestion] = useState(0);
  const [costInput, setCostInput] = useState('');
  const [calculationMode, setCalculationMode] = useState<'profit' | 'price'>('profit');
  const [desiredPriceInput, setDesiredPriceInput] = useState('');
  const [targetProfitInput, setTargetProfitInput] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasPricingAccess, setHasPricingAccess] = useState<boolean | null>(null);
  const [profileRole, setProfileRole] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);

  const loadProducts = useCallback(async () => {
    const supabase = createClient();
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
    if (claimsError || !claimsData?.claims?.sub) {
      setMessage('Entre novamente para acessar a calculadora.');
      setMessageIsError(true);
      return false;
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('user_id', claimsData.claims.sub)
      .maybeSingle();

    if (profileError) {
      console.error('Pricing access check failed:', profileError.code);
      setMessage(getErrorMessage(profileError.code));
      setMessageIsError(true);
      return false;
    }

    if (!profile || (profile.role !== 'admin' && profile.role !== 'manager')) {
      setHasPricingAccess(false);
      setProfileRole(profile?.role ?? null);
      setMessage('');
      return true;
    }

    setHasPricingAccess(true);
    setProfileRole(profile.role);
    const [productsResult, costsResult, feesResult, expensesResult] = await Promise.all([
      supabase
        .from('products')
        .select(productColumns)
        .eq('active', true)
        .order('name'),
      supabase
        .from('product_costs')
        .select('product_id, unit_cost_cents'),
      supabase.from('pricing_variable_fees').select('*').order('name'),
      supabase.from('pricing_fixed_expenses')
        .select('id,name,rate_bps,monthly_amount_cents,active,created_at,updated_at')
        .order('name')
    ]);

    const queryErrors = [
      ['products', productsResult.error],
      ['product_costs', costsResult.error],
      ['pricing_variable_fees', feesResult.error],
      ['pricing_fixed_expenses', expensesResult.error]
    ] as const;
    const failedQuery = queryErrors.find(([, error]) => error !== null);
    if (failedQuery) {
      const [resource, queryError] = failedQuery;
      if (!queryError) return false;
      console.error('Pricing catalog query failed:', { resource, code: queryError.code });
      setMessage(getErrorMessage(queryError.code, resource));
      setMessageIsError(true);
      return false;
    }

    if (!productsResult.data || !costsResult.data || !feesResult.data || !expensesResult.data) {
      setMessage('Não foi possível carregar produtos, custos e configurações de preço.');
      setMessageIsError(true);
      return false;
    }

    setProducts(productsResult.data);
    setVariableFees(feesResult.data.filter(fee => fee.active));
    setFixedExpenses(expensesResult.data.filter(expense => expense.active));
    const costs: Record<string, number> = {};
    for (const productCost of costsResult.data) {
      costs[productCost.product_id] = productCost.unit_cost_cents;
    }
    setProductCosts(costs);
    setMessage('');
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!supabaseConfigured) {
        setMessage('Configure o Supabase antes de usar a calculadora com dados reais.');
        setMessageIsError(true);
        setIsLoading(false);
        return;
      }

      try {
        await loadProducts();
      } catch {
        if (!cancelled) {
          setMessage('Não foi possível carregar o catálogo. Verifique sua conexão e tente novamente.');
          setMessageIsError(true);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [loadProducts]);

  const selectedProduct = products.find(product => product.id === selectedProductId) ?? null;
  const productSuggestions = useMemo(() => {
    const query = normalizeProductSearch(productSearch);
    if (!query) return [];

    return products
      .map(product => {
        const name = normalizeProductSearch(product.name);
        const code = normalizeProductSearch(product.product_code ?? '');
        const nameIndex = name.indexOf(query);
        const codeIndex = code.indexOf(query);
        const rank = name === query ? 0
          : name.startsWith(query) ? 1
            : name.split(/\s+/).some(word => word.startsWith(query)) ? 2
              : nameIndex >= 0 ? 3
                : codeIndex >= 0 ? 4
                  : Number.POSITIVE_INFINITY;
        return { product, rank, matchIndex: nameIndex >= 0 ? nameIndex : codeIndex };
      })
      .filter(match => Number.isFinite(match.rank))
      .sort((a, b) => a.rank - b.rank || a.matchIndex - b.matchIndex || a.product.name.localeCompare(b.product.name, 'pt-BR'))
      .slice(0, 8)
      .map(match => match.product);
  }, [productSearch, products]);
  const costCents = parseMoneyCents(costInput);
  const targetProfitBps = parseRateBasisPoints(targetProfitInput);
  const desiredPriceCents = parseMoneyCents(desiredPriceInput);
  const configuredVariableRateBps = variableFees.reduce((sum, fee) => sum + fee.rate_bps, 0);
  const fixedCostRateBps = fixedExpenses.reduce((sum, expense) => sum + expense.rate_bps, 0);
  const totalExpenseRateBps = configuredVariableRateBps + fixedCostRateBps;
  const minimumPriceCents = costCents !== null && costCents > 0
    ? calculateMinimumPriceCents(costCents, totalExpenseRateBps)
    : null;
  const derivedDesiredProfitBps = costCents !== null && desiredPriceCents !== null
    ? calculateDesiredProfitRateBps(
      costCents,
      configuredVariableRateBps,
      fixedCostRateBps,
      desiredPriceCents
    )
    : null;

  const calculation = useMemo(() => {
    if (
      costCents === null || costCents <= 0
    ) {
      return null;
    }

    if (calculationMode === 'profit') {
      if (targetProfitBps === null) return null;
      return calculateMarkupPrice(costCents, configuredVariableRateBps, fixedCostRateBps, targetProfitBps);
    }
    if (desiredPriceCents === null) return null;
    return calculateDesiredPrice(costCents, configuredVariableRateBps, fixedCostRateBps, desiredPriceCents);
  }, [
    costCents,
    calculationMode,
    targetProfitBps,
    desiredPriceCents,
    configuredVariableRateBps,
    fixedCostRateBps
  ]);

  function handleProductChange(productId: string) {
    setSelectedProductId(productId);
    const product = products.find(item => item.id === productId);
    setProductSearch(product?.name ?? '');
    setIsProductSearchOpen(false);
    setActiveProductSuggestion(0);
    setCostInput(formatCostInput(product ? productCosts[product.id] ?? null : null));
    setMessage('');
  }

  function handleProductSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setIsProductSearchOpen(false);
      return;
    }
    if (!productSuggestions.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIsProductSearchOpen(true);
      setActiveProductSuggestion(index => (index + 1) % productSuggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIsProductSearchOpen(true);
      setActiveProductSuggestion(index => (index - 1 + productSuggestions.length) % productSuggestions.length);
    } else if (event.key === 'Enter' && isProductSearchOpen) {
      event.preventDefault();
      handleProductChange(productSuggestions[activeProductSuggestion]?.id ?? productSuggestions[0].id);
    }
  }

  async function handleRetryAccessCheck() {
    setIsLoading(true);
    setHasPricingAccess(null);
    setMessage('');
    setMessageIsError(false);

    try {
      await loadProducts();
    } catch {
      setMessage('Não foi possível consultar seu perfil. Verifique sua conexão e tente novamente.');
      setMessageIsError(true);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSavePrice() {
    const profitBps = calculation?.targetProfitBps ?? targetProfitBps;
    if (
      !selectedProduct
      || costCents === null
      || costCents <= 0
      || profitBps === null
      || (calculationMode === 'price' && desiredPriceCents === null)
      || totalExpenseRateBps + profitBps >= 10000
      || !calculation
    ) {
      setMessage('Confira o custo, as taxas configuradas e o preço/lucro desejado antes de salvar.');
      setMessageIsError(true);
      return;
    }

    setIsSaving(true);
    setMessage('');
    setMessageIsError(false);

    try {
      const supabase = createClient();
      const result = calculationMode === 'price'
        ? desiredPriceCents === null
          ? null
          : await supabase.rpc('save_product_pricing_at_desired_price', {
            p_product_id: selectedProduct.id,
            p_unit_cost_cents: costCents,
            p_desired_price_cents: desiredPriceCents
          })
        : await supabase.rpc('save_product_pricing', {
            p_product_id: selectedProduct.id,
            p_unit_cost_cents: costCents,
            p_variable_expense_bps: 0,
            p_tax_bps: 0,
            p_target_profit_bps: profitBps
          });
      if (!result) {
        setMessage('Informe um preço desejado válido antes de salvar.');
        setMessageIsError(true);
        return;
      }
      const { data, error } = result;

      if (error) {
        console.error('Product price save failed:', error.code);
        setMessage(getErrorMessage(error.code));
        setMessageIsError(true);
        return;
      }

      const refreshed = await loadProducts();
      if (refreshed) {
        setMessage(`Custo e preço de ${selectedProduct.name} salvos. Preço: ${formatMoney(data)}.`);
        setMessageIsError(false);
      }
    } catch {
      setMessage('Não foi possível salvar o preço. Verifique sua conexão e tente novamente.');
      setMessageIsError(true);
    } finally {
      setIsSaving(false);
    }
  }

  if (!supabaseConfigured) {
    return (
      <section className="setup-notice" aria-labelledby="pricingSetupTitle">
        <h2 id="pricingSetupTitle">Conecte o Supabase para calcular preços de produtos</h2>
        <p>A calculadora usa os produtos cadastrados e salva custo e preço no banco. O modo local de pré-visualização não persiste dados.</p>
      </section>
    );
  }

  if (!isLoading && hasPricingAccess === false) {
    return (
      <section className="setup-notice pricing-access-notice" aria-labelledby="pricingAccessTitle">
        <span className="access-status-icon" aria-hidden="true">!</span>
        <div>
          <p className="eyebrow">PERMISSÃO DA CONTA</p>
          <h2 id="pricingAccessTitle">
            {profileRole ? 'Seu perfil ainda não tem acesso' : 'Perfil comercial não encontrado'}
          </h2>
          <p>
            {profileRole
              ? `O Supabase reconheceu seu perfil como “${profileRole}”. A calculadora só está liberada para administradores e gerentes.`
              : 'A sessão está autenticada, mas não encontramos seu perfil em public.profiles. Confira se as migrations do catálogo foram executadas e se o usuário foi criado depois delas.'}
          </p>
          <p>Depois de ajustar a função do perfil no SQL Editor do Supabase, atualize esta página para verificar novamente.</p>
          <button
            className="button button-secondary"
            type="button"
            onClick={handleRetryAccessCheck}
            disabled={isLoading}
          >
            {isLoading ? 'Verificando…' : 'Verificar permissões novamente'}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="pricing-layout" aria-label="Calculadora markup divisor">
      <div className="pricing-form">
        <div className="pricing-section-heading">
          <h2>Dados de cálculo</h2>
          <p>As despesas e taxas cadastradas em Configurações são somadas e aplicadas como porcentagens do preço de venda.</p>
        </div>

        {isLoading ? (
          <p className="catalog-state" role="status">Carregando produtos…</p>
        ) : products.length === 0 ? (
          <div className="catalog-empty">
            <h2>Nenhum produto disponível</h2>
            <p>Cadastre um produto ativo em Produtos e estoque antes de formar o preço.</p>
          </div>
        ) : (
          <>
            <div className="pricing-product-search">
              <label className="pricing-field" htmlFor="pricing-product-search">Produto
                <input
                  id="pricing-product-search"
                  type="search"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={isProductSearchOpen && productSuggestions.length > 0}
                  aria-controls={isProductSearchOpen && normalizeProductSearch(productSearch)
                    ? 'pricing-product-suggestions'
                    : undefined}
                  aria-activedescendant={isProductSearchOpen && productSuggestions.length
                    ? `pricing-product-option-${productSuggestions[activeProductSuggestion]?.id ?? productSuggestions[0].id}`
                    : undefined}
                  value={productSearch}
                  onChange={event => {
                    const nextValue = event.target.value;
                    setProductSearch(nextValue);
                    setIsProductSearchOpen(true);
                    setActiveProductSuggestion(0);
                    if (selectedProduct && nextValue !== selectedProduct.name) {
                      setSelectedProductId('');
                      setCostInput('');
                    }
                  }}
                  onFocus={() => setIsProductSearchOpen(true)}
                  onKeyDown={handleProductSearchKeyDown}
                  placeholder="Digite o nome, código ou código de barras"
                  autoComplete="off"
                />
              </label>
              {isProductSearchOpen && normalizeProductSearch(productSearch) && (
                <ul className="pricing-product-suggestions" id="pricing-product-suggestions" role="listbox" aria-label="Produtos encontrados">
                  {productSuggestions.length > 0 ? productSuggestions.map((product, index) => (
                    <li key={product.id} role="presentation">
                      <button
                        className={index === activeProductSuggestion ? 'pricing-product-suggestion-active' : ''}
                        id={`pricing-product-option-${product.id}`}
                        type="button"
                        role="option"
                        aria-selected={index === activeProductSuggestion}
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => handleProductChange(product.id)}
                      >
                        <span><strong>{product.name}</strong><small>{product.product_code || 'Sem código'} · por {product.unit}</small></span>
                        <span>{formatMoney(product.unit_price_cents)}</span>
                      </button>
                    </li>
                  )) : (
                    <li className="pricing-product-no-results" role="presentation">Nenhum produto encontrado.</li>
                  )}
                </ul>
              )}
            </div>

            {selectedProduct && (
              <p className="pricing-current-price">
                Preço atual: <strong>{formatMoney(selectedProduct.unit_price_cents)}</strong> por {selectedProduct.unit}
              </p>
            )}

            <div className="pricing-fields-grid">
              <label className="pricing-field">
                Custo unitário total (R$)
                <input
                  value={costInput}
                  onChange={event => setCostInput(event.target.value)}
                  inputMode="decimal"
                  placeholder="0,00"
                  autoComplete="off"
                />
                <span>Inclua no custo os valores diretamente atribuídos à unidade.</span>
              </label>
              <label className="pricing-field">
                Despesas variáveis (%)
                <input value={formatRate(configuredVariableRateBps)} readOnly aria-readonly="true" />
                <span>Soma automática das taxas ativas em Configurações, incluindo tributos.</span>
              </label>
              <label className="pricing-field">
                Despesas fixas (%)
                <input value={formatRate(fixedCostRateBps)} readOnly aria-readonly="true" />
                <span>Soma automática dos percentuais ativos cadastrados em Configurações.</span>
              </label>
            </div>

            <fieldset className="pricing-mode">
              <legend>Como deseja formar o preço?</legend>
              <label>
                <input type="radio" name="calculationMode" checked={calculationMode === 'profit'} onChange={() => setCalculationMode('profit')} />
                Definir lucro desejado
              </label>
              <label>
                <input type="radio" name="calculationMode" checked={calculationMode === 'price'} onChange={() => setCalculationMode('price')} />
                Definir preço desejado
              </label>
            </fieldset>

            <div className="pricing-fields-grid">
              {calculationMode === 'profit' ? (
              <label className="pricing-field">
                Lucro desejado (%)
                <input
                  value={targetProfitInput}
                  onChange={event => setTargetProfitInput(event.target.value)}
                  inputMode="decimal"
                  placeholder="ex.: 20,00"
                  autoComplete="off"
                />
                <span>Percentual do preço de venda destinado ao lucro.</span>
              </label>
              ) : (
                <label className="pricing-field">
                  Preço final desejado (R$)
                  <input
                    value={desiredPriceInput}
                    onChange={event => setDesiredPriceInput(event.target.value)}
                    inputMode="decimal"
                    placeholder="ex.: 99,90"
                    autoComplete="off"
                  />
                  <span>O lucro será calculado automaticamente depois de descontar custo e despesas.</span>
                </label>
              )}
              {calculationMode === 'price' && (
                <label className="pricing-field">
                  Lucro calculado (%)
                  <input
                    value={derivedDesiredProfitBps === null ? '' : formatRate(derivedDesiredProfitBps)}
                    readOnly
                    aria-readonly="true"
                    placeholder={desiredPriceCents !== null ? 'Preço abaixo do mínimo' : 'Calculado automaticamente'}
                  />
                  <span>Margem pela fórmula divisor: 1 − despesas variáveis − despesas fixas − custo ÷ preço final. Abaixo do mínimo, mostra prejuízo.</span>
                </label>
              )}
            </div>
            {calculationMode === 'profit' && targetProfitBps === 0 && calculation && (
              <p className="pricing-current-price" role="status">
                Preço mínimo sugerido sem lucro: <strong>{formatMoney(calculation.priceCents)}</strong>
              </p>
            )}

            {variableFees.length > 0 && (
              <div className="pricing-configured-fees">
                <strong>Composição das despesas variáveis</strong>
                <ul>{variableFees.map(fee => <li key={fee.id}>{fee.name} · {formatRate(fee.rate_bps)}</li>)}</ul>
              </div>
            )}

            {fixedExpenses.length > 0 && (
              <div className="pricing-configured-fees">
                <strong>Composição das despesas fixas · {formatRate(fixedCostRateBps)}</strong>
                <ul>{fixedExpenses.map(expense => <li key={expense.id}>{expense.name} · {formatRate(expense.rate_bps)}</li>)}</ul>
              </div>
            )}

            {totalExpenseRateBps >= 10000 && (
              <p className="form-message" role="alert">
                As despesas variáveis e fixas devem somar menos de 100% do preço de venda. Revise Configurações.
              </p>
            )}
            {calculationMode === 'price' && desiredPriceCents !== null && minimumPriceCents !== null
              && desiredPriceCents < minimumPriceCents && (
                <p className="form-message" role="alert">
                  Preço abaixo do mínimo sem lucro: {formatMoney(minimumPriceCents)}. Aumente o preço para salvar.
                </p>
              )}
            {calculationMode === 'profit' && targetProfitBps === 0
              && calculation === null && minimumPriceCents !== null && (
                <p className="form-message" role="alert">
                  As despesas devem somar menos de 100% para calcular o preço mínimo.
                </p>
              )}

            <button
              className="button button-primary pricing-save"
              type="button"
              onClick={handleSavePrice}
              disabled={
                !calculation || !selectedProduct || isSaving
                || (calculationMode === 'profit' && targetProfitBps === null)
              }
            >
              {isSaving ? 'Salvando preço…' : 'Salvar custo e preço no produto'}
            </button>
          </>
        )}
      </div>

      <aside className="pricing-result" aria-live="polite" aria-labelledby="pricingResultTitle">
        <p className="eyebrow">RESULTADO</p>
        <h2 id="pricingResultTitle">Preço sugerido</h2>
        {calculation ? (
          <>
            <p className="pricing-price">{formatMoney(calculation.priceCents)}</p>
            <p className="pricing-unit">por {selectedProduct?.unit ?? 'unidade de venda'}</p>
            <dl className="pricing-breakdown">
              <div><dt>Custo unitário</dt><dd>{formatMoney(costCents ?? 0)}</dd></div>
              <div><dt>Despesas variáveis · {formatRate(configuredVariableRateBps)}</dt><dd>{formatMoney(calculation.variableExpenseCents)}</dd></div>
              <div><dt>Despesas fixas · {formatRate(fixedCostRateBps)}</dt><dd>{formatMoney(calculation.fixedExpenseCents)}</dd></div>
              <div><dt>Lucro {calculationMode === 'price' ? 'calculado' : 'desejado'} · {formatRate(calculation.targetProfitBps)}</dt><dd>{formatMoney(calculation.targetProfitCents)}</dd></div>
            </dl>
            <div className="pricing-indicators">
              <p>Divisor para o custo <strong>{(1 / calculation.markupFactor).toLocaleString('pt-BR', {
                minimumFractionDigits: 5,
                maximumFractionDigits: 5
              })}</strong></p>
              <p>Acréscimo sobre o custo <strong>{calculation.markupOverCostPercent.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</strong></p>
            </div>
          </>
        ) : (
          <p className="pricing-placeholder">{calculationMode === 'price'
            ? `Selecione o produto, informe o custo e um preço igual ou superior ao mínimo de ${minimumPriceCents ? formatMoney(minimumPriceCents) : 'custo mais despesas'}.`
            : 'Selecione o produto, informe o custo e o lucro desejado para visualizar o preço.'}</p>
        )}
        <p className="pricing-formula">
          Preço = custo ÷ [1 − (despesas variáveis + despesas fixas + lucro)].
          Tributos são somados às despesas variáveis; os percentuais são preenchidos automaticamente pelas Configurações.
        </p>
      </aside>

      {message && (
        <p className={`pricing-message${messageIsError ? ' pricing-message-error' : ''}`} role={messageIsError ? 'alert' : 'status'}>
          {message}
        </p>
      )}
    </section>
  );
}
