// Conversation context helpers: compaction and reasoning/visible-output splitting.
export function compactMessagesList(messages, maxRecent = 4) {
  if (!Array.isArray(messages) || messages.length <= (maxRecent + 2)) {
    return { compacted: false, messages };
  }
  const sysMsg = messages[0]?.role === "system" ? messages[0] : null;
  const conversation = sysMsg ? messages.slice(1) : messages;

  if (conversation.length <= maxRecent) {
    return { compacted: false, messages };
  }

  const toSummarize = conversation.slice(0, conversation.length - maxRecent);
  const preservedRecent = conversation.slice(conversation.length - maxRecent);

  const actions = [];
  const userGoals = [];
  for (const m of toSummarize) {
    if (m.role === "user") {
      userGoals.push(String(m.content || "").slice(0, 150));
    } else if (m.role === "assistant") {
      const toolMatch = (m.content || "").match(/\[TOOL:\s*(\w+)/g);
      if (toolMatch) actions.push(...toolMatch);
    }
  }

  const summaryContent = [
    `[CONTEXT COMPACTION SUMMARY - Earlier ${toSummarize.length} conversation turns compacted]`,
    userGoals.length > 0 ? `Initial Goals: ${userGoals.slice(0, 3).join(" -> ")}` : "",
    actions.length > 0 ? `Key Tools Run: ${Array.from(new Set(actions)).slice(0, 8).join(", ")}` : "",
    `Summary: Previous turns completed requirements analysis and incremental worktree changes. Recent context retained below.`
  ].filter(Boolean).join("\n");

  const summaryMessage = {
    id: "msg_compact_" + Date.now(),
    role: "user",
    content: summaryContent,
    timestamp: new Date().toISOString()
  };

  const compacted = sysMsg
    ? [sysMsg, summaryMessage, ...preservedRecent]
    : [summaryMessage, ...preservedRecent];

  return {
    compacted: true,
    compactedTurnsCount: toSummarize.length,
    summary: summaryContent,
    messages: compacted
  };
}

export function splitReasoningAndVisibleOutput(rawOutput = "", priorReasoning = "") {
  const thoughts = [];
  if (priorReasoning && String(priorReasoning).trim()) {
    thoughts.push(String(priorReasoning).trim());
  }
  let cleanedOutput = String(rawOutput || "");
  if (cleanedOutput.trim() === "*(Completed reasoning pass — see Internal Reasoning above)*") {
    cleanedOutput = "";
  }
  cleanedOutput = cleanedOutput.replace(/<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/gi, (_, t) => {
    if (t && t.trim()) thoughts.push(t.trim());
    return "";
  });
  const openIdx = cleanedOutput.search(/<(?:think|thinking)>/i);
  if (openIdx !== -1 && !/<\/(?:think|thinking)>/i.test(cleanedOutput.slice(openIdx))) {
    const rawThink = cleanedOutput.slice(openIdx).replace(/^<(?:think|thinking)>/i, "").trim();
    if (rawThink) thoughts.push(rawThink);
    cleanedOutput = cleanedOutput.slice(0, openIdx);
  }
  cleanedOutput = cleanedOutput.replace(/\[THOUGHT:\s*([^\]]+)\]/gi, (_, t) => {
    if (t && t.trim()) thoughts.push(t.trim());
    return "";
  });

  let finalCleaned = cleanedOutput.trim();
  let combinedReasoning = thoughts.join("\n\n").trim();

  // If visible output is empty because an unclosed <think> or delta.reasoning_content swallowed
  // the reply / ===FILE:=== / File 1: / [TOOL:...] blocks at the tail, split at the response boundary:
  if (!finalCleaned && combinedReasoning) {
    const transitionRx = /\n((?:@[a-zA-Z0-9_-]+\b|===FILE:\s*[^\n=]+===|===PATCH:\s*[^\n=]+===|(?:Final\s+)?Response:\s*\n|(?:Let me write (?:all )?the (?:actual )?(?:files|code) now[^\n]*\n+)|File\s+1\s*:\s*[^\n]+\n)[\s\S]*)$/i;
    const m = combinedReasoning.match(transitionRx);
    if (m && m.index !== undefined && m.index > 0) {
      finalCleaned = m[1]
        .replace(/^(?:Final\s+)?Response:\s*\n/i, "")
        .replace(/^Let me write (?:all )?the (?:actual )?(?:files|code) now[^\n]*\n+/i, "")
        .trim();
      combinedReasoning = combinedReasoning.slice(0, m.index).trim();
    } else if (rawOutput && !priorReasoning && !rawOutput.trim().startsWith("<think>") && !rawOutput.trim().startsWith("<thinking>")) {
      finalCleaned = rawOutput.trim();
    }
  }

  return {
    thoughts: combinedReasoning ? (thoughts.length > 0 ? thoughts : [combinedReasoning]) : [],
    reasoning: combinedReasoning,
    cleanedOutput: finalCleaned
  };
}

