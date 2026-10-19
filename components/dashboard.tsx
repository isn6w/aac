'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import ProductCatalog from '@/components/product-catalog';
import PriceCalculator from '@/components/price-calculator';
import PricingSettings from '@/components/pricing-settings';
import PurchaseInvoices from '@/components/purchase-invoices';
import PointOfSale from '@/components/point-of-sale';
import FinanceAssistant from '@/components/finance-assistant';
import WorkspaceChat from '@/components/workspace-chat';

const supabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
);
const localPreview = process.env.NODE_ENV === 'development' && !supabaseConfigured;

const modules = [
  ['00', 'Vendas', 'PDV, leitura de códigos, descontos e recebimentos.'],
  ['01', 'Produtos e estoque', 'Cadastros, códigos de barras e movimentações.'],
  ['02', 'Calculadora de preços', 'Custos, margens e formação de preços.'],
  ['03', 'Clientes', 'Cadastro e relacionamento com clientes.'],
  ['04', 'Vendedores', 'Cadastro e organização da equipe comercial.'],
  ['05', 'Financeiro', 'Contas a pagar, boletos e vencimentos.'],
  ['06', 'Informação tributária', 'Conteúdo orientativo e ferramentas de consulta.'],
  ['07', 'Gráficos e relatórios', 'Indicadores calculados a partir de dados reais.'],
  ['08', 'Integrações', 'Conexões com serviços definidos para o negócio.'],
  ['09', 'Entrada de notas', 'Registre compras, atualize lotes e exporte dados XML.']
];

