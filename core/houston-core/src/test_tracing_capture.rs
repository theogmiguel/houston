use std::sync::Once;

static INSTALL: Once = Once::new();

pub fn ensure_permissive_global_default() {
    INSTALL.call_once(|| {
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::level_filters::LevelFilter::TRACE)
            .with_writer(std::io::sink)
            .finish();
        let _ = tracing::subscriber::set_global_default(subscriber);
    });
}
