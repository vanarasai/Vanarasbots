use async_trait::async_trait;
use vanaras_core::{AgentEvent, ToolCall, ToolResult};

#[async_trait]
pub trait AgentLifecycleHooks: Send + Sync {
    /// Injects context, project tree, or system prompts before the user message is submitted
    async fn before_submit_prompt(&self, prompt: &str) -> String {
        prompt.to_string()
    }

    /// Called when the model produces internal thinking/reasoning tokens
    async fn after_agent_thought(&self, agent: &str, thought: &str) {
        let _ = (agent, thought);
    }

    /// Gatekeeper before a tool is executed (can reject or ask for user confirmation)
    async fn pre_tool_use(&self, agent: &str, call: &ToolCall) -> bool {
        let _ = (agent, call);
        true // Allow execution by default
    }

    /// Called immediately after a tool finishes execution
    async fn post_tool_use(&self, agent: &str, result: &ToolResult) {
        let _ = (agent, result);
    }

    /// Compaction hook: triggers summarization when conversation approaches context limits
    async fn pre_compact(&self, token_count: usize) -> bool {
        let _ = token_count;
        false
    }

    /// Broadcast an event to the UI and multiplayer room
    async fn emit_event(&self, event: AgentEvent) {
        let _ = event;
    }
}

pub struct DefaultHooks;
#[async_trait]
impl AgentLifecycleHooks for DefaultHooks {}
