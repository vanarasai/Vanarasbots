use serde::{Deserialize, Serialize};
use thiserror::Error;
use vanaras_core::{Message, Role};

#[derive(Error, Debug)]
pub enum RouterError {
    #[error("HTTP request failed: {0}")]
    Reqwest(#[from] reqwest::Error),
    #[error("Serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("API error response ({status}): {body}")]
    Api { status: u16, body: String },
}

#[derive(Debug, Clone)]
pub struct ModelEndpoint {
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub default_model: String,
}

impl ModelEndpoint {
    pub fn local_bonsai(base_url: Option<String>) -> Self {
        Self {
            name: "Bonsai-2-27B".to_string(),
            base_url: base_url.unwrap_or_else(|| "http://localhost:1234/v1".to_string()),
            api_key: "not-needed".to_string(),
            default_model: "Ternary-Bonsai-2-27B".to_string(),
        }
    }

    pub fn cloud_gemini(api_key: String) -> Self {
        Self {
            name: "Gemini-2.5".to_string(),
            base_url: "https://generativelanguage.googleapis.com/v1beta/openai".to_string(),
            api_key,
            default_model: "gemini-2.5-flash".to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatCompletionResponse {
    pub choices: Vec<Choice>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Choice {
    pub message: AssistantMessagePayload,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AssistantMessagePayload {
    pub role: String,
    pub content: Option<String>,
    #[serde(default)]
    pub reasoning_content: Option<String>,
    pub tool_calls: Option<Vec<RawToolCall>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RawToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: RawFunctionCall,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RawFunctionCall {
    pub name: String,
    pub arguments: String,
}

pub struct ModelRouter {
    client: reqwest::Client,
    local: ModelEndpoint,
    cloud: Option<ModelEndpoint>,
}

impl ModelRouter {
    pub fn new(local: ModelEndpoint, cloud: Option<ModelEndpoint>) -> Self {
        Self {
            client: reqwest::Client::new(),
            local,
            cloud,
        }
    }

    pub async fn complete(
        &self,
        messages: &[Message],
        tools: &[serde_json::Value],
        prefer_cloud: bool,
    ) -> Result<AssistantMessagePayload, RouterError> {
        let endpoint = if prefer_cloud && self.cloud.is_some() {
            self.cloud.as_ref().unwrap()
        } else {
            &self.local
        };

        let formatted_messages: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| {
                let role = match m.role {
                    Role::User => "user",
                    Role::Assistant => "assistant",
                    Role::System => "system",
                    Role::Tool => "tool",
                };

                let mut obj = serde_json::json!({
                    "role": role,
                    "content": m.content,
                });

                if let Some(tool_calls) = &m.tool_calls {
                    obj["tool_calls"] = serde_json::to_value(tool_calls).unwrap_or_default();
                }

                obj
            })
            .collect();

        let mut body = serde_json::json!({
            "model": endpoint.default_model,
            "messages": formatted_messages,
        });

        if !tools.is_empty() {
            body["tools"] = serde_json::json!(tools);
        }

        let res = self
            .client
            .post(format!("{}/chat/completions", endpoint.base_url))
            .header("Authorization", format!("Bearer {}", endpoint.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(RouterError::Api {
                status: status.as_u16(),
                body,
            });
        }

        let resp: ChatCompletionResponse = res.json().await?;
        let choice = resp.choices.into_iter().next().ok_or_else(|| {
            RouterError::Api {
                status: 200,
                body: "Empty choices in completion response".into(),
            }
        })?;

        Ok(choice.message)
    }
}
