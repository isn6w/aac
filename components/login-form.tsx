'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

const supabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
);
const localPreview = process.env.NODE_ENV === 'development' && !supabaseConfigured;

export default function LoginForm() {
  const router = useRouter();
  const [showWelcome, setShowWelcome] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage('');
    setIsSubmitting(true);

    const formData = new FormData(event.currentTarget);
    const username = String(formData.get('username') || '').trim();
    const password = String(formData.get('password') || '');

    try {
      if (localPreview) {
        if (username !== 'admin' || password !== 'admin') {
          throw new Error('Na pré-visualização local, use admin/admin.');
        }
        sessionStorage.setItem('aac-local-preview', 'true');
        router.push('/dashboard/sales');
        return;
      }

      if (!supabaseConfigured) {
        throw new Error('Configure NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.');
      }

      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({ email: username, password });
      if (error) throw new Error('Não foi possível autenticar. Verifique o e-mail e a senha.');

      router.push('/dashboard/sales');
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Não foi possível entrar.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (showWelcome) {
    return (
      <main className="landing-view">
        <header className="landing-header">
          <a className="brand" href="/" aria-label="A.A.C. início">
            <span className="brand-mark" aria-hidden="true">A</span><span className="brand-name">A.A.C.</span>
          </a>
          <span>ASSISTENTE DE ADMINISTRAÇÃO COMERCIAL</span>
        </header>
        <section className="landing-content" aria-labelledby="landingTitle">
          <p className="eyebrow">GESTÃO COMERCIAL</p>
          <h1 id="landingTitle">Bem-vindo ao A.A.C.</h1>
          <p>Uma central de trabalho para organizar vendas, produtos e a operação do seu negócio.</p>
          <button className="button button-primary" type="button" onClick={() => setShowWelcome(false)}>Logar</button>
        </section>
        <footer className="landing-footer">A.A.C. <span aria-hidden="true">·</span> Gestão comercial</footer>
      </main>
    );
  }

  return (
    <main className="login-view">
      <section className="login-panel" aria-labelledby="loginTitle">
        <a className="brand brand-login" href="/" aria-label="A.A.C. início">
          <span className="brand-mark" aria-hidden="true">A</span>
          <span className="brand-name">A.A.C.</span>
        </a>
        <p className="eyebrow">ASSISTENTE DE ADMINISTRAÇÃO COMERCIAL</p>
        <h1 id="loginTitle">Acesse sua conta</h1>
        <p className="intro">Entre para continuar no seu espaço de trabalho.</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <label htmlFor="loginUser">{localPreview ? 'Usuário' : 'E-mail'}</label>
          <input
            id="loginUser"
            name="username"
            type="text"
            autoComplete="username"
            required
            autoFocus
          />
          <label htmlFor="loginPassword">Senha</label>
          <input
            id="loginPassword"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          {errorMessage && <p className="form-message" role="alert">{errorMessage}</p>}
          <button className="button button-primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
        <p className="login-footnote">
          {localPreview ? 'Pré-visualização local · sem dados comerciais' : 'Autenticação segura via Supabase.'}
        </p>
        {!localPreview && !supabaseConfigured && (
          <p className="form-message" role="status">A autenticação Supabase ainda não está configurada.</p>
        )}
      </section>
      <footer className="login-footer">A.A.C. <span aria-hidden="true">·</span> Gestão comercial</footer>
    </main>
  );
}
