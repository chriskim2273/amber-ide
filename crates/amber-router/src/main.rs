use std::path::PathBuf;

use clap::{Parser, Subcommand};
use router_core::config::Config;
use amber_router::routes::build_router;
use amber_router::state::AppState;

#[derive(Parser)]
#[command(name = "amber-router", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the proxy.
    Serve {
        #[arg(long, default_value = "router.toml")]
        config: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    match Cli::parse().command {
        Command::Serve { config } => {
            let src = std::fs::read_to_string(&config)?;
            let cfg = Config::load_str(&src, &|name| std::env::var(name).ok())?;
            let bind = cfg.server.bind.clone();
            let state = AppState::new(cfg);
            let app = build_router(state);
            let listener = tokio::net::TcpListener::bind(&bind).await?;
            tracing::info!(bind = %bind, "amber-router listening");
            axum::serve(listener, app).await?;
        }
    }
    Ok(())
}
