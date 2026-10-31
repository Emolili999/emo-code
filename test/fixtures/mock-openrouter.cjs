// Test-process-only OpenRouter fixture. This module is injected into the Electron
// main process by the UI smoke test; normal app launches never load this file.
if (process.env.EMOCODE_MOCK_OPENROUTER === '1') {
  const realFetch = global.fetch;
  global.fetch = async (input, init) => {
    const url = String(input?.url || input);
    if (url === 'https://openrouter.ai/api/v1/models') {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      let requestBody = {};
      try { requestBody = JSON.parse(init?.body || '{}'); } catch { /* test fixture */ }
      const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
      const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
      const prompt = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';

      if (prompt.includes('Harness hata akışı')) {
        return new Response(JSON.stringify({ error: { message: 'Harness test 401' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        });
      }

      if (prompt.includes('Harness durdurma akışı')) {
        const encoder = new TextEncoder();
        let timer;
        let streamController;
        const signal = init?.signal;
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          try { streamController?.close(); } catch { /* akış kapanmış olabilir */ }
        };
        return new Response(new ReadableStream({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Harness kısmi yanıtı' }, finish_reason: null }] })}\n\n`));
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            else {
              timer = setTimeout(() => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
                signal?.removeEventListener('abort', abort);
              }, 15000);
            }
          },
          cancel() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
          }
        }), { headers: { 'content-type': 'text/event-stream' } });
      }

      const chunks = [
        { choices: [{ delta: { content: 'Harness yanıtı' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0 } }
      ];
      const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    }
    return realFetch(input, init);
  };
}
