use std::env;
use std::sync::Arc;
use vanaras_agent::{AgentCoordinator, DefaultHooks, ModelEndpoint, ModelRouter};
use vanaras_relay::RelayServer;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let args: Vec<String> = env::args().collect();
    let command = args.get(1).map(|s| s.as_str()).unwrap_or("help");

    println!("======================================================");
    println!("     🐒 VANARAS IDE - Multi-Agent Swarm Engine       ");
    println!("======================================================");

    match command {
        "relay" => {
            let port = args.get(2).map(|s| s.as_str()).unwrap_or("8080");
            let addr = format!("0.0.0.0:{}", port);
            println!("🚀 Starting Vanaras Multiplayer Swarm Relay on ws://{}", addr);
            println!("👥 Ready for Human teammates & Agents (@Nala, @Nila, @Angada, @Hanuman)...");

            let server = Arc::new(RelayServer::new());
            server.start(&addr).await?;
        }
        "agent" => {
            let agent_name = args.get(2).map(|s| s.as_str()).unwrap_or("@Nala");
            let prompt = args
                .get(3)
                .map(|s| s.as_str())
                .unwrap_or("Inspect the codebase and plan the architecture.");

            println!("🤖 Agent: {}", agent_name);
            let endpoint = env::var("VANARAS_MODEL_URL")
                .ok()
                .or_else(|| Some("http://192.168.68.102:1234/v1".to_string()));
            println!("🧠 Target Model: Bonsai 2 27B ({})", endpoint.as_deref().unwrap_or(""));
            println!("💬 Prompt: \"{}\"", prompt);

            let local = ModelEndpoint::local_bonsai(endpoint);
            let router = Arc::new(ModelRouter::new(local, None));
            let hooks = Arc::new(DefaultHooks);

            let coordinator = AgentCoordinator::new(agent_name, router, None, hooks);
            println!("\n⚡ Executing autonomous agent turn...");

            match coordinator.run_turn(prompt, false).await {
                Ok(reply) => {
                    println!("\n✅ Agent Turn Completed!");
                    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    if let Some(reasoning) = reply.reasoning {
                        println!("💭 Thought:\n{}\n", reasoning);
                    }
                    println!("📝 Output:\n{}", reply.content);
                    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                }
                Err(e) => {
                    println!("\n⚠️ Agent could not reach model server: {}", e);
                    println!("💡 Tip: Start LM Studio or MLX serving Bonsai 2 27B on port 1234, or set VANARAS_MODEL_URL.");
                }
            }
        }
        _ => {
            println!("Usage: vanaras <command> [options]");
            println!();
            println!("Commands:");
            println!("  relay [port]             Start the multiplayer relay server (default: 8080)");
            println!("  agent [name] [prompt]    Run an autonomous agent turn (e.g. @Nala, @Nila)");
            println!();
            println!("Environment Variables:");
            println!("  VANARAS_MODEL_URL        Custom endpoint for local/cloud LLM (e.g. http://mac-mini.local:1234/v1)");
        }
    }

    Ok(())
}