// Thread messages are written by two producers: the UI stores { senderType, text } and the server runner
// stores { role, content }. Map both shapes into chat messages for the agent that is about to speak, so it
// sees its own earlier replies as "assistant" turns and teammates' replies / terminal output as context.
export function threadMessagesToChat(messages = [], botId = "", botNameById = {}) {
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    const body = String(m.content || m.text || "").trim();
    if (!body) continue;
    const isBot = m.role === "assistant" || m.senderType === "bot";
    if (isBot && (!m.botId || m.botId === botId)) {
      out.push({ role: "assistant", content: body });
    } else if (isBot) {
      const name = m.botName || botNameById[m.botId] || m.botId;
      out.push({ role: "user", content: `[@${name} said]\n${body}` });
    } else if (m.senderType === "terminal") {
      const header = m.command ? `[Terminal: \`${m.command}\` exited ${m.exitCode ?? "?"}]` : "[Terminal output]";
      out.push({ role: "user", content: `${header}\n${body}` });
    } else {
      out.push({ role: "user", content: body });
    }
  }
  return out;
}

// A reply with no executable tool call ends the turn. Detect the two cases where that is a mistake rather
// than a final answer: a [TOOL: ...] tag that could not be parsed, or a closing line announcing work
// ("Running diagnostics now:", "Let me fix it") that was never actually requested.
export function detectUnfulfilledAction(reply = "") {
  const text = String(reply || "").trim();
  if (!text) return null;
  if (/\[TOOL:/i.test(text)) {
    return "Your reply contains a [TOOL: ...] tag that could not be parsed (unbalanced [ ] brackets or a missing closing ]), so nothing ran.";
  }
  const lastLine = text.split("\n").map(l => l.trim()).filter(Boolean).pop() || "";
  if (/\?\s*$/.test(lastLine)) {
    // Asking leave to look ("Should I run the diagnostics?", "Want me to check the logs?") is not a real
    // decision for the user: checks are read-only, and risky commands already go through the approval gate.
    // Choices with consequences (delete, push, deploy, which option...) stay questions.
    const asksLeave = /\b(?:should|shall|can|may) i\b|\b(?:want|like) me to\b|\bshould we\b|\bproceed\b/i.test(lastLine);
    const routine = /\b(?:run|check|test|inspect|look|diagnos\w*|verify|investigate|debug|try|proceed|continue|dig)\b/i.test(lastLine);
    const consequential = /\b(?:delete|remove|drop|wipe|reset|push|publish|deploy|release|merge|overwrite|rewrite|migrate|commit|pay|purchase|or)\b/i.test(lastLine);
    if (asksLeave && routine && !consequential) {
      return `You asked "${lastLine.slice(0, 120)}" instead of doing it. Read-only checks and diagnostics need no permission (risky commands are sent to the user for approval automatically), so run them now and report what the output shows.`;
    }
    return null;
  }
  if (/:\s*$/.test(lastLine) || /^(?:now\s+)?(?:let me|i'll|i will|i'm going to|running|checking|fixing|retrying|next,? i)\b/i.test(lastLine)) {
    return `You said "${lastLine.slice(0, 120)}" but did not call any tool, so nothing ran.`;
  }
  return null;
}
