'use client';

import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Database, Product } from '@/lib/supabase/database.types';
import { calculateMarkupPrice } from '@/lib/pricing-calculation.mjs';

type Invoice = Database['public']['Tables']['purchase_invoices']['Row'];
type InvoiceItem = Database['public']['Tables']['purchase_invoice_items']['Row'];
type InvoiceLine = {
  key: number;
  productId: string;
  quantity: string;
  unitCost: string;
  expirationDate: string;
  previewName?: string;
  previewCode?: string;
  previewUnit?: string;
  taxSummary?: string;
};
type ImportedInvoice = {
  supplierName: string;
  supplierPhone: string;
  supplierAddress: string;
  invoiceNumber: string;
  issueDate: string;
  lines: InvoiceLine[];
};

const productSelect = 'id, product_code, barcode, name, unit, unit_price_cents, active';

function parseMoneyCents(value: string) {
  const normalized = value.trim();
  if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(normalized)) return null;
  const [reais, cents = ''] = normalized.replace(/\./g, '').split(',');
  const amount = Number(reais) * 100 + Number(cents.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 2147483647 ? amount : null;
}

function parseQuantity(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) return null;
  const quantity = Number(normalized);
  return Number.isFinite(quantity) && quantity > 0 && quantity <= 99999999999.999 ? quantity : null;
}

function parseRateBasisPoints(value: string) {
  const normalized = value.trim();
  if (!/^\d{1,3}(?:,\d{1,2})?$/.test(normalized)) return null;
  const rate = Number(normalized.replace(',', '.'));
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? Math.round(rate * 100) : null;
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function getLocalDateInputValue() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return [now.getFullYear(), month, day].join('-');
}

function xmlEscape(value: string) {
  return value.replace(/[<>&'"]/g, character => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;'
  })[character] ?? character);
}

function safeFilePart(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'nota';
}

function findXmlElement(parent: Element, localName: string) {
  return Array.from(parent.getElementsByTagName('*'))
    .find(element => element.localName === localName) ?? null;
}

function xmlText(parent: Element, localName: string) {
  return findXmlElement(parent, localName)?.textContent?.trim() ?? '';
}

