use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use amber_router::live::Live;
use amber_router::routes::build_live_router;
use amber_router::store;
use clap::{Parser, Subcommand};

/// The router's default port. Loopback only — see `bind`.
pub const DEFAULT_PORT: u16 = 7719;

#[derive(Parser)]
#[command(name = "amber-router", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the proxy against the slots stored in the amber state root.
    Serve {
        #[arg(long, default_value_t = DEFAULT_PORT)]
        port: u16,
        /// Amber state root. Defaults to the platform state directory.
        #[arg(long)]
        root: Option<PathBuf>,
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
        Command::Serve { port, root } => {
            let root = amber::platform::resolve_state_root(root)?;
            // The router holds real provider keys. It is never open, not even
            // on loopback, and it never mints its token lazily per request.
            let token = store::load_or_create_token(&root, false)?;
            let mut server = store::default_server();
            server.auth_token = Some(token);

            // The ONE place an address is chosen. There is deliberately no
            // flag that can reach another interface.
            let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
            let listener = tokio::net::TcpListener::bind(addr).await?;
            let bound = listener.local_addr()?.port();

            let live = Live::from_store(&root, server)?.with_port(bound);
            let slots = live.slots()?.len();
            tracing::info!(port = bound, slots, root = %root.display(), "amber-router listening");
            axum::serve(listener, build_live_router(live)).await?;
        }
    }
    Ok(())
}
