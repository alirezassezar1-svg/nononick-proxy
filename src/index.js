/* ============================================================
   NONONICK UNIVERSAL AI PROXY
   یک Worker برای همه Providerها
   ============================================================ */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, x-goog-api-key',
  'Access-Control-Max-Age': '86400',
};

/* ------------------------------------------------------------
   1. تعریف Providerها
   ------------------------------------------------------------ */
const PROVIDERS = {
  openai: {
    match: [/api\.openai\.com/],
    secretKey: 'OPENAI_API_KEY',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    format: 'openai',
  },
  anthropic: {
    match: [/api\.anthropic\.com/],
    secretKey: 'ANTHROPIC_API_KEY',
    authHeader: (key) => ({
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    format: 'anthropic',
  },
  huggingface: {
    match: [/router\.huggingface\.co/, /api-inference\.huggingface\.co/],
    secretKey: 'HF_TOKEN',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    format: 'openai',
  },
  google: {
    match: [/generativelanguage\.googleapis\.com/],
    secretKey: 'GOOGLE_API_KEY',
    authHeader: (key) => ({ 'x-goog-api-key': key }),
    format: 'google',
  },
  groq: {
    match: [/api\.groq\.com/],
    secretKey: 'GROQ_API_KEY',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    format: 'openai',
  },
  openrouter: {
    match: [/openrouter\.ai/],
    secretKey: 'OPENROUTER_API_KEY',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    format: 'openai',
  },
  mistral: {
    match: [/api\.mistral\.ai/],
    secretKey: 'MISTRAL_API_KEY',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    format: 'openai',
  },
  deepseek: {
    match: [/api\.deepseek\.com/],
    secretKey: 'DEEPSEEK_API_KEY',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    format: 'openai',
  },
};

function detectProvider(targetUrl, hint) {
  if (hint && PROVIDERS[hint]) return { id: hint, ...PROVIDERS[hint] };
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    for (const pattern of provider.match) {
      if (pattern.test(targetUrl)) return { id, ...provider };
    }
  }
  return null;
}

/* ------------------------------------------------------------
   2. تبدیل فرمت‌ها
   ------------------------------------------------------------ */
function openaiToAnthropic(payload) {
  const messages = payload.messages || [];
  const systemMsg = messages.find(m => m.role === 'system');
  const otherMsgs = messages.filter(m => m.role !== 'system');
  return {
    model: payload.model,
    max_tokens: payload.max_tokens || 4096,
    temperature: payload.temperature,
    system: systemMsg?.content,
    messages: otherMsgs.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
  };
}

function anthropicToOpenai(data, model) {
  const text = data.content?.map(c => c.text || '').join('') || '';
  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || data.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason,
    }],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
}

function openaiToGoogle(payload) {
  const messages = payload.messages || [];
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
  const systemMsg = messages.find(m => m.role === 'system');
  const result = {
    contents,
    generationConfig: {
      temperature: payload.temperature,
      maxOutputTokens: payload.max_tokens,
    },
  };
  if (systemMsg) result.systemInstruction = { parts: [{ text: systemMsg.content }] };
  return result;
}

function googleToOpenai(data, model) {
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'gemini',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: data.usageMetadata?.totalTokenCount || 0,
    },
  };
}

/* ------------------------------------------------------------
   3. Helper
   ------------------------------------------------------------ */
function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/* ------------------------------------------------------------
   4. Main Handler
   ------------------------------------------------------------ */
export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    const providerHint = url.searchParams.get('provider');
    const authToken = url.searchParams.get('token');

    if (!targetUrl) return jsonError(400, 'Missing ?url= parameter');

    // Auth check
    if (env.AUTH_TOKEN && authToken !== env.AUTH_TOKEN) {
      return jsonError(401, 'Unauthorized');
    }

    // Detect provider
    const provider = detectProvider(targetUrl, providerHint);
    if (!provider) return jsonError(400, `Unknown provider for URL: ${targetUrl}`);

    // Get API key
    const apiKey = env[provider.secretKey];
    if (!apiKey) {
      return jsonError(500, `Missing secret "${provider.secretKey}". Add it in Cloudflare → Settings → Variables and Secrets.`);
    }

    // Build outgoing request
    let outgoingBody = null;
    let outgoingUrl = targetUrl;
    const incomingContentType = request.headers.get('content-type') || 'application/json';
    let payload = null;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try { payload = await request.json(); }
      catch (_) { outgoingBody = await request.text(); }

      if (payload && provider.format === 'anthropic' && payload.messages) {
        outgoingBody = JSON.stringify(openaiToAnthropic(payload));
      } else if (payload && provider.format === 'google' && payload.messages) {
        outgoingBody = JSON.stringify(openaiToGoogle(payload));
        const model = payload.model || 'gemini-1.5-flash';
        outgoingUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      } else if (payload) {
        outgoingBody = JSON.stringify(payload);
      }
    }

    // Build headers
    const outgoingHeaders = new Headers();
    outgoingHeaders.set('Content-Type', incomingContentType);
    for (const [k, v] of Object.entries(provider.authHeader(apiKey))) {
      outgoingHeaders.set(k, v);
    }
    for (const [k, v] of request.headers.entries()) {
      const lower = k.toLowerCase();
      if (['authorization','cookie','host','content-length','content-type','origin','referer'].includes(lower)) continue;
      outgoingHeaders.set(k, v);
    }

    // Fetch
    let response;
    try {
      response = await fetch(outgoingUrl, {
        method: request.method,
        headers: outgoingHeaders,
        body: outgoingBody,
      });
    } catch (e) {
      return jsonError(502, `Fetch failed: ${e.message}`);
    }

    // Normalize response
    const responseContentType = response.headers.get('content-type') || '';
    let responseBody = response.body;

    if (responseContentType.includes('application/json') && provider.format !== 'openai') {
      try {
        const data = await response.json();
        let normalized = data;
        if (provider.format === 'anthropic') normalized = anthropicToOpenai(data, payload?.model);
        else if (provider.format === 'google') normalized = googleToOpenai(data, payload?.model);
        responseBody = JSON.stringify(normalized);
      } catch (e) {
        responseBody = await response.text();
      }
    }

    // Final response
    const finalHeaders = new Headers(response.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) finalHeaders.set(k, v);
    finalHeaders.delete('content-security-policy');
    finalHeaders.delete('content-encoding');
    finalHeaders.delete('content-length');

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: finalHeaders,
    });
  },
};