function formatXmlCents(value: string) {
  const cents = parseXmlMoneyCents(value);
  return cents === null ? null : (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function getInvoiceTaxSummary(detail: Element) {
  const tax = findXmlElement(detail, 'imposto');
  if (!tax) return 'Tributação não informada';
  const summary: string[] = [];
  const ncm = xmlText(detail, 'NCM');
  const cfop = xmlText(detail, 'CFOP');
  const cst = xmlText(tax, 'CST') || xmlText(tax, 'CSOSN');
  const icms = formatXmlCents(xmlText(tax, 'vICMS'));
  const ipi = formatXmlCents(xmlText(tax, 'vIPI'));
  const pis = formatXmlCents(xmlText(tax, 'vPIS'));
  const cofins = formatXmlCents(xmlText(tax, 'vCOFINS'));
  if (ncm) summary.push(`NCM ${ncm}`);
  if (cfop) summary.push(`CFOP ${cfop}`);
  if (cst) summary.push(`CST/CSOSN ${cst}`);
  if (icms) summary.push(`ICMS ${icms}`);
  if (ipi) summary.push(`IPI ${ipi}`);
  if (pis) summary.push(`PIS ${pis}`);
  if (cofins) summary.push(`COFINS ${cofins}`);
  return summary.length ? summary.join(' · ') : 'Tributos sem valores informados';
}

function parseXmlMoneyCents(value: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 2147483647 ? cents : null;
}

function getWeightedImportCostCents(lines: InvoiceLine[], productId: string) {
  let weightedCost = 0;
  let totalQuantityMilli = 0;
  for (const line of lines) {
    if (line.productId !== productId) continue;
    const quantity = parseQuantity(line.quantity);
    const costCents = parseMoneyCents(line.unitCost);
    if (quantity === null || costCents === null) return null;
    const quantityMilli = Math.round(quantity * 1000);
    const lineWeightedCost = quantityMilli * costCents;
    if (!Number.isSafeInteger(lineWeightedCost) || !Number.isSafeInteger(weightedCost + lineWeightedCost)) return null;
    weightedCost += lineWeightedCost;
    totalQuantityMilli += quantityMilli;
  }
  if (!Number.isSafeInteger(totalQuantityMilli) || totalQuantityMilli === 0) return null;
  const average = Math.round(weightedCost / totalQuantityMilli);
  return average <= 2147483647 ? average : null;
}

function normalizeXmlQuantity(value: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 99999999999.999
    || Math.abs(quantity - Math.round(quantity * 1000) / 1000) > 0.0000001) return null;
  return quantity.toFixed(3).replace(/\.?0+$/, '').replace('.', ',');
}

function parseInvoiceXml(xml: string, products: Pick<Product, 'id' | 'product_code' | 'barcode' | 'name' | 'unit'>[]): ImportedInvoice {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML com declarações DTD/ENTITY não é aceito.');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('O arquivo não contém um XML válido.');

  const allElements = Array.from(document.getElementsByTagName('*'));
  const operational = allElements.some(element => element.localName === 'aacPurchaseInvoice');
  const invoice = operational
    ? findXmlElement(document.documentElement, 'invoice')
    : findXmlElement(document.documentElement, 'infNFe');
  if (!invoice) throw new Error('Formato não reconhecido. Selecione um XML operacional do A.A.C. ou o XML de uma NF-e.');

  let supplierName: string;
  let supplierPhone = '';
  let supplierAddress = '';
  let invoiceNumber: string;
  let issueDate: string;
  let lines: InvoiceLine[];

  if (operational) {
    supplierName = xmlText(invoice, 'supplier');
    invoiceNumber = xmlText(invoice, 'invoiceNumber');
    issueDate = xmlText(invoice, 'issueDate').slice(0, 10);
    const itemElements = Array.from(invoice.getElementsByTagName('*'))
      .filter(element => element.localName === 'item');
    lines = itemElements.map((item, index) => {
      const productId = xmlText(item, 'productId');
      const productCode = xmlText(item, 'productCode').toLocaleUpperCase('pt-BR');
      const product = products.find(entry => entry.id === productId)
        ?? products.find(entry => entry.product_code.toLocaleUpperCase('pt-BR') === productCode);
      const quantity = normalizeXmlQuantity(xmlText(item, 'quantity'));
      const unitCostCents = Number(xmlText(item, 'unitCostCents'));
      if (!Number.isSafeInteger(unitCostCents) || unitCostCents <= 0 || unitCostCents > 2147483647) {
        throw new Error(`O custo do item ${index + 1} no XML operacional é inválido.`);
      }
      return {
        key: index,
        productId: product?.id ?? '',
        quantity: quantity ?? '',
        unitCost: (unitCostCents / 100).toFixed(2).replace('.', ','),
        expirationDate: xmlText(item, 'expirationDate'),
        previewName: xmlText(item, 'productName') || product?.name || `Item ${index + 1}`,
        previewCode: productCode,
        previewUnit: product?.unit ?? '',
        taxSummary: 'Tributação não informada no XML operacional'
      };
    });
  } else {
    const ide = findXmlElement(invoice, 'ide');
    const emit = findXmlElement(invoice, 'emit');
    const address = emit ? findXmlElement(emit, 'enderEmit') : null;
    const details = Array.from(invoice.getElementsByTagName('*'))
      .filter(element => element.localName === 'det');
    supplierName = emit ? xmlText(emit, 'xNome') : '';
    supplierPhone = address ? xmlText(address, 'fone') : '';
    supplierAddress = address
      ? [
        [xmlText(address, 'xLgr'), xmlText(address, 'nro')].filter(Boolean).join(', '),
        [xmlText(address, 'xCpl'), xmlText(address, 'xBairro')].filter(Boolean).join(' · '),
        [xmlText(address, 'xMun'), xmlText(address, 'UF')].filter(Boolean).join(' / '),
        xmlText(address, 'CEP')
      ].filter(Boolean).join(' · ')
      : '';
    invoiceNumber = ide ? xmlText(ide, 'nNF') : '';
    issueDate = ide ? (xmlText(ide, 'dhEmi') || xmlText(ide, 'dEmi')).slice(0, 10) : '';
    lines = details.map((detail, index) => {
      const prod = findXmlElement(detail, 'prod');
      if (!prod) throw new Error(`Dados do produto no item ${index + 1} da NF-e estão ausentes.`);
      const code = xmlText(prod, 'cProd').toLocaleUpperCase('pt-BR');
      const barcode = xmlText(prod, 'cEAN');
      const product = products.find(entry => barcode && barcode !== 'SEM GTIN' && entry.barcode === barcode)
        ?? products.find(entry => entry.product_code.toLocaleUpperCase('pt-BR') === code);
      const quantity = normalizeXmlQuantity(xmlText(prod, 'qCom'));
      const unitCostCents = parseXmlMoneyCents(xmlText(prod, 'vUnCom'));
      if (!quantity) throw new Error(`A quantidade do item ${index + 1} deve ter até três casas decimais.`);
      if (unitCostCents === null) throw new Error(`O custo unitário do item ${index + 1} na NF-e é inválido.`);
      return {
        key: index,
        productId: product?.id ?? '',
        quantity,
        unitCost: (unitCostCents / 100).toFixed(2).replace('.', ','),
        expirationDate: xmlText(prod, 'dVal'),
        previewName: xmlText(prod, 'xProd') || product?.name || `Item ${index + 1}`,
        previewCode: code || barcode,
        previewUnit: xmlText(prod, 'uCom') || product?.unit || '',
        taxSummary: getInvoiceTaxSummary(detail)
      };
    });
  }

  if (!supplierName || !invoiceNumber || !isValidIsoDate(issueDate)
    || lines.length === 0 || lines.length > 200) {
    throw new Error('O XML precisa conter fornecedor, número, data válida e entre 1 e 200 itens.');
  }
  return { supplierName, supplierPhone, supplierAddress, invoiceNumber, issueDate, lines };
}

function isValidIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function operationMessage(code?: string) {
  if (code === '23505') return 'Esta nota de fornecedor já foi registrada.';
  if (code === '42501') return 'Somente administradores e gerentes podem registrar e consultar notas.';
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42P01') {
    return 'Aplique a migration 20261010190000_sales_and_markup_invoice_import.sql no Supabase após as migrations anteriores.';
  }
  if (code === 'P0001') return 'Os dados da nota, dos produtos ou das quantidades são inválidos. Revise e tente novamente.';
  return 'Não foi possível concluir a operação. Verifique sua conexão e tente novamente.';
}

