//! Test-only peer for `app/test/windows-pipe.mjs`.

#[cfg(windows)]
fn main() -> std::io::Result<()> {
    use std::io::{Read, Write};
    use std::path::PathBuf;

    use amber::transport;
    use amber_core::proto::{self, ControlMsg, Decoder, Frame};

    let endpoint = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing pipe name")
        })?;
    let listener = transport::bind(&endpoint)?;
    println!("READY");
    std::io::stdout().flush()?;

    let mut first = listener.accept()?;
    let mut decoder = Decoder::new();
    let mut bytes = [0_u8; 1024];
    let received = loop {
        let count = first.read(&mut bytes)?;
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Node closed before sending a frame",
            ));
        }
        decoder.feed(&bytes[..count]);
        if let Some(frame) = decoder.next_frame().map_err(std::io::Error::other)? {
            break frame;
        }
    };
    if !matches!(received, Frame::Control(ControlMsg::SessionList { .. })) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "expected SessionList frame from Node",
        ));
    }
    first.write_all(&proto::encode(&received))?;

    let second = listener.accept()?;
    let (_reader, mut writer) = second.into_split()?;
    writer.shutdown()?;
    println!("RELEASED");
    std::io::stdout().flush()
}

#[cfg(not(windows))]
fn main() {
    eprintln!("amber-windows-pipe-peer requires Windows");
    std::process::exit(1);
}
