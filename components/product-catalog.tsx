'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Product } from '@/lib/supabase/database.types';
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@/lib/supabase/client';

const supabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
);

const productColumns =
  'id, product_code, barcode, name, unit, unit_price_cents, stock_quantity, active, created_at, updated_at';
type ProductBatch = Database['public']['Tables']['product_batches']['Row'];
type ProductSort = 'name-asc' | 'name-desc' | 'expiry-asc' | 'expiry-desc' | 'stock-desc' | 'stock-asc';
const productUnits = [
  ['UN', 'Unidade (UN)'],
  ['PCT', 'Pacote (PCT)'],
  ['KG', 'Quilograma (KG)'],
  ['G', 'Grama (G)'],
  ['LT', 'Litro (LT)'],
  ['L', 'Litro legado (L)'],
  ['ML', 'Mililitro (ML)'],
  ['M', 'Metro (M)'],
  ['CM', 'Centímetro (CM)'],
  ['CX', 'Caixa (CX)'],
  ['FD', 'Fardo (FD)'],
  ['DZ', 'Dúzia (DZ)'],
  ['SC', 'Saco (SC)']
] as const;

function parsePriceCents(value: string) {
  const normalized = value.trim();
  if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(normalized)) return null;

  const [reais, cents = ''] = normalized.replace(/\./g, '').split(',');
  const result = Number(reais) * 100 + Number(cents.padEnd(2, '0'));
  return Number.isSafeInteger(result) && result <= 2147483647 ? result : null;
}

function parseQuantity(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) return null;
  const quantity = Number(normalized);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

