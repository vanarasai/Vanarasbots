// HTTP routes: /api/llm/stream, /api/llm/chat, /api/llm/models
import { readJsonBody, sendJson } from "../http-utils.mjs";
import { fetchWithLocalFallback, normalizeOpenAIBaseUrl, queryLLMInternal, resolveOpenRouterModelSlug } from "../llm.mjs";
import { resolveVaultApiKey, saveLocalKeysVault } from "../vault.mjs";

export async function handleLlmRoutes(req, res) {
  // 6A. Real-Time Token & Thought Streaming Proxy (POST /api/llm/stream)
  if (req.method === "POST" && req.url === "/api/llm/stream") {
    const streamAbortCtrl = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        try { streamAbortCtrl.abort(); } catch {}
      }
    });
    try {
      const {
        provider = "local",
        baseUrl = "http://192.168.68.102:1234/v1",
        apiKey: rawApiKey = "",
        botId = "",
        model = "",
        messages = [],
        temperature = 0.7,
        max_tokens = 8192,
        enableReasoning = false
      } = await readJsonBody(req);
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

      // If provider is native Anthropic or Gemini without OpenAI compatibility endpoint, delegate to non-stream or return 400 so client falls back to /api/llm/chat
      if (provider === "anthropic" || provider === "claude" || (provider === "gemini" && !cleanBase.includes("/openai"))) {
        return sendJson(res, 400, { error: "Use /api/llm/chat for native Anthropic/Gemini endpoints" });
      }

      const chatUrl = cleanBase.endsWith("/chat/completions") ? cleanBase : `${cleanBase}/chat/completions`;
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      if (provider === "openrouter" || cleanBase.includes("openrouter.ai")) {
        headers["HTTP-Referer"] = "http://localhost:3000";
        headers["X-Title"] = "Vanaras Desktop App";
      }

      let activeModel = model;
      const buildStreamBody = (targetModel, reasoningCfg) => {
        const b = { model: targetModel, messages, temperature, max_tokens, stream: true };
        if (reasoningCfg) b.reasoning = reasoningCfg;
        if (!enableReasoning && provider === "local") {
          b.chat_template_kwargs = { enable_thinking: false };
        }
        return JSON.stringify(b);
      };

      const defaultReasoningCfg = enableReasoning ? undefined : { enabled: false };
      const reqInit = {
        method: "POST",
        headers,
        body: buildStreamBody(activeModel, defaultReasoningCfg),
        signal: streamAbortCtrl.signal
      };
      let upstream = provider === "local"
        ? await fetchWithLocalFallback(cleanBase, "/chat/completions", reqInit, 90000, streamAbortCtrl.signal)
        : await fetch(chatUrl, reqInit);

      if (!upstream.ok && upstream.status === 400) {
        let firstErrText = await upstream.text().catch(() => "");
        if ((provider === "openrouter" || cleanBase.includes("openrouter.ai")) && /not a valid model ID/i.test(firstErrText)) {
          const fallbackModel = await resolveOpenRouterModelSlug(activeModel, cleanBase, headers);
          if (fallbackModel && fallbackModel !== activeModel) {
            activeModel = fallbackModel;
            upstream = await fetch(chatUrl, {
              ...reqInit,
              body: buildStreamBody(activeModel, defaultReasoningCfg)
            });
            if (!upstream.ok) firstErrText = await upstream.text().catch(() => "");
          }
        }
        if (!upstream.ok && /reasoning/i.test(firstErrText)) {
          upstream = await fetch(chatUrl, {
            ...reqInit,
            body: buildStreamBody(activeModel, { effort: "low" })
          });
          if (!upstream.ok) {
            upstream = await fetch(chatUrl, {
              ...reqInit,
              body: buildStreamBody(activeModel, undefined)
            });
          }
        } else if (!upstream.ok) {
          return sendJson(res, 400, { error: `Stream HTTP 400: ${firstErrText}` });
        }
      }

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => "");
        return sendJson(res, upstream.status || 502, { error: `Stream HTTP ${upstream.status}: ${errText}` });
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive"
      });

      const decoder = new TextDecoder();
      let buffer = "";
      let totalContent = "";
      let totalReasoning = "";
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        let abortReasoningRunaway = false;
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.error) {
              res.write(`data: ${JSON.stringify({ error: parsed.error.message || JSON.stringify(parsed.error) })}\n\n`);
              continue;
            }
            const delta = parsed.choices?.[0]?.delta || {};
            const token = delta.content || "";
            const reasoning = delta.reasoning_content || delta.reasoning || "";
            if (token || reasoning) {
              totalContent += token;
              totalReasoning += reasoning;
              res.write(`data: ${JSON.stringify({ token, reasoning })}\n\n`);
              if (!enableReasoning && !totalContent.trim() && totalReasoning.length > 1600) {
                abortReasoningRunaway = true;
                break;
              }
            }
          } catch {}
        }
        if (abortReasoningRunaway) break;
      }

      const visibleOutsideThink = totalContent
        .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "")
        .replace(/<(?:think|thinking)>[\s\S]*$/gi, "")
        .trim();

      if (!visibleOutsideThink && (totalReasoning.trim() || totalContent.trim()) && !streamAbortCtrl.signal.aborted) {
        try {
          const followUpMessages = [
            ...messages,
            {
              role: "user",
              content: "You spent your turn in internal reasoning without writing the visible response. Output the direct visible response, [TOOL: ...] actions, or ===FILE: ...=== blocks now with zero <think> tags."
            }
          ];
          const followRes = await fetch(chatUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: activeModel,
              messages: followUpMessages,
              temperature,
              max_tokens,
              stream: false,
              reasoning: { enabled: false }
            }),
            signal: streamAbortCtrl.signal
          });
          if (followRes.ok) {
            const followData = await followRes.json();
            const followText = (followData?.choices?.[0]?.message?.content || "").trim();
            if (followText) {
              res.write(`data: ${JSON.stringify({ token: followText, reasoning: "" })}\n\n`);
            }
          }
        } catch {}
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (e) {
      if (!res.headersSent) {
        sendJson(res, 502, { error: e.message });
      } else {
        res.end();
      }
    }
    return;
  }

  // 6B. Universal Multi-Provider LLM Chat Proxy
  if (req.method === "POST" && req.url === "/api/llm/chat") {
    try {
      const body = await readJsonBody(req);
      const resData = await queryLLMInternal(body);
      if (!resData.ok) {
        return sendJson(res, resData.status || 500, { error: resData.error });
      }
      return sendJson(res, 200, {
        choices: [{
          message: {
            role: "assistant",
            content: resData.content,
            reasoning_content: resData.reasoning,
            tool_calls: resData.tool_calls
          }
        }],
        model: resData.model
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 7. Universal Model Discovery
  if (req.method === "POST" && req.url === "/api/llm/models") {
    try {
      const { provider = "local", baseUrl = "http://192.168.68.102:1234/v1", apiKey: rawApiKey = "", botId = "" } = await readJsonBody(req);
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

      if (provider === "gemini") {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
        const upstream = await fetch(endpoint);
        if (!upstream.ok) return sendJson(res, upstream.status, { error: `Gemini HTTP ${upstream.status}` });
        const data = await upstream.json();
        const models = (data.models || []).map(m => (m.name || "").replace(/^models\//, "")).filter(Boolean);
        return sendJson(res, 200, { models });
      }

      if (provider === "anthropic" || provider === "claude") {
        return sendJson(res, 200, {
          models: ["claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"]
        });
      }

      const modelsUrl = cleanBase.endsWith("/models") ? cleanBase : `${cleanBase}/models`;
      const headers = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      if (provider === "openrouter" || cleanBase.includes("openrouter.ai")) {
        headers["HTTP-Referer"] = "http://localhost:3000";
        headers["X-Title"] = "Vanaras Desktop App";
        if (apiKey) {
          const authCheck = await fetch("https://openrouter.ai/api/v1/auth/key", {
            method: "GET",
            headers
          }).catch(() => null);
          if (authCheck && (authCheck.status === 401 || authCheck.status === 403)) {
            return sendJson(res, 401, { error: "Invalid OpenRouter API Key (401 Unauthorized)" });
          }
        }
      }

      const upstream = provider === "local"
        ? await fetchWithLocalFallback(cleanBase, "/models", { method: "GET", headers }, 2500)
        : await fetch(modelsUrl, { method: "GET", headers });
      if (!upstream.ok) return sendJson(res, upstream.status, { error: `Models HTTP ${upstream.status}` });
      const data = await upstream.json();
      let models = (data.data || []).map(m => m.id).filter(Boolean);
      if (provider === "openrouter" || cleanBase.includes("openrouter.ai")) {
        models = models.filter(id => !id.startsWith("~"));
      }
      return sendJson(res, 200, { models });
    } catch (e) {
      sendJson(res, 502, { error: e.message });
    }
    return;
  }

  return false;
}
