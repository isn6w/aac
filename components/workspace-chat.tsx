'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

type Message = { role: 'user' | 'assistant'; content: string };

const suggestions = [
  'Como priorizar contas a pagar?',
  'Monte uma rotina semanal de conferência financeira.',
  'Quais cuidados ter ao registrar uma nota de compra?'
];

export default function WorkspaceChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const conversationRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [messages, isSending]);

  async function sendMessage(content = draft) {
    const question = content.trim();
    if (!question || isSending || question.length > 4000) return;
    const nextMessages: Message[] = [...messages, { role: 'user' as const, content: question }].slice(-12);
    setMessages(nextMessages);
    setDraft('');
    setErrorMessage('');
    setIsSending(true);

    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: nextMessages }),
        cache: 'no-store'
      });
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object') throw new Error('Resposta inválida do assistente.');
      const data = result as { reply?: unknown; error?: unknown };
      if (!response.ok) throw new Error(typeof data.error === 'string'
        ? data.error
        : 'Não foi possível obter uma resposta do Gemini.');
      if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('O assistente retornou uma resposta inválida.');
      setMessages([...nextMessages, { role: 'assistant', content: data.reply }]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Não foi possível enviar a mensagem.');
      setMessages(current => current.slice(0, -1));
      setDraft(question);
    } finally {
      setIsSending(false);
      inputRef.current?.focus();
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (draft.trim()) void sendMessage();
    }
  }

  function clearConversation() {
    if (isSending) return;
    setMessages([]);
    setErrorMessage('');
    inputRef.current?.focus();
  }

  return (
    <section className="workspace-chat" aria-label="Chat do espaço de trabalho">
      <div className="chat-heading">
        <div><p className="eyebrow">GEMINI 3.8 FLASH</p><h2>Assistente A.A.C.</h2></div>
        <button className="button button-secondary" type="button" onClick={clearConversation} disabled={!messages.length || isSending}>Nova conversa</button>
      </div>

      <div className="chat-conversation" ref={conversationRef} aria-live="polite" aria-relevant="additions text">
        {messages.length === 0 ? (
          <div className="chat-empty-state">
            <span className="chat-mark" aria-hidden="true">A</span>
            <h3>Como posso ajudar?</h3>
            <p>Converse sobre organização comercial, rotinas financeiras e uso do A.A.C.</p>
            <div className="chat-suggestions">
              {suggestions.map(suggestion => <button key={suggestion} type="button" onClick={() => void sendMessage(suggestion)} disabled={isSending}>{suggestion}</button>)}
            </div>
          </div>
        ) : messages.map((message, index) => (
          <article className={`chat-message chat-message-${message.role}`} key={`${index}-${message.role}`}>
            <span>{message.role === 'user' ? 'Você' : 'A.A.C.'}</span>
            <p>{message.content}</p>
          </article>
        ))}
        {isSending && <p className="chat-loading" role="status">O assistente está respondendo…</p>}
      </div>

      {errorMessage && <p className="chat-error" role="alert">{errorMessage}</p>}
      <form className="chat-composer" onSubmit={handleSubmit}>
        <label htmlFor="assistantMessage">Mensagem</label>
        <textarea
          id="assistantMessage"
          ref={inputRef}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Escreva sua pergunta..."
          maxLength={4000}
          rows={3}
          disabled={isSending}
        />
        <div className="chat-composer-footer"><span>Enter envia · Shift+Enter quebra linha</span><button className="button button-primary" type="submit" disabled={isSending || !draft.trim()}>{isSending ? 'Enviando…' : 'Enviar'}</button></div>
      </form>
      <p className="chat-privacy-note">Mensagens são enviadas ao Gemini. Perguntas sobre estoque consultam o catálogo; perguntas sobre notas e financeiro consultam títulos sem enviar linha digitável. Não inclua senhas, chaves ou dados bancários completos. O chat não altera registros; confira respostas antes de agir.</p>
    </section>
  );
}