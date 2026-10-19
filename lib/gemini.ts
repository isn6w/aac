export type GeminiChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export class GeminiConfigurationError extends Error {}

export class GeminiRequestError extends Error {
  constructor(readonly kind: 'timeout' | 'network' | 'http' | 'response' | 'incomplete', readonly status = 0) {
    super('Gemini request failed');
  }
}

export async function generateGeminiReply(
  systemInstruction: string,
  messages: GeminiChatMessage[],
  maxTokens = 2048
) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new GeminiConfigurationError('Gemini API key is not configured.');

  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';
  let outputTokenLimit = maxTokens;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: messages.map(message => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }]
          })),
          generationConfig: { maxOutputTokens: outputTokenLimit }
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(45000)
      });
    } catch (error) {
      const timedOut = error instanceof DOMException
        && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new GeminiRequestError(timedOut ? 'timeout' : 'network');
    }
    if (!response.ok) throw new GeminiRequestError('http', response.status);

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new GeminiRequestError('response', 502);
    }
    if (!result || typeof result !== 'object' || !('candidates' in result)
      || !Array.isArray(result.candidates)) throw new GeminiRequestError('response', 502);

    const firstCandidate = result.candidates[0];
    const finishReason = firstCandidate && typeof firstCandidate === 'object' && 'finishReason' in firstCandidate
      ? firstCandidate.finishReason
      : null;
    const content = firstCandidate && typeof firstCandidate === 'object' && 'content' in firstCandidate
      ? firstCandidate.content
      : null;
    const parts: unknown[] = content && typeof content === 'object' && 'parts' in content
      && Array.isArray(content.parts) ? content.parts : [];
    const text = parts.flatMap(part => {
      if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string'
        || ('thought' in part && part.thought === true)) return [];
      return [part.text];
    }).join('').trim();
    if (!text) throw new GeminiRequestError('response', 502);
    if (finishReason !== 'MAX_TOKENS') return text;
    if (attempt === 2) throw new GeminiRequestError('incomplete', 0);
    outputTokenLimit *= 2;
  }

  throw new GeminiRequestError('incomplete', 0);
}