export default function Dashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const isProductsPage = pathname === '/dashboard/products';
  const isPricingPage = pathname === '/dashboard/pricing';
  const isSettingsPage = pathname === '/dashboard/settings';
  const isInvoicesPage = pathname === '/dashboard/invoices';
  const isFinancePage = pathname === '/dashboard/finance';
  const isAssistantPage = pathname === '/dashboard/assistant';
  const isSalesPage = pathname === '/dashboard/sales';
  const [isReady, setIsReady] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [hasUnlockedWorkspace, setHasUnlockedWorkspace] = useState(false);
  const [currentTime, setCurrentTime] = useState<Date | null>(null);
  const [clientIp, setClientIp] = useState('Consultando...');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSigningOut, setIsSigningOut] = useState(false);

  useEffect(() => {
    setSidebarCollapsed(window.localStorage.getItem('aac-sidebar-collapsed') === 'true');
    setHasUnlockedWorkspace(window.sessionStorage.getItem('aac-workspace-unlocked') === 'true');
  }, []);

  useEffect(() => {
    const updateTime = () => setCurrentTime(new Date());
    updateTime();
    const interval = window.setInterval(updateTime, 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/client-info', { cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('IP indisponível');
        const result: unknown = await response.json();
        if (!result || typeof result !== 'object' || !('ip' in result)
          || typeof result.ip !== 'string') throw new Error('IP indisponível');
        if (!cancelled) setClientIp(result.ip);
      })
      .catch(() => {
        if (!cancelled) setClientIp('Indisponível');
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isSalesPage) return;
    function handleWorkspaceShortcut(event: globalThis.KeyboardEvent) {
      if (event.key !== 'F2' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      const unlocked = window.sessionStorage.getItem('aac-workspace-unlocked') === 'true';
      if (!unlocked && !window.confirm('Deseja realmente desbloquear o acesso ao espaço de trabalho e às demais ferramentas?')) return;
      window.sessionStorage.setItem('aac-workspace-unlocked', 'true');
      setHasUnlockedWorkspace(true);
      router.push('/dashboard');
    }
    window.addEventListener('keydown', handleWorkspaceShortcut);
    return () => window.removeEventListener('keydown', handleWorkspaceShortcut);
  }, [isSalesPage, router]);

  useEffect(() => {
    let cancelled = false;

    async function verifyAccess() {
      if (localPreview) {
        if (sessionStorage.getItem('aac-local-preview') === 'true') {
          setIsReady(true);
        } else {
          router.replace('/');
        }
        return;
      }

      try {
        const { data, error } = await createClient().auth.getClaims();
        if (error) throw new Error('Não foi possível verificar sua sessão.');
        if (!data?.claims?.sub) {
          router.replace('/');
        } else if (!cancelled) {
          setIsReady(true);
        }
      } catch {
        if (!cancelled) {
          setErrorMessage('Não foi possível verificar sua sessão. Entre novamente.');
          router.replace('/');
        }
      }
    }

    void verifyAccess();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSignOut() {
    setIsSigningOut(true);
    setErrorMessage('');
    try {
      if (localPreview) {
        sessionStorage.removeItem('aac-local-preview');
      } else {
        const { error } = await createClient().auth.signOut();
        if (error) throw new Error('Não foi possível encerrar a sessão.');
      }
      sessionStorage.removeItem('aac-workspace-unlocked');
      router.replace('/');
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Não foi possível sair.');
      setIsSigningOut(false);
    }
  }

  function toggleSidebar() {
    setSidebarCollapsed(current => {
      window.localStorage.setItem('aac-sidebar-collapsed', String(!current));
      return !current;
    });
  }

  if (!isReady) return null;

  return (
    <div className={`workspace${sidebarCollapsed ? ' workspace-sidebar-collapsed' : ''}${isSalesPage ? ' workspace-sales-mode' : ''}`}>
      {!isSalesPage && <aside className="sidebar" aria-label="Menu principal">
        <div className="sidebar-brand-row">
          <a className="brand" href="/" aria-label="A.A.C. início">
            <span className="brand-mark" aria-hidden="true">A</span>
            <span className="brand-name">A.A.C.</span>
          </a>
          <button
            className="sidebar-toggle"
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Expandir menu lateral' : 'Minimizar menu lateral'}
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? 'Expandir menu lateral' : 'Minimizar menu lateral'}
          >
            <span aria-hidden="true">{sidebarCollapsed ? '»' : '«'}</span>
          </button>
        </div>
        <p className="sidebar-caption">ASSISTENTE DE ADMINISTRAÇÃO COMERCIAL</p>

        <nav className="main-nav" aria-label="Módulos">
          <span className="nav-heading">ESPAÇO DE TRABALHO</span>
          <Link className={`nav-item${!isProductsPage && !isPricingPage && !isSettingsPage && !isInvoicesPage && !isSalesPage && !isFinancePage && !isAssistantPage ? ' nav-item-active' : ''}`} href="/dashboard" aria-current={!isProductsPage && !isPricingPage && !isSettingsPage && !isInvoicesPage && !isSalesPage && !isFinancePage && !isAssistantPage ? 'page' : undefined} title="Visão geral" aria-label="Visão geral"><span className="nav-label">Visão geral</span><span className="nav-icon" aria-hidden="true">⌂</span></Link>
          <span className="nav-heading nav-heading-spaced">MÓDULOS</span>
          <Link className={`nav-item${isSalesPage ? ' nav-item-active' : ''}`} href="/dashboard/sales" aria-current={isSalesPage ? 'page' : undefined} title="Vendas" aria-label="Vendas"><span className="nav-label">Vendas</span><span className="nav-icon" aria-hidden="true">▣</span></Link>
          <Link className={`nav-item${isProductsPage ? ' nav-item-active' : ''}`} href="/dashboard/products" aria-current={isProductsPage ? 'page' : undefined} title="Produtos e estoque" aria-label="Produtos e estoque"><span className="nav-label">Produtos e estoque</span><span className="nav-icon" aria-hidden="true">▦</span></Link>
          <Link className={`nav-item${isPricingPage ? ' nav-item-active' : ''}`} href="/dashboard/pricing" aria-current={isPricingPage ? 'page' : undefined} title="Calculadora de preços" aria-label="Calculadora de preços"><span className="nav-label">Calculadora de preços</span><span className="nav-icon" aria-hidden="true">◈</span></Link>
          <Link className={`nav-item${isSettingsPage ? ' nav-item-active' : ''}`} href="/dashboard/settings" aria-current={isSettingsPage ? 'page' : undefined} title="Configurações" aria-label="Configurações"><span className="nav-label">Configurações</span><span className="nav-icon" aria-hidden="true">⚙</span></Link>
          <Link className={`nav-item${isInvoicesPage ? ' nav-item-active' : ''}`} href="/dashboard/invoices" aria-current={isInvoicesPage ? 'page' : undefined} title="Entrada de notas" aria-label="Entrada de notas"><span className="nav-label">Entrada de notas</span><span className="nav-icon" aria-hidden="true">▤</span></Link>
          <Link className={`nav-item${isFinancePage ? ' nav-item-active' : ''}`} href="/dashboard/finance" aria-current={isFinancePage ? 'page' : undefined} title="Financeiro" aria-label="Financeiro"><span className="nav-label">Financeiro</span><span className="nav-icon" aria-hidden="true">＄</span></Link>
          <Link className={`nav-item${isAssistantPage ? ' nav-item-active' : ''}`} href="/dashboard/assistant" aria-current={isAssistantPage ? 'page' : undefined} title="Assistente IA" aria-label="Assistente IA"><span className="nav-label">Assistente IA</span><span className="nav-icon" aria-hidden="true">✳</span></Link>
          {modules.slice(3, 5).map(([, name], index) => (
            <button className="nav-item" type="button" disabled key={name} title={name} aria-label={`${name}, planejado`}>
              <span className="nav-label">{name} <span className="nav-planned">Planejado</span></span><span className="nav-icon" aria-hidden="true">{['♙', '▱', 'ⓘ'][index]}</span>
            </button>
          ))}
          {modules.slice(6, 9).map(([, name], index) => (
            <button className="nav-item" type="button" disabled key={name} title={name} aria-label={`${name}, planejado`}>
              <span className="nav-label">{name} <span className="nav-planned">Planejado</span></span><span className="nav-icon" aria-hidden="true">{['▥', '⇄', '▧'][index]}</span>
            </button>
          ))}
        </nav>
        <p className="sidebar-note">Nova base <span>·</span> módulos em preparação</p>
      </aside>}

      <div className="workspace-main">
        <header className="topbar">
          {isSalesPage ? (
            <div className="sales-status-bar" aria-label="Informações do terminal">
              <a className="brand" href="/dashboard/sales" aria-label="A.A.C. vendas">
                <span className="brand-mark" aria-hidden="true">A</span><span className="brand-name">A.A.C.</span>
              </a>
              <div><span className="topbar-label">DATA E HORA</span><strong>{currentTime?.toLocaleString('pt-BR') ?? 'Carregando...'}</strong></div>
              <div><span className="topbar-label">IP DA CONEXÃO</span><strong>{clientIp}</strong></div>
              <p className="sales-shortcut-hint"><kbd>F2</kbd> {hasUnlockedWorkspace ? 'Abrir espaço de trabalho' : 'Desbloquear ferramentas'}</p>
            </div>
          ) : (
            <div>
              <span className="topbar-label">CONTA</span>
              <strong>{localPreview ? 'Administrador local' : 'Conta Supabase'}</strong>
            </div>
          )}
          <button className="button button-secondary" type="button" onClick={handleSignOut} disabled={isSigningOut}>
            {isSigningOut ? 'Saindo…' : 'Sair'}
          </button>
        </header>

        <main className="content">
          {isSalesPage ? (
            <section className="sales-screen" aria-label="Ponto de venda">
              <div className="sales-screen-heading"><div><p className="eyebrow">TERMINAL DE VENDAS</p><h1>Frente de caixa</h1></div><span>Operação ativa</span></div>
              <PointOfSale />
            </section>
          ) : isPricingPage ? (
            <>
              <div className="page-heading">
                <p className="eyebrow">FORMAÇÃO DE PREÇO</p>
                <h1>Calculadora de preços</h1>
                <p>Calcule e salve preços pelo método markup divisor.</p>
              </div>
              <PriceCalculator />
            </>
          ) : isInvoicesPage ? (
            <>
              <div className="page-heading">
                <p className="eyebrow">COMPRAS E RECEBIMENTO</p>
                <h1>Entrada de notas</h1>
                <p>Registre compras, lotes e validades e exporte os dados em XML.</p>
              </div>
              <PurchaseInvoices />
            </>
          ) : isAssistantPage ? (
            <>
              <div className="page-heading">
                <p className="eyebrow">ESPAÇO DE TRABALHO</p>
                <h1>Assistente IA</h1>
                <p>Converse com o Gemini para apoiar sua rotina de administração comercial.</p>
              </div>
              <WorkspaceChat />
            </>
          ) : isFinancePage ? (
            <>
              <div className="page-heading">
                <p className="eyebrow">CONTAS A PAGAR</p>
                <h1>Financeiro</h1>
                <p>Acompanhe boletos das notas, impostos declarados e próximos vencimentos.</p>
              </div>
              <FinanceAssistant />
            </>
          ) : isSettingsPage ? (
            <>
              <div className="page-heading">
                <p className="eyebrow">PREFERÊNCIAS DO SISTEMA</p>
                <h1>Configurações</h1>
                <p>Personalize taxas e custos fixos usados na calculadora de preços.</p>
              </div>
              <PricingSettings />
            </>
          ) : isProductsPage ? (
            <>
              <div className="page-heading">
                <p className="eyebrow">CATÁLOGO</p>
                <h1>Produtos e estoque</h1>
                <p>Cadastre itens, códigos de barras e acompanhe movimentações.</p>
              </div>
              <ProductCatalog />
            </>
          ) : (
            <>
              <div className="page-heading">
                <p className="eyebrow">ESPAÇO DE TRABALHO</p>
                <h1>Visão geral</h1>
                <p>Uma base simples para organizar a gestão do seu negócio.</p>
              </div>

              <section className="welcome-card" aria-labelledby="welcomeTitle">
                <p className="eyebrow">BEM-VINDO AO A.A.C.</p>
                <h2 id="welcomeTitle">Vamos começar do zero.</h2>
                <p>Os fluxos comerciais anteriores estão desativados. Os novos módulos serão habilitados gradualmente, com dados e cadastros próprios para o seu negócio.</p>
              </section>

              <section className="modules-section" aria-labelledby="modulesTitle">
                <div className="section-heading">
                  <div>
                    <h2 id="modulesTitle">Planejamento dos módulos</h2>
                    <p>Uma visão do que será construído para a sua operação.</p>
                  </div>
                </div>
                <div className="module-grid">
                  {modules.map(([index, name, description]) => (
                    <article className="module-card" key={index}>
                      <span className="module-index">{index}</span>
                      <h3>{name}</h3>
                      <p>{description}</p>
                      <span className="module-state">
                        {index === '01' ? 'Em preparação' : index === '02' || index === '05' || index === '09' ? 'Disponível' : 'Planejado'}
                      </span>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}
          {errorMessage && <p className="workspace-message" role="alert">{errorMessage}</p>}
        </main>
      </div>
    </div>
  );
}
