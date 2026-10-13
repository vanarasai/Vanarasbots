use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use vanaras_core::{ToolCall, ToolResult};

#[derive(Error, Debug)]
pub enum McpError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Protocol error: {0}")]
    Protocol(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

pub struct McpProcessClient {
    stdin: Arc<Mutex<ChildStdin>>,
    reader: Arc<Mutex<BufReader<tokio::process::ChildStdout>>>,
    _child: Arc<Mutex<Child>>,
    request_id: AtomicU64,
}

impl McpProcessClient {
    pub async fn spawn(command: &str, args: &[&str]) -> Result<Self, McpError> {
        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        let stdin = child.stdin.take().ok_or_else(|| McpError::Protocol("Failed to open stdin".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| McpError::Protocol("Failed to open stdout".into()))?;

        let client = Self {
            stdin: Arc::new(Mutex::new(stdin)),
            reader: Arc::new(Mutex::new(BufReader::new(stdout))),
            _child: Arc::new(Mutex::new(child)),
            request_id: AtomicU64::new(1),
        };

        // Initialize MCP handshake
        client.send_initialize().await?;

        Ok(client)
    }

    async fn send_request(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, McpError> {
        let id = self.request_id.fetch_add(1, Ordering::SeqCst);
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        let mut line = serde_json::to_string(&req)?;
        line.push('\n');

        {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await?;
        }

        let mut reader = self.reader.lock().await;
        let mut response_line = String::new();
        reader.read_line(&mut response_line).await?;

        let resp: serde_json::Value = serde_json::from_str(&response_line)?;
        if let Some(error) = resp.get("error") {
            return Err(McpError::Protocol(error.to_string()));
        }

        Ok(resp.get("result").cloned().unwrap_or(serde_json::Value::Null))
    }

    pub async fn send_initialize(&self) -> Result<(), McpError> {
        let params = serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "vanaras-ide",
                "version": "0.1.0"
            }
        });
        self.send_request("initialize", params).await?;
        Ok(())
    }

    pub async fn list_tools(&self) -> Result<Vec<ToolDefinition>, McpError> {
        let result = self.send_request("tools/list", serde_json::json!({})).await?;
        let tools_val = result.get("tools").cloned().unwrap_or(serde_json::json!([]));
        let tools: Vec<ToolDefinition> = serde_json::from_value(tools_val)?;
        Ok(tools)
    }

    pub async fn call_tool(&self, call: &ToolCall) -> Result<ToolResult, McpError> {
        let params = serde_json::json!({
            "name": call.name,
            "arguments": call.arguments
        });

        match self.send_request("tools/call", params).await {
            Ok(res) => Ok(ToolResult {
                call_id: call.id.clone(),
                output: res,
                is_error: false,
            }),
            Err(e) => Ok(ToolResult {
                call_id: call.id.clone(),
                output: serde_json::json!({ "error": e.to_string() }),
                is_error: true,
            }),
        }
    }
}