function formatPrice(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatQuantity(quantity: number) {
  return quantity.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

function isProductSort(value: string): value is ProductSort {
  return value === 'name-asc' || value === 'name-desc'
    || value === 'expiry-asc' || value === 'expiry-desc'
    || value === 'stock-desc' || value === 'stock-asc';
}

function getOperationError(error: { code?: string }) {
  if (error.code === '23505') return 'Já existe um produto com esse código ou código de barras.';
  if (error.code === '42501') return 'Seu perfil não tem permissão para esta operação.';
  if (error.code === 'PGRST202' || error.code === 'PGRST205' || error.code === '42P01') {
    return 'A estrutura de produtos ainda não foi aplicada no Supabase.';
  }
  return 'Não foi possível concluir a operação. Verifique a conexão e tente novamente.';
}

export default function ProductCatalog() {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [sortOrder, setSortOrder] = useState<ProductSort>('name-asc');
  const [expiryDateByProduct, setExpiryDateByProduct] = useState<Record<string, string | null>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [productBatches, setProductBatches] = useState<ProductBatch[]>([]);
  const [isRecordingMovement, setIsRecordingMovement] = useState(false);
  const [movementDirection, setMovementDirection] = useState<'in' | 'out'>('in');
  const modifyDialogRef = useRef<HTMLDialogElement>(null);

  const loadProducts = useCallback(async () => {
    const { data, error } = await createClient()
      .from('products')
      .select(productColumns)
      .order('name');

    if (error) {
      console.error('Product catalog query failed:', error.code);
      setMessage(getOperationError(error));
      return;
    }

    setProducts(data);
    setMessage('');
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!supabaseConfigured) {
        setIsLoading(false);
        return;
      }

      try {
        await loadProducts();
      } catch {
        if (!cancelled) setMessage('Não foi possível carregar os produtos. Verifique a conexão.');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [loadProducts]);

  useEffect(() => {
    const dialog = modifyDialogRef.current;
    if (!dialog) return;

    if (editingProduct && !dialog.open) dialog.showModal();
    if (!editingProduct && dialog.open) dialog.close();
  }, [editingProduct]);

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('pt-BR');
    if (!query) return products;

    return products.filter(product =>
      [product.product_code, product.barcode ?? '', product.name]
        .some(value => value.toLocaleLowerCase('pt-BR').includes(query))
    );
  }, [products, search]);

  const sortedProducts = useMemo(() => [...filteredProducts].sort((left, right) => {
    if (sortOrder === 'stock-desc') return right.stock_quantity - left.stock_quantity;
    if (sortOrder === 'stock-asc') return left.stock_quantity - right.stock_quantity;
    if (sortOrder === 'expiry-asc' || sortOrder === 'expiry-desc') {
      const leftDate = expiryDateByProduct[left.id] ?? null;
      const rightDate = expiryDateByProduct[right.id] ?? null;
      if (leftDate === null && rightDate !== null) return 1;
      if (leftDate !== null && rightDate === null) return -1;
      if (leftDate !== rightDate) {
        const compare = (leftDate ?? '').localeCompare(rightDate ?? '');
        return sortOrder === 'expiry-asc' ? compare : -compare;
      }
    }
    const compare = left.name.localeCompare(right.name, 'pt-BR', { sensitivity: 'base' });
    return sortOrder === 'name-asc' ? compare : -compare;
  }), [filteredProducts, sortOrder, expiryDateByProduct]);

  async function handleSortChange(nextSort: ProductSort) {
    if (nextSort === 'expiry-asc' || nextSort === 'expiry-desc') {
      setMessage('');
      try {
        const { data, error } = await createClient()
          .from('product_batches')
          .select('product_id,expiration_date')
          .gt('remaining_quantity', 0)
          .not('expiration_date', 'is', null)
          .order('expiration_date', { ascending: true })
          .range(0, 999);
        if (error) {
          console.error('Product expiry sort query failed:', error.code);
          setMessage(error.code === 'PGRST205' || error.code === '42P01'
            ? 'Aplique a migration de lotes para ordenar produtos por validade.'
            : getOperationError(error));
          return;
        }
        const dates: Record<string, string | null> = {};
        const batches = [...data];
        for (let offset = 1000; data.length === 1000; offset += 1000) {
          const { data: nextPage, error: pageError } = await createClient()
            .from('product_batches')
            .select('product_id,expiration_date')
            .gt('remaining_quantity', 0)
            .not('expiration_date', 'is', null)
            .order('expiration_date', { ascending: true })
            .range(offset, offset + 999);
          if (pageError) {
            console.error('Product expiry sort pagination failed:', pageError.code);
            setMessage(getOperationError(pageError));
            return;
          }
          batches.push(...nextPage);
          if (nextPage.length < 1000) break;
        }
        for (const batch of batches) {
          if (batch.expiration_date && (
            dates[batch.product_id] === undefined
            || (nextSort === 'expiry-desc' && batch.expiration_date > (dates[batch.product_id] ?? ''))
          )) {
            dates[batch.product_id] = batch.expiration_date;
          }
        }
        setExpiryDateByProduct(dates);
      } catch {
        setMessage('Não foi possível ordenar os produtos por validade. Verifique a conexão.');
        return;
      }
    }
    setSortOrder(nextSort);
  }

  async function handleCreateProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    setIsSaving(true);

    const form = event.currentTarget;
    const formData = new FormData(form);
    const productCode = String(formData.get('productCode') ?? '').trim().toUpperCase();
    const barcode = String(formData.get('barcode') ?? '').trim() || null;
    const name = String(formData.get('name') ?? '').trim();
    const unit = String(formData.get('unit') ?? 'UN').trim().toUpperCase();
    const unitPriceCents = parsePriceCents(String(formData.get('price') ?? ''));

    if (!productCode || productCode.length > 60 || !name || name.length > 160
      || (barcode !== null && barcode.length > 64) || unit.length > 8
      || unitPriceCents === null) {
      setMessage('Confira os campos: código, nome e unidade são obrigatórios; informe um preço válido.');
      setIsSaving(false);
      return;
    }
    try {
      const { error } = await createClient().from('products').insert({
        product_code: productCode,
        barcode,
        name,
        unit,
        unit_price_cents: unitPriceCents
      });

      if (error) {
        console.error('Product creation failed:', error.code);
        setMessage(getOperationError(error));
        return;
      }

      form.reset();
      setIsFormOpen(false);
      await loadProducts();
    } catch {
      setMessage('Não foi possível cadastrar o produto. Verifique a conexão e tente novamente.');
    } finally {
      setIsSaving(false);
    }
  }

  async function loadProductBatches(productId: string) {
    try {
      const { data, error } = await createClient()
        .from('product_batches')
        .select('*')
        .eq('product_id', productId)
        .gt('remaining_quantity', 0)
        .order('expiration_date', { ascending: true, nullsFirst: false });
      if (error) {
        if (error.code === 'PGRST205' || error.code === '42P01') {
          setProductBatches([]);
          setMessage(
            'A tabela de lotes ainda não existe no Supabase. Execute o arquivo ' +
            'supabase/migrations/20261010150000_pricing_invoice_batches.sql por inteiro ' +
            'no SQL Editor, após as migrations anteriores, e atualize esta página.'
          );
          return false;
        }
        console.error('Product batch query failed:', error.code);
        setMessage(getOperationError(error));
        return false;
      }
      setProductBatches(data);
      return true;
    } catch {
      setMessage('Não foi possível carregar os lotes deste produto.');
      return false;
    }
  }

  async function handleRecordMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingProduct) return;

    setMessage('');
    setIsRecordingMovement(true);
    const form = event.currentTarget;
    const formData = new FormData(form);
    const quantity = parseQuantity(String(formData.get('quantity') ?? ''));
    const reason = String(formData.get('reason') ?? 'adjustment');
    const note = String(formData.get('note') ?? '').trim();

    if (quantity === null || note.length > 500) {
      setMessage('Informe uma quantidade positiva (até três casas decimais) e uma observação com até 500 caracteres.');
      setIsRecordingMovement(false);
      return;
    }

    try {
      const { error } = await createClient().rpc('record_stock_movement_with_expiry', {
        p_product_id: editingProduct.id,
        p_quantity: movementDirection === 'out' ? -quantity : quantity,
        p_reason: movementDirection === 'out' ? 'adjustment' : reason,
        p_note: note || null,
        p_expiration_date: movementDirection === 'in'
          ? String(formData.get('expirationDate') ?? '') || null
          : null
      });

      if (error) {
        console.error('Stock movement failed:', error.code);
        setMessage(error.code === 'P0001'
          ? 'A retirada excede o saldo disponível ou o produto está inativo.'
          : getOperationError(error));
        return;
      }

      form.reset();
      await loadProducts();
      await loadProductBatches(editingProduct.id);
      setEditingProduct(current => current
        ? { ...current, stock_quantity: current.stock_quantity + (movementDirection === 'out' ? -quantity : quantity) }
        : null);
    } catch {
      setMessage('Não foi possível registrar a movimentação. Verifique a conexão e tente novamente.');
    } finally {
      setIsRecordingMovement(false);
    }
  }

  async function handleUpdateProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingProduct) return;

    setMessage('');
    setIsSaving(true);
    const formData = new FormData(event.currentTarget);
    const productCode = String(formData.get('productCode') ?? '').trim().toUpperCase();
    const barcode = String(formData.get('barcode') ?? '').trim() || null;
    const name = String(formData.get('name') ?? '').trim();
    const unit = String(formData.get('unit') ?? '').trim().toUpperCase();
    const unitPriceCents = parsePriceCents(String(formData.get('price') ?? ''));

    if (!productCode || productCode.length > 60 || !name || name.length > 160
      || (barcode !== null && barcode.length > 64) || !unit || unit.length > 8
      || unitPriceCents === null) {
      setMessage('Confira os campos: código interno, nome e unidade são obrigatórios; informe um preço válido.');
      setIsSaving(false);
      return;
    }
    if (unit !== editingProduct.unit && editingProduct.stock_quantity > 0
      && !window.confirm(
        `A unidade mudará de ${editingProduct.unit} para ${unit}. ` +
        `O saldo de ${formatQuantity(editingProduct.stock_quantity)} será mantido numericamente, ` +
        `não convertido, e passará a ser interpretado como ${unit}. Confirme que essa alteração está correta.`
      )) {
      setIsSaving(false);
      return;
    }

    try {
      const update = {
        product_code: productCode,
        barcode,
        name,
        unit,
        unit_price_cents: unitPriceCents
      };
      const { error } = await createClient()
        .from('products')
        .update(update)
        .eq('id', editingProduct.id);

      if (error) {
        console.error('Product update failed:', error.code);
        setMessage(getOperationError(error));
        return;
      }

      setEditingProduct(current => current ? { ...current, ...update } : null);
      await loadProducts();
      setMessage('Produto atualizado.');
    } catch {
      setMessage('Não foi possível atualizar o produto. Verifique a conexão e tente novamente.');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleArchiveProduct() {
    if (!editingProduct) return;
    const willArchive = editingProduct.active;
    const action = willArchive ? 'Excluir' : 'Reativar';
    const detail = willArchive
      ? 'O produto será desativado e sairá do catálogo ativo. O histórico de estoque e preços será preservado.'
      : 'O produto voltará a aparecer no catálogo e poderá ser usado novamente.';
    if (!window.confirm(`${action} “${editingProduct.name}”? ${detail}`)) return;

    setIsSaving(true);
    setMessage('');
    try {
      const { error } = await createClient()
        .from('products')
        .update({ active: !willArchive })
        .eq('id', editingProduct.id);
      if (error) {
        console.error('Product status update failed:', error.code);
        setMessage(getOperationError(error));
        return;
      }
      setEditingProduct(current => current ? { ...current, active: !willArchive } : null);
      await loadProducts();
      setMessage(willArchive ? 'Produto excluído do catálogo ativo; o histórico foi preservado.' : 'Produto reativado.');
    } catch {
      setMessage('Não foi possível alterar o status do produto. Verifique a conexão e tente novamente.');
    } finally {
      setIsSaving(false);
    }
  }

  if (!supabaseConfigured) {
    return (
      <section className="setup-notice" aria-labelledby="supabaseSetupTitle">
        <h2 id="supabaseSetupTitle">Conecte o Supabase para iniciar o catálogo</h2>
        <p>Configure as variáveis do projeto e aplique a migration de produtos e estoque antes de registrar dados comerciais.</p>
        <p>O modo local de pré-visualização não salva produtos nem movimentações.</p>
      </section>
    );
  }

  return (
    <section className="catalog" aria-labelledby="catalogTitle">
      <div className="catalog-toolbar">
        <label className="catalog-search">
          <span>Buscar produto</span>
          <input
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Nome, código ou código de barras"
          />
        </label>
        <button
          className="button button-primary catalog-add"
          type="button"
          onClick={() => { setMessage(''); setIsFormOpen(open => !open); }}
        >
          {isFormOpen ? 'Fechar cadastro' : 'Cadastrar produto'}
        </button>
        <label className="catalog-sort">
          <span className="sr-only">Organizar produtos</span>
          <select
            aria-label="Organizar produtos"
            value={sortOrder}
            onChange={event => {
              if (isProductSort(event.target.value)) void handleSortChange(event.target.value);
            }}
          >
            <option value="name-asc">Nome (A–Z)</option>
            <option value="name-desc">Nome (Z–A)</option>
            <option value="expiry-asc">Validade (primeiro ao último)</option>
            <option value="expiry-desc">Validade (último ao primeiro)</option>
            <option value="stock-desc">Estoque (mais ao menos)</option>
            <option value="stock-asc">Estoque (menos ao mais)</option>
          </select>
        </label>
      </div>

      {message && <p className="workspace-message" role="alert">{message}</p>}

      {isFormOpen && (
        <form className="catalog-form" onSubmit={handleCreateProduct}>
          <h2 id="catalogTitle">Novo produto</h2>
          <div className="catalog-form-grid">
            <label>
              Código interno (ID)
              <input name="productCode" required maxLength={60} autoComplete="off" />
            </label>
            <label>
              Código de barras
              <input name="barcode" maxLength={64} inputMode="numeric" autoComplete="off" />
            </label>
            <label className="catalog-name-field">
              Nome do produto
              <input name="name" required maxLength={160} autoComplete="off" />
            </label>
            <label>
              Unidade
              <select name="unit" defaultValue="UN">
                {productUnits.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              Preço de venda (R$)
              <input name="price" required inputMode="decimal" placeholder="0,00" autoComplete="off" />
            </label>
          </div>
          <p className="catalog-hint">O saldo começa em zero. Registre a entrada inicial em “Modificar produto”.</p>
          <button className="button button-primary" type="submit" disabled={isSaving}>
            {isSaving ? 'Salvando…' : 'Salvar produto'}
          </button>
        </form>
      )}

      {isLoading ? (
        <p className="catalog-state" role="status">Carregando produtos…</p>
      ) : products.length === 0 ? (
        <div className="catalog-empty">
          <h2>Nenhum produto cadastrado</h2>
          <p>Cadastre o primeiro item para preparar o catálogo do caixa.</p>
        </div>
      ) : filteredProducts.length === 0 ? (
        <p className="catalog-state">Nenhum produto corresponde à busca.</p>
      ) : (
        <div className="catalog-table-wrap">
          <table className="catalog-table">
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Produto</th>
                <th scope="col">Estoque disponível</th>
                <th scope="col">Preço</th>
                <th scope="col">Código de barras</th>
                <th scope="col"><span className="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              {sortedProducts.map(product => (
                <tr key={product.id}>
                  <td data-label="ID">{product.product_code}</td>
                  <td data-label="Produto">
                    <strong>{product.name}</strong>
                    <span className="catalog-unit">{product.unit}{product.active ? '' : ' · Inativo'}</span>
                  </td>
                  <td className="catalog-stock-cell" data-label="Estoque disponível">
                    <strong>{formatQuantity(product.stock_quantity)} {product.unit}</strong>
                  </td>
                  <td data-label="Preço">{formatPrice(product.unit_price_cents)}</td>
                  <td data-label="Código de barras">{product.barcode || '—'}</td>
                  <td data-label="Ações">
                    <button
                      className="button button-secondary catalog-edit-button"
                      type="button"
                      onClick={() => {
                        setMessage('');
                        setMovementDirection('in');
                        setProductBatches([]);
                        setEditingProduct(product);
                        void loadProductBatches(product.id);
                      }}
                      aria-label={`Modificar ${product.name}`}
                      title="Modificar produto"
                    >
                      <span aria-hidden="true">✏️</span>
                      <span>EDITAR</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingProduct && (
        <dialog
          ref={modifyDialogRef}
          className="catalog-dialog"
          aria-labelledby="modifyProductTitle"
          onClose={() => setEditingProduct(null)}
        >
            <h2 id="modifyProductTitle">Modificar produto</h2>
            <p>Edite todos os dados comerciais, ajuste o saldo ou exclua o produto do catálogo ativo.</p>
            {!editingProduct.active && <p className="catalog-hint">Produto inativo. Reative-o para voltar a exibi-lo nas operações.</p>}
            <form className="catalog-dialog-form" onSubmit={handleUpdateProduct}>
              <div className="catalog-form-grid">
                <label>
                  Código interno (ID comercial)
                  <input name="productCode" required maxLength={60} defaultValue={editingProduct.product_code} autoComplete="off" />
                </label>
                <label>
                  Código de barras
                  <input name="barcode" maxLength={64} inputMode="numeric" defaultValue={editingProduct.barcode ?? ''} autoComplete="off" />
                </label>
                <label className="catalog-name-field">
                  Nome do produto
                  <input name="name" required maxLength={160} defaultValue={editingProduct.name} autoComplete="off" />
                </label>
                <label>
                  Unidade
                  <select name="unit" defaultValue={editingProduct.unit}>
                    {!productUnits.some(([value]) => value === editingProduct.unit) && (
                      <option value={editingProduct.unit}>{editingProduct.unit} (atual)</option>
                    )}
                    {productUnits.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Preço de venda (R$)
                  <input name="price" required inputMode="decimal" defaultValue={(editingProduct.unit_price_cents / 100).toFixed(2).replace('.', ',')} autoComplete="off" />
                </label>
              </div>
              <p className="catalog-hint">O ID técnico UUID é permanente para preservar referências e histórico; altere o código interno para mudar o ID comercial.</p>
              <div className="catalog-dialog-actions">
                <button className="button button-secondary" type="button" onClick={() => setEditingProduct(null)}>Fechar</button>
                <button className="button button-primary" type="submit" disabled={isSaving}>
                  {isSaving ? 'Salvando…' : 'Salvar alterações'}
                </button>
              </div>
            </form>

            <section className="catalog-edit-stock" aria-labelledby="editStockTitle">
              <h3 id="editStockTitle">Estoque</h3>
              <p>Saldo atual: <strong>{formatQuantity(editingProduct.stock_quantity)} {editingProduct.unit}</strong></p>
              <form className="catalog-form-grid" onSubmit={handleRecordMovement}>
                <label>
                  Tipo
                  <select
                    name="direction"
                    value={movementDirection}
                    onChange={event => setMovementDirection(event.target.value === 'out' ? 'out' : 'in')}
                  >
                    <option value="in">Entrada</option>
                    <option value="out">Retirada</option>
                  </select>
                </label>
                {movementDirection === 'in' && (
                  <label>
                    Motivo da entrada
                    <select name="reason" defaultValue="purchase">
                      <option value="purchase">Compra / reposição</option>
                      <option value="return">Devolução</option>
                      <option value="adjustment">Ajuste</option>
                    </select>
                  </label>
                )}
                {movementDirection === 'in' && (
                  <label>
                    Validade deste lote (opcional)
                    <input name="expirationDate" type="date" />
                  </label>
                )}
                <label>
                  Quantidade ({editingProduct.unit})
                  <input name="quantity" required inputMode="decimal" placeholder="0,000" autoComplete="off" />
                </label>
                <label className="catalog-name-field">
                  Observação (opcional)
                  <input name="note" maxLength={500} autoComplete="off" />
                </label>
                <div className="catalog-dialog-actions">
                  <button className="button button-primary" type="submit" disabled={isRecordingMovement || !editingProduct.active}>
                    {isRecordingMovement ? 'Registrando…' : 'Registrar movimentação'}
                  </button>
                </div>
              </form>
              <div className="product-batches">
                <h4>Lotes ativos</h4>
                {productBatches.length ? (
                  <ul>
                    {productBatches.map(batch => (
                      <li key={batch.id}>
                        <span>{formatQuantity(batch.remaining_quantity)} {editingProduct.unit}</span>
                        <strong>{batch.expiration_date
                          ? new Date(`${batch.expiration_date}T00:00:00`).toLocaleDateString('pt-BR')
                          : 'Sem validade cadastrada'}</strong>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>Não há saldo rastreado em lotes com validade.</p>
                )}
              </div>
            </section>
            <div className="catalog-delete-actions">
              <button className="button button-danger" type="button" onClick={() => void handleArchiveProduct()} disabled={isSaving}>
                {editingProduct.active ? 'Excluir produto' : 'Reativar produto'}
              </button>
              <span>{editingProduct.active ? 'Exclusão lógica: preserva movimentos e histórico.' : 'Reative para voltar a usar este produto.'}</span>
            </div>
            {message && <p className="workspace-message" role="alert">{message}</p>}
        </dialog>
      )}
    </section>
  );
}
