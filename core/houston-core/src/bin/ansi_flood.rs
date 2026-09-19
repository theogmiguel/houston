use std::io::{BufWriter, Write};

fn main() {
    let mib: usize = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(64);
    let target = mib * 1024 * 1024;

    let stdout = std::io::stdout();
    let mut out = BufWriter::with_capacity(64 * 1024, stdout.lock());

    let mut written = 0usize;
    let mut i = 0u32;
    while written < target {
        let line = format!(
            "\x1b[38;5;{}m█▓▒░\x1b[0m \x1b[1m[{i:08}]\x1b[0m \x1b[38;5;208mhouston flood\x1b[0m \x1b[2m{}\x1b[0m\r\n",
            (i % 200) + 16,
            "≡".repeat((i % 40) as usize)
        );
        out.write_all(line.as_bytes()).expect("write flood line");
        written += line.len();
        i += 1;
    }
    out.flush().expect("flush flood");
}
