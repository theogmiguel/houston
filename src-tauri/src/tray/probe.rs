pub const STATUS_NOTIFIER_WATCHER: &str = "org.kde.StatusNotifierWatcher";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrayAvailability {
    Available,
    Unavailable(String),
}

impl TrayAvailability {
    pub fn is_available(&self) -> bool {
        matches!(self, TrayAvailability::Available)
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            TrayAvailability::Available => None,
            TrayAvailability::Unavailable(reason) => Some(reason),
        }
    }
}

#[cfg(target_os = "linux")]
pub fn decide(
    watcher_owner: Result<bool, String>,
    library: Result<(), String>,
) -> TrayAvailability {
    match watcher_owner {
        Ok(false) => {
            return TrayAvailability::Unavailable(format!(
                "No tray on this desktop: nothing owns {STATUS_NOTIFIER_WATCHER}; on GNOME that \
                 is the AppIndicator extension"
            ))
        }
        Err(err) => {
            return TrayAvailability::Unavailable(format!(
                "No tray on this desktop: the session bus could not be asked who owns \
                 {STATUS_NOTIFIER_WATCHER}: {err}"
            ))
        }
        Ok(true) => {}
    }
    match library {
        Ok(()) => TrayAvailability::Available,
        Err(err) => TrayAvailability::Unavailable(err),
    }
}

#[cfg(target_os = "linux")]
pub fn probe() -> TrayAvailability {
    decide(watcher_has_owner(), library_loads())
}

#[cfg(target_os = "linux")]
fn watcher_has_owner() -> Result<bool, String> {
    let connection = zbus::blocking::Connection::session()
        .map_err(|err| format!("session bus unavailable: {err}"))?;
    let dbus = zbus::blocking::fdo::DBusProxy::new(&connection)
        .map_err(|err| format!("could not reach the bus daemon: {err}"))?;
    let name = zbus::names::BusName::try_from(STATUS_NOTIFIER_WATCHER)
        .map_err(|err| format!("{STATUS_NOTIFIER_WATCHER} is not a valid bus name: {err}"))?;
    dbus.name_has_owner(name)
        .map_err(|err| format!("NameHasOwner failed: {err}"))
}

#[cfg(target_os = "linux")]
const APPINDICATOR_SONAMES: [&str; 4] = [
    "libayatana-appindicator3.so.1",
    "libappindicator3.so.1",
    "libayatana-appindicator3.so",
    "libappindicator3.so",
];

#[cfg(target_os = "linux")]
fn library_loads() -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    for name in APPINDICATOR_SONAMES {
        // SAFETY: `dlopen` runs the library's initialisers, which for a GTK
        // extension is expected and safe to trigger from any thread here.
        match unsafe { libloading::Library::new(name) } {
            Ok(library) => {
                // Leaked on purpose: only a probe, and dlclose-ing a loaded
                // appindicator lib can crash the GTK process that owns it.
                std::mem::forget(library);
                return Ok(());
            }
            Err(err) => errors.push(format!("{name}: {err}")),
        }
    }
    Err(format!(
        "No tray on this desktop: neither libayatana-appindicator3.so.1 nor \
         libappindicator3.so.1 could be loaded ({}); on Debian/Ubuntu that is the package \
         libayatana-appindicator3-1",
        errors.join("; ")
    ))
}

#[cfg(not(target_os = "linux"))]
pub fn probe() -> TrayAvailability {
    TrayAvailability::Available
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn an_owned_watcher_and_a_loadable_library_mean_a_tray() {
        assert_eq!(decide(Ok(true), Ok(())), TrayAvailability::Available);
    }

    #[test]
    fn an_unowned_watcher_refuses_and_names_the_bus_name_and_the_extension() {
        let decision = decide(Ok(false), Ok(()));
        let reason = decision.reason().expect("an unowned watcher is a refusal");
        assert!(reason.contains(STATUS_NOTIFIER_WATCHER), "{reason}");
        assert!(reason.contains("AppIndicator"), "{reason}");
        assert!(!decision.is_available());
    }

    #[test]
    fn an_unreachable_bus_refuses_and_quotes_the_error() {
        let decision = decide(Err("Failed to connect to bus".into()), Ok(()));
        let reason = decision.reason().expect("an unreachable bus is a refusal");
        assert!(reason.contains(STATUS_NOTIFIER_WATCHER), "{reason}");
        assert!(reason.contains("Failed to connect to bus"), "{reason}");
    }

    #[test]
    fn a_missing_library_refuses_even_with_a_watcher_listening() {
        let decision = decide(
            Ok(true),
            Err(library_refusal("libayatana-appindicator3.so.1: not found")),
        );
        let reason = decision.reason().expect("a missing library is a refusal");
        assert!(reason.contains("libayatana-appindicator3.so.1"), "{reason}");
        assert!(reason.contains("libappindicator3.so.1"), "{reason}");
        assert!(
            reason.contains("libayatana-appindicator3-1"),
            "the refusal must name the package that fixes it: {reason}"
        );
        assert!(!decision.is_available());
    }

    #[test]
    fn the_bus_refusal_wins_when_both_checks_fail() {
        let decision = decide(Ok(false), Err(library_refusal("nothing loaded")));
        let reason = decision.reason().expect("both failing is a refusal");
        assert!(
            reason.contains(STATUS_NOTIFIER_WATCHER) && !reason.contains("libappindicator3.so.1"),
            "the commoner, cheaper refusal is the one to show: {reason}"
        );
    }

    fn library_refusal(errors: &str) -> String {
        format!(
            "No tray on this desktop: neither libayatana-appindicator3.so.1 nor \
             libappindicator3.so.1 could be loaded ({errors}); on Debian/Ubuntu that is the \
             package libayatana-appindicator3-1"
        )
    }

    #[test]
    fn the_live_library_probe_answers_in_the_documented_shape() {
        if let Err(reason) = library_loads() {
            assert!(reason.contains("libayatana-appindicator3-1"), "{reason}");
        }
    }
}
