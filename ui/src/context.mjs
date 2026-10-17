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
