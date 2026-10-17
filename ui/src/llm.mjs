// Provider-agnostic LLM transport (Anthropic, Gemini, OpenAI-compatible incl. Grok/OpenRouter/local).
import { resolveVaultApiKey, saveLocalKeysVault } from "./vault.mjs";

export function normalizeOpenAIBaseUrl(rawBase = "http://192.168.68.102:1234/v1") {
  const trimmed = String(rawBase || "http://192.168.68.102:1234/v1").trim().replace(/\/+$/, "");
  if (!trimmed) return "http://192.168.68.102:1234/v1";
  if (trimmed.endsWith("/v1") || trimmed.endsWith("/chat/completions") || trimmed.endsWith("/models") || trimmed.includes("/v1/")) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

export async function fetchWithLocalFallback(cleanBase, pathSuffix, init = {}, primaryTimeoutMs = 90000, parentSignal = null) {
  const candidates = [
    cleanBase,
    "http://192.168.68.102:1234/v1",
    "http://127.0.0.1:1234/v1",
    "http://localhost:1234/v1",
    "http://127.0.0.1:11434/v1"
  ];
  const seen = new Set();
  let lastError = null;
  let isFirst = true;
  for (const base of candidates) {
    const norm = normalizeOpenAIBaseUrl(base);
    if (seen.has(norm)) continue;
    seen.add(norm);
    const targetUrl = norm.endsWith(pathSuffix) ? norm : `${norm}${pathSuffix}`;
    const ctrl = new AbortController();
    const timeoutMs = isFirst ? primaryTimeoutMs : 2500;
    isFirst = false;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    if (parentSignal) {
      if (parentSignal.aborted) {
        clearTimeout(timer);
        ctrl.abort();
      } else {
        parentSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
      }
    }
    try {
      const res = await fetch(targetUrl, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status} from ${targetUrl}`);
      if (norm === cleanBase && candidates.length === 1) return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (parentSignal?.aborted) throw err;
    }
  }
  throw lastError || new Error("All local LLM endpoints unreachable");
}

export async function resolveOpenRouterModelSlug(requestedModel, cleanBase, headers) {
  if (!requestedModel) return null;
  try {
    const modelsUrl = cleanBase.endsWith("/models") ? cleanBase : `${cleanBase}/models`;
    const res = await fetch(modelsUrl, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    const ids = Array.isArray(data?.data) ? data.data.map(m => m.id).filter(Boolean) : [];
    if (ids.includes(requestedModel)) return requestedModel;
    // Strip trailing numeric version suffixes like -4-0 or -2025...
    const stripped = requestedModel.replace(/-[0-9]+(?:-[0-9]+)*$/, "");
    if (stripped !== requestedModel && ids.includes(stripped)) return stripped;
    const prefixMatches = ids.filter(id => id.startsWith(stripped));
    if (prefixMatches.length > 0) return prefixMatches[0];
    const vendor = requestedModel.split("/")[0];
    if (vendor) {
      const vendorMatches = ids.filter(id => id.startsWith(`${vendor}/`));
      if (vendorMatches.length > 0) return vendorMatches[0];
    }
  } catch {}
  return null;
}

// 6B-2. Unified LLM Query Function (OpenAI, Grok, Anthropic, Gemini, Local)
const LOCAL_COMPLETION_TIMEOUT_MS = 10 * 60 * 1000;

export async function queryLLMInternal(params = {}) {
  const {
    provider = "local",
    baseUrl = "http://192.168.68.102:1234/v1",
    apiKey: rawApiKey = "",
    botId = "",
    model = "",
    messages = [],
    temperature = 0.7,
    max_tokens = 8192,
    enableReasoning = false,
    tools = null,
    tool_choice = null,
    signal = null
  } = params;

  const apiKey = resolveVaultApiKey(provider, rawApiKey, botId);
  if (rawApiKey && String(rawApiKey).trim() && provider !== "local") {
    saveLocalKeysVault({
      providers: { [String(provider).toLowerCase()]: String(rawApiKey).trim() },
      ...(botId ? { bots: { [botId]: String(rawApiKey).trim() } } : {})
    });
  }

  const effectiveBase = (provider === "openrouter" && (!baseUrl || baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost") || baseUrl.includes("192.168.")))
    ? "https://openrouter.ai/api/v1"
    : baseUrl;
  const cleanBase = normalizeOpenAIBaseUrl(effectiveBase);

  // 1. Native Anthropic Messages API
  if (provider === "anthropic" || provider === "claude" || cleanBase.includes("api.anthropic.com")) {
    const systemMsg = messages.find(m => m.role === "system")?.content || "";
    const userMsgs = messages.filter(m => m.role !== "system").map(m => {
      if (m.role === "tool") {
        return {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: m.content
          }]
        };
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        const blocks = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.tool_calls) {
          let input = {};
          try { input = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments; } catch {}
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input
          });
        }
        return { role: "assistant", content: blocks };
      }
      return {
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content
      };
    });
    const endpoint = cleanBase.endsWith("/messages")
      ? cleanBase
      : `${cleanBase.replace(/\/v1$/, "")}/v1/messages`;

    const anthropicBody = {
      model: model || "claude-sonnet-4-20250514",
      max_tokens,
      temperature,
      system: systemMsg,
      messages: userMsgs
    };
    if (tools && tools.length > 0) {
      anthropicBody.tools = tools.map(t => {
        const fn = t.function || t;
        return {
          name: fn.name,
          description: fn.description || "",
          input_schema: fn.parameters || { type: "object", properties: {} }
        };
      });
    }

    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(anthropicBody),
      signal
    });

    const raw = await upstream.text();
    if (!upstream.ok) {
      return { ok: false, status: upstream.status, error: `Anthropic HTTP ${upstream.status}: ${raw}` };
    }
    const parsed = JSON.parse(raw);
    const textBlock = (parsed.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    const thinkingBlock = (parsed.content || []).find(b => b.type === "thinking")?.thinking || "";
    const toolUseBlocks = (parsed.content || []).filter(b => b.type === "tool_use");
    const tool_calls = toolUseBlocks.length > 0 ? toolUseBlocks.map(b => ({
      id: b.id,
      type: "function",
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input || {})
      }
    })) : null;

    return {
      ok: true,
      status: 200,
      content: textBlock,
      reasoning: thinkingBlock,
      tool_calls,
      model: parsed.model,
      raw
    };
  }

  // 2. Native Google Gemini API
  if (provider === "gemini" && !cleanBase.includes("/openai")) {
    const geminiModel = model || "gemini-2.5-flash";
    const systemMsg = messages.find(m => m.role === "system")?.content || "";
    const contents = messages.filter(m => m.role !== "system").map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content || "" }]
    }));
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents,
      generationConfig: { temperature, maxOutputTokens: max_tokens }
    };
    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg }] };
    }
    if (tools && tools.length > 0) {
      body.tools = [{
        functionDeclarations: tools.map(t => {
          const fn = t.function || t;
          return {
            name: fn.name,
            description: fn.description || "",
            parameters: fn.parameters
          };
        })
      }];
    }
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      return { ok: false, status: upstream.status, error: `Gemini HTTP ${upstream.status}: ${raw}` };
    }
    const parsed = JSON.parse(raw);
    const parts = parsed.candidates?.[0]?.content?.parts || [];
    const text = parts.filter(p => !p.thought && !p.functionCall).map(p => p.text || "").join("\n");
    const thought = parts.filter(p => p.thought).map(p => p.text || "").join("\n");
    const fnParts = parts.filter(p => p.functionCall);
    const tool_calls = fnParts.length > 0 ? fnParts.map((p, idx) => ({
      id: "call_gemini_" + idx,
      type: "function",
      function: {
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args || {})
      }
    })) : null;

    return {
      ok: true,
      status: 200,
      content: text,
      reasoning: thought,
      tool_calls,
      model: geminiModel,
      raw
    };
  }

  // 3. OpenAI-Compatible (Grok, Local LM Studio, Ollama, OpenRouter, OpenAI, Qwen)
  const chatUrl = cleanBase.endsWith("/chat/completions")
    ? cleanBase
    : `${cleanBase}/chat/completions`;

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (provider === "openrouter" || cleanBase.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "http://localhost:3000";
    headers["X-Title"] = "Vanaras Desktop App";
  }

  const payload = { messages, temperature, max_tokens };
  if (model) payload.model = model;
  if (tools && tools.length > 0) {
    payload.tools = tools;
    if (tool_choice) payload.tool_choice = tool_choice;
  }
  if (!enableReasoning) {
    payload.reasoning = { enabled: false };
    if (provider === "local") {
      payload.chat_template_kwargs = { enable_thinking: false };
    }
  }

  const reqInit = {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal
  };
  // A non-streaming completion sends its response headers only when generation finishes, so this timeout
  // bounds the whole generation, not the connection. A local model writing a long reply routinely needs
  // minutes; 25s cut those replies off and ended the agent's turn. Unreachable servers still fail fast
  // (connection refused) and fall through to the other local candidates.
  let upstream = provider === "local"
    ? await fetchWithLocalFallback(cleanBase, "/chat/completions", reqInit, LOCAL_COMPLETION_TIMEOUT_MS)
    : await fetch(chatUrl, reqInit);

  let raw = await upstream.text();
  if (!upstream.ok && upstream.status === 400) {
    if ((provider === "openrouter" || cleanBase.includes("openrouter.ai")) && /not a valid model ID/i.test(raw)) {
      const fallbackModel = await resolveOpenRouterModelSlug(model, cleanBase, headers);
      if (fallbackModel && fallbackModel !== model) {
        payload.model = fallbackModel;
        upstream = await fetch(chatUrl, {
          ...reqInit,
          body: JSON.stringify(payload)
        });
        raw = await upstream.text();
      }
    }
    if (!upstream.ok && /reasoning/i.test(raw)) {
      const retryPayload = { ...payload };
      delete retryPayload.reasoning;
      upstream = await fetch(chatUrl, {
        ...reqInit,
        body: JSON.stringify(retryPayload)
      });
      raw = await upstream.text();
    }
  }
  if (!upstream.ok) {
    return { ok: false, status: upstream.status, error: `Upstream HTTP ${upstream.status}: ${raw}` };
  }
  // OpenRouter reports provider failures (overloaded free models, upstream 5xx) as HTTP 200 with an
  // {"error": {...}} body and no choices. Read as a reply, that became an empty answer with no reason.
  try {
    const peek = JSON.parse(raw);
    if (peek && peek.error && !Array.isArray(peek.choices)) {
      const code = Number(peek.error.code) || 502;
      return { ok: false, status: code, error: `Upstream error ${code}: ${peek.error.message || JSON.stringify(peek.error)}` };
    }
  } catch {}

  let parsedChat = null;
  let msg = null;
  let rawContent = "";
  let visibleText = "";
  let rawReason = "";
  let tool_calls = null;

  try {
    parsedChat = JSON.parse(raw);
    msg = parsedChat?.choices?.[0]?.message;
    rawContent = String(msg?.content || "");
    visibleText = rawContent
      .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "")
      .replace(/<(?:think|thinking)>[\s\S]*$/gi, "")
      .trim();
    rawReason = String(msg?.reasoning_content || msg?.reasoning || "").trim();
    tool_calls = msg?.tool_calls || null;

    if (!visibleText && !tool_calls && (rawReason || rawContent) && msg) {
      const followRes = await fetch(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...payload,
          reasoning: { enabled: false },
          messages: [
            ...messages,
            {
              role: "user",
              content: "Output your direct visible response, [TOOL: ...] actions, or ===FILE: ...=== blocks now without <think> tags."
            }
          ]
        }),
        signal
      });
      if (followRes.ok) {
        const followData = await followRes.json();
        const followMsg = followData?.choices?.[0]?.message;
        const followContent = String(followMsg?.content || "").trim();
        if (followContent) {
          msg.content = followContent;
          visibleText = followContent;
        }
        if (followMsg?.tool_calls) {
          tool_calls = followMsg.tool_calls;
          msg.tool_calls = tool_calls;
        }
        raw = JSON.stringify(parsedChat);
      }
    }
  } catch {}

  return {
    ok: true,
    status: 200,
    content: visibleText || rawContent,
    reasoning: rawReason,
    tool_calls,
    model: parsedChat?.model || model,
    // Token counts as the provider reports them (OpenAI-compatible APIs, OpenRouter, Ollama); null if absent.
    usage: parsedChat?.usage
      ? { prompt: Number(parsedChat.usage.prompt_tokens) || 0, completion: Number(parsedChat.usage.completion_tokens) || 0 }
      : null,
    raw
  };
}
