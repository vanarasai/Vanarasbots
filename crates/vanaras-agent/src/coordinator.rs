use std::sync::Arc;
use tokio::sync::RwLock;
use vanaras_core::{AgentEvent, Message, Role, ToolCall, ToolResult};
use vanaras_mcp::McpProcessClient;

use crate::hooks::AgentLifecycleHooks;
use crate::router::{ModelRouter, RouterError};

pub struct AgentCoordinator {
    pub name: String, // e.g. "@Nala" (Architect), "@Nila" (Builder), "@Angada" (Researcher), "@Hanuman" (Lead)
    pub router: Arc<ModelRouter>,
    pub mcp_client: Option<Arc<McpProcessClient>>,
    pub hooks: Arc<dyn AgentLifecycleHooks>,
    pub history: Arc<RwLock<Vec<Message>>>,
}

impl AgentCoordinator {
    pub fn new(
        name: impl Into<String>,
        router: Arc<ModelRouter>,
        mcp_client: Option<Arc<McpProcessClient>>,
        hooks: Arc<dyn AgentLifecycleHooks>,
    ) -> Self {
        Self {
            name: name.into(),
            router,
            mcp_client,
            hooks,
            history: Arc::new(RwLock::new(Vec::new())),
        }
    }

    pub async fn run_turn(&self, user_prompt: &str, prefer_cloud: bool) -> Result<Message, RouterError> {
        // 1. Hook: Before submit prompt
        let enriched_prompt = self.hooks.before_submit_prompt(user_prompt).await;

        let user_msg = Message::user("User", enriched_prompt);
        {
            let mut hist = self.history.write().await;
            hist.push(user_msg);
        }

        // Prepare tools from MCP if connected
        let tools: Vec<serde_json::Value> = if let Some(mcp) = &self.mcp_client {
            match mcp.list_tools().await {
                Ok(defs) => defs
                    .into_iter()
                    .map(|d| {
                        serde_json::json!({
                            "type": "function",
                            "function": {
                                "name": d.name,
                                "description": d.description,
                                "parameters": d.input_schema,
                            }
                        })
                    })
                    .collect(),
                Err(e) => {
                    tracing::warn!("Failed to list MCP tools: {:?}", e);
                    vec![]
                }
            }
        } else {
            vec![]
        };

        // 2. Autonomous ReAct Loop
        let mut loop_count = 0;
        const MAX_STEPS: usize = 30;

        loop {
            loop_count += 1;
            if loop_count > MAX_STEPS {
                tracing::warn!("Max agent turn steps exceeded");
                break;
            }

            let current_messages = {
                let hist = self.history.read().await;
                hist.clone()
            };

            // Query the model (Bonsai 2 27B or Cloud)
            let response = self
                .router
                .complete(&current_messages, &tools, prefer_cloud)
                .await?;

            // 3. Hook: After agent thought
            if let Some(thought) = &response.reasoning_content {
                self.hooks.after_agent_thought(&self.name, thought).await;
                self.hooks
                    .emit_event(AgentEvent::ThoughtDelta {
                        agent: self.name.clone(),
                        delta: thought.clone(),
                    })
                    .await;
            }

            // Did the model request tool calls?
            if let Some(raw_tools) = response.tool_calls {
                if !raw_tools.is_empty() {
                    let mut calls = Vec::new();
                    let mut results = Vec::new();

                    for raw in raw_tools {
                        let parsed_args: serde_json::Value =
                            serde_json::from_str(&raw.function.arguments).unwrap_or(serde_json::Value::Null);

                        let call = ToolCall {
                            id: raw.id,
                            name: raw.function.name,
                            arguments: parsed_args,
                        };

                        // 4. Hook: Pre tool use
                        let allowed = self.hooks.pre_tool_use(&self.name, &call).await;
                        if !allowed {
                            results.push(ToolResult {
                                call_id: call.id.clone(),
                                output: serde_json::json!({ "error": "Execution denied by user or policy" }),
                                is_error: true,
                            });
                            calls.push(call);
                            continue;
                        }

                        self.hooks
                            .emit_event(AgentEvent::ToolStart {
                                agent: self.name.clone(),
                                call: call.clone(),
                            })
                            .await;

                        // Execute via MCP
                        let result = if let Some(mcp) = &self.mcp_client {
                            mcp.call_tool(&call).await.unwrap_or_else(|e| ToolResult {
                                call_id: call.id.clone(),
                                output: serde_json::json!({ "error": e.to_string() }),
                                is_error: true,
                            })
                        } else {
                            ToolResult {
                                call_id: call.id.clone(),
                                output: serde_json::json!({ "error": "No MCP client attached" }),
                                is_error: true,
                            }
                        };

                        // 5. Hook: Post tool use
                        self.hooks.post_tool_use(&self.name, &result).await;
                        self.hooks
                            .emit_event(AgentEvent::ToolComplete {
                                agent: self.name.clone(),
                                result: result.clone(),
                            })
                            .await;

                        results.push(result);
                        calls.push(call);
                    }

                    // Append assistant message with tool calls & tool response to history
                    {
                        let mut hist = self.history.write().await;
                        hist.push(Message {
                            id: uuid::Uuid::new_v4(),
                            role: Role::Assistant,
                            sender: self.name.clone(),
                            content: response.content.unwrap_or_default(),
                            reasoning: response.reasoning_content,
                            tool_calls: Some(calls),
                            tool_results: None,
                            timestamp: chrono::Utc::now(),
                        });
                        hist.push(Message::tool_response(self.name.clone(), results));
                    }

                    // Automatically iterate next ReAct turn!
                    continue;
                }
            }

            // Finished turn: final answer reached
            let final_content = response.content.unwrap_or_default();
            let final_msg = Message::assistant(
                self.name.clone(),
                final_content.clone(),
                response.reasoning_content,
                None,
            );

            self.hooks
                .emit_event(AgentEvent::ContentDelta {
                    agent: self.name.clone(),
                    delta: final_content,
                })
                .await;

            self.hooks
                .emit_event(AgentEvent::TurnFinished {
                    agent: self.name.clone(),
                    message_id: final_msg.id,
                })
                .await;

            {
                let mut hist = self.history.write().await;
                hist.push(final_msg.clone());
            }

            return Ok(final_msg);
        }

        // Return last assistant message if capped
        let hist = self.history.read().await;
        Ok(hist.last().cloned().unwrap_or_else(|| Message::user("User", user_prompt)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::DefaultHooks;
    use crate::router::ModelEndpoint;

    #[tokio::test]
    async fn test_coordinator_initialization() {
        let local_endpoint = ModelEndpoint::local_bonsai(Some("http://mac-mini.local:1234/v1".to_string()));
        let router = Arc::new(ModelRouter::new(local_endpoint, None));
        let hooks = Arc::new(DefaultHooks);

        let coordinator = AgentCoordinator::new("@Nala", router, None, hooks);
        assert_eq!(coordinator.name, "@Nala");

        let hist = coordinator.history.read().await;
        assert!(hist.is_empty());
    }
}

