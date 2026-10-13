use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub call_id: String,
    pub output: serde_json::Value,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: Uuid,
    pub role: Role,
    pub sender: String, // e.g., "Human:Lakshmi", "@Nala", "@Nila", "@Angada", "@Hanuman"
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_results: Option<Vec<ToolResult>>,
    pub timestamp: DateTime<Utc>,
}

impl Message {
    pub fn user(sender: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            role: Role::User,
            sender: sender.into(),
            content: content.into(),
            reasoning: None,
            tool_calls: None,
            tool_results: None,
            timestamp: Utc::now(),
        }
    }

    pub fn assistant(
        sender: impl Into<String>,
        content: impl Into<String>,
        reasoning: Option<String>,
        tool_calls: Option<Vec<ToolCall>>,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            role: Role::Assistant,
            sender: sender.into(),
            content: content.into(),
            reasoning,
            tool_calls,
            tool_results: None,
            timestamp: Utc::now(),
        }
    }

    pub fn tool_response(sender: impl Into<String>, results: Vec<ToolResult>) -> Self {
        Self {
            id: Uuid::new_v4(),
            role: Role::Tool,
            sender: sender.into(),
            content: String::new(),
            reasoning: None,
            tool_calls: None,
            tool_results: Some(results),
            timestamp: Utc::now(),
        }
    }
}

/// Agent lifecycle events streamable to the UI and multiplayer room
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum AgentEvent {
    ThoughtDelta { agent: String, delta: String },
    ContentDelta { agent: String, delta: String },
    ToolStart { agent: String, call: ToolCall },
    ToolComplete { agent: String, result: ToolResult },
    DiffGenerated { agent: String, file_path: String, diff: String },
    TurnFinished { agent: String, message_id: Uuid },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffPatch {
    pub file_path: String,
    pub original_content: String,
    pub modified_content: String,
    pub patch: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_creation_and_serialization() {
        let msg = Message::user("Lakshmi", "Refactor the session parser");
        assert_eq!(msg.sender, "Lakshmi");
        assert_eq!(msg.role, Role::User);
        assert_eq!(msg.content, "Refactor the session parser");

        let serialized = serde_json::to_string(&msg).expect("Serialize message");
        let deserialized: Message = serde_json::from_str(&serialized).expect("Deserialize message");
        assert_eq!(deserialized.id, msg.id);
        assert_eq!(deserialized.sender, msg.sender);
    }

    #[test]
    fn test_agent_events() {
        let event = AgentEvent::ThoughtDelta {
            agent: "@Nala".to_string(),
            delta: "Analyzing AST nodes...".to_string(),
        };

        let json = serde_json::to_string(&event).expect("Serialize event");
        assert!(json.contains("thought_delta"));
        assert!(json.contains("@Nala"));
    }
}