export default function PurchaseInvoices() {
  const [products, setProducts] = useState<Pick<Product, 'id' | 'product_code' | 'barcode' | 'name' | 'unit'>[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [lines, setLines] = useState<InvoiceLine[]>([
    { key: 0, productId: '', quantity: '', unitCost: '', expirationDate: '' }
  ]);
  const [xmlPreview, setXmlPreview] = useState<ImportedInvoice | null>(null);
  const [applySuggestedPrices, setApplySuggestedPrices] = useState(false);
  const [targetProfitInput, setTargetProfitInput] = useState('0,00');
  const [markupExpenseRateBps, setMarkupExpenseRateBps] = useState(0);
  const [supplierNameInput, setSupplierNameInput] = useState('');
  const [invoiceNumberInput, setInvoiceNumberInput] = useState('');
  const [issueDateInput, setIssueDateInput] = useState(getLocalDateInputValue());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [downloadingInvoiceId, setDownloadingInvoiceId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [canManage, setCanManage] = useState(false);

  const loadInvoices = useCallback(async () => {
    const supabase = createClient();
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
    if (claimsError || !claimsData?.claims?.sub) {
      setErrorMessage('Entre novamente para acessar as notas de entrada.');
      return false;
    }
    const { data: profile, error: profileError } = await supabase
      .from('profiles').select('role').eq('user_id', claimsData.claims.sub).maybeSingle();
    if (profileError) {
      setErrorMessage(operationMessage(profileError.code));
      return false;
    }
    if (!profile || (profile.role !== 'admin' && profile.role !== 'manager')) {
      setCanManage(false);
      return false;
    }
    setCanManage(true);

    const [productsResult, invoicesResult, feesResult, expensesResult] = await Promise.all([
      supabase.from('products').select(productSelect).eq('active', true).order('name'),
      supabase.from('purchase_invoices').select('*').order('created_at', { ascending: false }).limit(50),
      supabase.from('pricing_variable_fees').select('rate_bps').eq('active', true),
      supabase.from('pricing_fixed_expenses').select('rate_bps').eq('active', true)
    ]);
    const error = productsResult.error ?? invoicesResult.error ?? feesResult.error ?? expensesResult.error;
    if (error) {
      setErrorMessage(operationMessage(error.code));
      return false;
    }
    if (!productsResult.data || !invoicesResult.data || !feesResult.data || !expensesResult.data) {
      setErrorMessage('Não foi possível carregar os produtos, notas e taxas de markup.');
      return false;
    }
    setProducts(productsResult.data);
    setInvoices(invoicesResult.data);
    setMarkupExpenseRateBps(
      feesResult.data.reduce((total, fee) => total + fee.rate_bps, 0)
      + expensesResult.data.reduce((total, expense) => total + expense.rate_bps, 0)
    );
    setErrorMessage('');
    return true;
  }, []);

  useEffect(() => {
    void loadInvoices().catch(() => {
      setErrorMessage('Não foi possível carregar o módulo de notas. Verifique a conexão.');
    }).finally(() => setIsLoading(false));
  }, [loadInvoices]);

  function updateLine(key: number, update: Partial<InvoiceLine>) {
    setLines(current => current.map(line => line.key === key ? { ...line, ...update } : line));
  }

  async function handleImportXml(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setErrorMessage('');
    setStatusMessage('');
    try {
      if (file.size > 5 * 1024 * 1024) {
        throw new Error('O XML excede o limite de 5 MB.');
      }
      const imported = parseInvoiceXml(await file.text(), products);
      if (imported.supplierName.length > 160 || imported.invoiceNumber.length > 80
        || imported.issueDate > getLocalDateInputValue()) {
        throw new Error('Fornecedor, número ou data de emissão não são válidos para este cadastro.');
      }
      setApplySuggestedPrices(false);
      setTargetProfitInput('0,00');
      setXmlPreview(imported);
    } catch (error) {
      setErrorMessage(error instanceof Error
        ? error.message
        : 'Não foi possível ler o XML. Verifique o arquivo e tente novamente.');
    } finally {
      input.value = '';
    }
  }

  function continueWithXmlPreview() {
    if (!xmlPreview) return;
    if (applySuggestedPrices) {
      const targetProfitBps = parseRateBasisPoints(targetProfitInput);
      if (targetProfitBps === null
        || xmlPreview.lines.some(line => line.productId && !calculateMarkupPrice(
          parseMoneyCents(line.unitCost) ?? 0,
          markupExpenseRateBps,
          0,
          targetProfitBps
        ))) {
        setErrorMessage('A meta de lucro ou as taxas não permitem formar todos os preços. Revise as Configurações e a porcentagem informada.');
        return;
      }
    }
    setSupplierNameInput(xmlPreview.supplierName);
    setInvoiceNumberInput(xmlPreview.invoiceNumber);
    setIssueDateInput(xmlPreview.issueDate);
    setLines(xmlPreview.lines);
    const unmatched = xmlPreview.lines.filter(line => !line.productId).length;
    setStatusMessage(unmatched
      ? `Prévia confirmada. Associe ${unmatched} ${unmatched === 1 ? 'produto' : 'produtos'} não encontrados e revise os itens antes de registrar.`
      : 'Prévia confirmada. Revise os dados e confirme para registrar a entrada no estoque.');
    setXmlPreview(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage('');
    setStatusMessage('');
    const supplierName = supplierNameInput.trim();
    const invoiceNumber = invoiceNumberInput.trim();
    const issueDate = issueDateInput;
    if (!supplierName || supplierName.length > 160 || !invoiceNumber || invoiceNumber.length > 80
      || !issueDate || issueDate > getLocalDateInputValue() || lines.length > 200) {
      setErrorMessage('Informe fornecedor, número e data válida da nota.');
      return;
    }

    const parsedLines = lines.map(line => {
      const quantity = parseQuantity(line.quantity);
      const unitCostCents = parseMoneyCents(line.unitCost);
      const product = products.find(item => item.id === line.productId);
      return product && quantity !== null && unitCostCents !== null
        ? { product_id: product.id, quantity, unit_cost_cents: unitCostCents, expiration_date: line.expirationDate || null }
        : null;
    });
    if (parsedLines.length === 0 || parsedLines.some(line => line === null)) {
      setErrorMessage('Cada item precisa ter um produto, quantidade e custo unitário válidos.');
      return;
    }
    const validLines = parsedLines.filter((line): line is NonNullable<typeof line> => line !== null);
    const targetProfitBps = parseRateBasisPoints(targetProfitInput);
    if (targetProfitBps === null) {
      setErrorMessage('Informe uma meta de lucro entre 0% e 100%.');
      return;
    }

    setIsSaving(true);
    try {
      const { data, error } = await createClient().rpc('record_purchase_invoice_with_markup', {
        p_supplier_name: supplierName,
        p_invoice_number: invoiceNumber,
        p_issue_date: issueDate,
        p_lines: validLines,
        p_apply_suggested_prices: applySuggestedPrices,
        p_target_profit_bps: targetProfitBps
      });
      if (error) {
        console.error('Purchase invoice save failed:', error.code);
        setErrorMessage(operationMessage(error.code));
        return;
      }
      setLines([{ key: Date.now(), productId: '', quantity: '', unitCost: '', expirationDate: '' }]);
      setSupplierNameInput('');
      setInvoiceNumberInput('');
      setIssueDateInput(getLocalDateInputValue());
      setApplySuggestedPrices(false);
      if (await loadInvoices()) setStatusMessage(`Nota ${invoiceNumber} registrada e estoque atualizado.`);
      else setStatusMessage(`Nota registrada (referência ${data}); atualize a lista para conferir.`);
    } catch {
      setErrorMessage('Não foi possível registrar a nota. Verifique a conexão e tente novamente.');
    } finally {
      setIsSaving(false);
    }
  }

  async function exportInvoice(invoice: Invoice) {
    setDownloadingInvoiceId(invoice.id);
    setErrorMessage('');
    try {
      const { data, error } = await createClient().from('purchase_invoice_items')
        .select('*').eq('invoice_id', invoice.id).order('created_at');
      if (error) {
        setErrorMessage(operationMessage(error.code));
        return;
      }
      if (!data || data.length === 0) {
        setErrorMessage('A nota não possui itens para exportar.');
        return;
      }
      const itemsXml = data.map((item: InvoiceItem) => `    <item>
      <productId>${xmlEscape(item.product_id)}</productId>
      <productCode>${xmlEscape(item.product_code)}</productCode>
      <productName>${xmlEscape(item.product_name)}</productName>
      <quantity>${item.quantity}</quantity>
      <unitCostCents>${item.unit_cost_cents}</unitCostCents>
      <lineTotalCents>${item.line_total_cents}</lineTotalCents>
      <expirationDate>${xmlEscape(item.expiration_date ?? '')}</expirationDate>
    </item>`).join('\n');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<aacPurchaseInvoice schemaVersion="1.0" fiscalDocument="false">
  <invoice>
    <id>${xmlEscape(invoice.id)}</id>
    <supplier>${xmlEscape(invoice.supplier_name)}</supplier>
    <invoiceNumber>${xmlEscape(invoice.invoice_number)}</invoiceNumber>
    <issueDate>${xmlEscape(invoice.issue_date)}</issueDate>
    <totalCents>${invoice.total_cents}</totalCents>
    <currency>BRL</currency>
    <items>
${itemsXml}
    </items>
  </invoice>
</aacPurchaseInvoice>`;
      const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${safeFilePart(invoice.invoice_number)}_${safeFilePart(invoice.supplier_name)}.xml`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatusMessage('XML de dados exportado. Este arquivo não é um documento fiscal autorizado.');
    } catch {
      setErrorMessage('Não foi possível gerar o XML desta nota.');
    } finally {
      setDownloadingInvoiceId(null);
    }
  }

  if (isLoading) return <p className="catalog-state" role="status">Carregando notas…</p>;
  if (!canManage) return (
    <section className="setup-notice">
      <h2>Acesso restrito</h2>
      <p>As notas de entrada estão disponíveis apenas para administradores e gerentes.</p>
    </section>
  );

  const draftTotalCents = lines.reduce((total, line) => {
    const quantity = parseQuantity(line.quantity);
    const cost = parseMoneyCents(line.unitCost);
    return total + (quantity !== null && cost !== null ? Math.round(quantity * cost) : 0);
  }, 0);
  const today = getLocalDateInputValue();
  const previewProfitBps = parseRateBasisPoints(targetProfitInput);

  return (
    <section className="invoice-layout" aria-label="Entrada de notas de compra">
      {xmlPreview ? (
        <section className="catalog-form invoice-preview" aria-labelledby="xmlPreviewTitle">
          <div className="invoice-title-row">
            <div><p className="eyebrow">REVISÃO ANTES DA IMPORTAÇÃO</p><h2 id="xmlPreviewTitle">Prévia da nota XML</h2></div>
            <span className="invoice-preview-count">{xmlPreview.lines.length} {xmlPreview.lines.length === 1 ? 'item' : 'itens'}</span>
          </div>
          <dl className="invoice-supplier-preview">
            <div><dt>Empresa fornecedora</dt><dd>{xmlPreview.supplierName}</dd></div>
            <div><dt>Número da nota</dt><dd>{xmlPreview.invoiceNumber}</dd></div>
            <div><dt>Data de emissão</dt><dd>{new Date(`${xmlPreview.issueDate}T00:00:00`).toLocaleDateString('pt-BR')}</dd></div>
            <div><dt>Telefone</dt><dd>{xmlPreview.supplierPhone || 'Não informado no XML'}</dd></div>
            <div className="invoice-address-preview"><dt>Endereço</dt><dd>{xmlPreview.supplierAddress || 'Não informado no XML'}</dd></div>
          </dl>
          <div className="catalog-table-wrap invoice-preview-table">
            <table className="catalog-table">
              <thead><tr><th>Produto no XML</th><th>Qtd.</th><th>Unidade</th><th>Compra unit.</th><th>Total do item</th><th>Tributação declarada</th><th>Produto no A.A.C.</th><th>Preço markup sugerido</th></tr></thead>
              <tbody>
                {xmlPreview.lines.map(line => {
                  const quantity = parseQuantity(line.quantity);
                  const costCents = parseMoneyCents(line.unitCost);
                  const markupCostCents = line.productId
                    ? getWeightedImportCostCents(xmlPreview.lines, line.productId)
                    : null;
                  const price = markupCostCents !== null && previewProfitBps !== null
                    ? calculateMarkupPrice(markupCostCents, markupExpenseRateBps, 0, previewProfitBps)
                    : null;
                  return (
                    <tr key={line.key}>
                      <td data-label="Produto no XML">{line.previewName ?? `Item ${line.key + 1}`}<small className="invoice-preview-code">{line.previewCode}</small></td>
                      <td data-label="Quantidade">{line.quantity}</td>
                      <td data-label="Unidade">{line.previewUnit || '—'}</td>
                      <td data-label="Compra unit.">{costCents === null ? '—' : formatMoney(costCents)}</td>
                      <td data-label="Total do item">{quantity === null || costCents === null ? '—' : formatMoney(Math.round(quantity * costCents))}</td>
                      <td data-label="Tributação">{line.taxSummary ?? 'Não informada'}</td>
                      <td data-label="Produto no A.A.C.">{products.find(product => product.id === line.productId)?.name ?? 'Associar manualmente'}</td>
                      <td data-label="Preço markup sugerido">{price ? formatMoney(price.priceCents) : line.productId ? 'Taxas ou lucro inválidos' : 'Associe o produto'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="invoice-preview-summary">
            <strong>Total estimado dos itens: {formatMoney(xmlPreview.lines.reduce((total, line) => {
              const quantity = parseQuantity(line.quantity);
              const cost = parseMoneyCents(line.unitCost);
              return total + (quantity !== null && cost !== null ? Math.round(quantity * cost) : 0);
            }, 0))}</strong>
            <p>Tributos e dados da empresa são exibidos conforme constam no arquivo. A prévia não valida autorização fiscal da NF-e.</p>
          </div>
          <fieldset className="invoice-markup-choice">
            <legend>Deseja aplicar os preços sugeridos pelo markup ao registrar esta nota?</legend>
            <label><input type="radio" name="applyMarkup" checked={applySuggestedPrices} onChange={() => setApplySuggestedPrices(true)} /> Sim, atualizar preço e custo dos produtos associados</label>
            <label><input type="radio" name="applyMarkup" checked={!applySuggestedPrices} onChange={() => setApplySuggestedPrices(false)} /> Não, manter os preços atuais</label>
            {applySuggestedPrices && (
              <label className="invoice-profit-target">Lucro desejado para os preços sugeridos (%)
                <input value={targetProfitInput} onChange={event => setTargetProfitInput(event.target.value)} inputMode="decimal" placeholder="0,00" />
              </label>
            )}
            <p>Os preços usam as despesas variáveis e fixas ativas nas Configurações e o custo médio ponderado quando o produto aparece em mais de uma linha. O preço mínimo utiliza 0% de lucro; informe sua margem acima se desejar.</p>
          </fieldset>
          <div className="invoice-preview-actions">
            <button className="button button-secondary" type="button" onClick={() => setXmlPreview(null)}>Descartar prévia</button>
            <button className="button button-primary" type="button" onClick={continueWithXmlPreview}>Usar dados e revisar nota</button>
          </div>
        </section>
      ) : (
      <form className="catalog-form invoice-form" onSubmit={handleSubmit}>
        <div className="invoice-title-row">
          <h2>Registrar nota de entrada</h2>
          <label className="button button-secondary invoice-import-button">
            Importar XML
            <input
              type="file"
              accept=".xml,application/xml,text/xml"
              onChange={handleImportXml}
              disabled={isSaving}
              aria-label="Importar nota em arquivo XML"
            />
          </label>
        </div>
        <p>O registro atualiza o estoque em uma única operação e cria um lote por item. A importação preenche os dados para revisão; ela não valida assinatura fiscal nem transmite a NF-e. Confira vínculos e custos antes de confirmar.</p>
        {applySuggestedPrices && <p className="invoice-markup-confirmation">Markup ativado: os custos da nota e os preços recalculados serão salvos junto com a entrada, usando lucro desejado de {targetProfitInput}%.</p>}
        <div className="catalog-form-grid invoice-header-fields">
          <label>Fornecedor<input name="supplier" value={supplierNameInput} onChange={event => setSupplierNameInput(event.target.value)} required maxLength={160} autoComplete="organization" /></label>
          <label>Número da nota<input name="invoiceNumber" value={invoiceNumberInput} onChange={event => setInvoiceNumberInput(event.target.value)} required maxLength={80} autoComplete="off" /></label>
          <label>Data de emissão<input name="issueDate" type="date" value={issueDateInput} onChange={event => setIssueDateInput(event.target.value)} required max={today} /></label>
        </div>

        <div className="invoice-lines-header">
          <h3>Itens da nota</h3>
          <button className="button button-secondary" type="button" onClick={() => setLines(current => [
            ...current,
            { key: current.reduce((max, line) => Math.max(max, line.key), 0) + 1, productId: '', quantity: '', unitCost: '', expirationDate: '' }
          ])} disabled={lines.length >= 200}>Adicionar item</button>
        </div>
        <div className="invoice-lines">
          {lines.map((line, index) => {
            const product = products.find(item => item.id === line.productId);
            return (
              <fieldset className="invoice-line" key={line.key}>
                <legend>Item {index + 1}</legend>
                <label>Produto
                  <select value={line.productId} onChange={event => updateLine(line.key, { productId: event.target.value })} required>
                    <option value="">Selecione um produto</option>
                    {products.map(item => <option key={item.id} value={item.id}>{item.product_code} · {item.name}</option>)}
                  </select>
                </label>
                <label>Quantidade ({product?.unit ?? 'un.'})
                  <input value={line.quantity} onChange={event => updateLine(line.key, { quantity: event.target.value })} inputMode="decimal" placeholder="0,000" required />
                </label>
                <label>Custo unitário (R$)
                  <input value={line.unitCost} onChange={event => updateLine(line.key, { unitCost: event.target.value })} inputMode="decimal" placeholder="0,00" required />
                </label>
                <label>Validade do lote (opcional)
                  <input type="date" value={line.expirationDate} onChange={event => updateLine(line.key, { expirationDate: event.target.value })} />
                </label>
                <button className="button button-secondary invoice-remove-line" type="button" onClick={() => setLines(current => current.length > 1 ? current.filter(item => item.key !== line.key) : current)} disabled={lines.length === 1}>Remover item</button>
              </fieldset>
            );
          })}
        </div>
        <div className="invoice-submit-row">
          <strong>Total calculado: {formatMoney(draftTotalCents)}</strong>
          <button className="button button-primary" type="submit" disabled={isSaving || products.length === 0}>
            {isSaving ? 'Registrando nota…' : 'Registrar nota e atualizar estoque'}
          </button>
        </div>
      </form>
      )}

      <section className="catalog-form invoice-history" aria-labelledby="invoiceHistoryTitle">
        <h2 id="invoiceHistoryTitle">Notas registradas</h2>
        <p>Últimas 50 notas incluídas neste sistema. A exportação XML contém dados operacionais, não fiscais.</p>
        {invoices.length ? (
          <div className="catalog-table-wrap">
            <table className="catalog-table">
              <thead><tr><th>Nota</th><th>Fornecedor</th><th>Emissão</th><th>Total</th><th>XML</th></tr></thead>
              <tbody>
                {invoices.map(invoice => (
                  <tr key={invoice.id}>
                    <td data-label="Nota">{invoice.invoice_number}</td>
                    <td data-label="Fornecedor">{invoice.supplier_name}</td>
                    <td data-label="Emissão">{new Date(`${invoice.issue_date}T00:00:00`).toLocaleDateString('pt-BR')}</td>
                    <td data-label="Total">{formatMoney(invoice.total_cents)}</td>
                    <td data-label="XML">
                      <button className="button button-secondary" type="button" onClick={() => void exportInvoice(invoice)} disabled={downloadingInvoiceId !== null}>
                        {downloadingInvoiceId === invoice.id ? 'Gerando…' : 'Exportar XML'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="catalog-empty"><h2>Nenhuma nota registrada</h2><p>As notas de entrada concluídas aparecerão aqui.</p></div>
        )}
      </section>
      {errorMessage && <p className="pricing-message pricing-message-error" role="alert">{errorMessage}</p>}
      {statusMessage && <p className="pricing-message" role="status">{statusMessage}</p>}
    </section>
  );
}
