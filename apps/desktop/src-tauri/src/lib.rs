use std::collections::BTreeSet;
use std::sync::OnceLock;
use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/* ------------------------------------------------------------------ game detection */

/// A game we can recognise, either from the bundled catalog or added by the user.
#[derive(Clone, Deserialize)]
struct GameEntry {
    name: String,
    executables: Vec<String>,
}

/// A catalog game whose executable is currently running.
#[derive(Serialize)]
struct DetectedGame {
    name: String,
    executable: String,
}

/// Result of a detection pass: the games that are running plus every running process name (for the "add a game" picker).
#[derive(Serialize)]
struct RunningGames {
    games: Vec<DetectedGame>,
    processes: Vec<String>,
}

const DETECTABLE_GAMES: &str = include_str!("detectable_games.json");

/// Parse the bundled catalog once (compiled into the binary, no resource files) and keep it for later calls.
fn bundled_games() -> &'static [GameEntry] {
    static GAMES: OnceLock<Vec<GameEntry>> = OnceLock::new();
    GAMES.get_or_init(|| serde_json::from_str(DETECTABLE_GAMES).unwrap_or_default())
}

/// Bare, lower-case executable name: strips any directory prefix and a trailing `.exe`.
fn normalize(name: &str) -> String {
    let base = name.rsplit(|c: char| c == '\\' || c == '/').next().unwrap_or(name);
    let lower = base.to_lowercase();
    lower.strip_suffix(".exe").map(str::to_owned).unwrap_or(lower)
}

/// Match running processes against the bundled catalog and the user's games, then return the matches plus every process name.
#[tauri::command]
fn list_running_games(user_games: Option<Vec<GameEntry>>) -> RunningGames {
    let mut sys = System::new();
    // Low-cost refresh: process names always come along; only the executable path is requested on top.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
    );

    let mut running: BTreeSet<String> = BTreeSet::new();
    let mut processes: BTreeSet<String> = BTreeSet::new();
    for proc_ in sys.processes().values() {
        let name = normalize(&proc_.name().to_string_lossy());
        if !name.is_empty() {
            processes.insert(name.clone());
            running.insert(name);
        }
        if let Some(file) = proc_.exe().and_then(|p| p.file_name()) {
            let name = normalize(&file.to_string_lossy());
            if !name.is_empty() {
                running.insert(name);
            }
        }
    }

    let mut games: Vec<DetectedGame> = Vec::new();
    let mut matched: BTreeSet<String> = BTreeSet::new();
    for game in bundled_games().iter().chain(user_games.as_deref().unwrap_or_default()) {
        if matched.contains(&game.name) {
            continue;
        }
        if let Some(exe) = game.executables.iter().find(|e| running.contains(&normalize(e.as_str()))) {
            matched.insert(game.name.clone());
            games.push(DetectedGame { name: game.name.clone(), executable: exe.clone() });
        }
    }
    games.sort_by(|a, b| a.name.cmp(&b.name));

    RunningGames { games, processes: processes.into_iter().collect() }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Forward jorcord:// URLs to the web app as a `jorcord://open` window event (payload = URL).
fn forward_urls(app: &AppHandle, urls: Vec<String>) {
    show_main(app);
    for u in urls {
        let _ = app.emit("jorcord://open", u);
    }
}

/* ------------------------------------------------------------------ always-on-top overlay */

/// Appearance + behaviour the web app pushes down for the mini voice window.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlaySpec {
    enabled: bool,
    locked: bool,
    corner: String,
    shortcut: Option<String>,
}

/// Gap (physical pixels) kept between the overlay window and the screen edges.
const OVERLAY_MARGIN: i32 = 16;

/// Move the overlay to the requested corner of the monitor it currently sits on.
fn position_overlay(win: &WebviewWindow, corner: &str) {
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let size = win.outer_size().unwrap_or_default();
    let mpos = monitor.position();
    let msize = monitor.size();
    let right = mpos.x + msize.width as i32 - size.width as i32 - OVERLAY_MARGIN;
    let bottom = mpos.y + msize.height as i32 - size.height as i32 - OVERLAY_MARGIN;
    let (x, y) = match corner {
        "top-left" => (mpos.x + OVERLAY_MARGIN, mpos.y + OVERLAY_MARGIN),
        "bottom-left" => (mpos.x + OVERLAY_MARGIN, bottom),
        "bottom-right" => (right, bottom),
        _ => (right, mpos.y + OVERLAY_MARGIN), // default: top-right
    };
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// Global shortcut: show the overlay if hidden, hide it if shown.
fn toggle_overlay(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
        }
    }
}

/// Apply the web app's overlay preferences: register the global shortcut, position the window, show/hide it and
/// set click-through. No game process is ever touched — this only manages our own always-on-top window.
#[tauri::command]
fn overlay_apply(app: AppHandle, spec: OverlaySpec) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    if spec.enabled {
        if let Some(accel) = spec.shortcut.as_deref() {
            // An unsupported accelerator (e.g. Wayland without a portal) must not break the settings toggle.
            if let Err(e) = shortcuts.register(accel) {
                eprintln!("overlay: could not register {accel}: {e}");
            }
        }
    }
    let win = app.get_webview_window("overlay").ok_or("overlay window is missing")?;
    if spec.enabled {
        position_overlay(&win, &spec.corner);
        win.show().map_err(|e| e.to_string())?;
    } else {
        win.hide().map_err(|e| e.to_string())?;
    }
    win.set_ignore_cursor_events(spec.locked).map_err(|e| e.to_string())?;
    Ok(())
}

/* ------------------------------------------------------------------ keychain, idle, power */

const KEYCHAIN_SERVICE: &str = "app.jorcord.desktop";

/// Names the web app may store: a short fixed allow-list so a compromised page cannot use the keychain as general storage.
fn keychain_entry(name: &str) -> Result<keyring::Entry, String> {
    if !matches!(name, "auth" | "accounts") {
        return Err("unknown keychain slot".into());
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|e| e.to_string())
}

/// Store a secret in the OS keychain. The web app falls back to web storage when this errors (no keychain service, locked, ...).
#[tauri::command]
fn secure_set(name: String, value: String) -> Result<(), String> {
    keychain_entry(&name)?.set_password(&value).map_err(|e| e.to_string())
}

/// Read a secret; `None` when nothing is stored.
#[tauri::command]
fn secure_get(name: String) -> Result<Option<String>, String> {
    match keychain_entry(&name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a secret. Idempotent.
#[tauri::command]
fn secure_delete(name: String) -> Result<(), String> {
    match keychain_entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Seconds since the last keyboard or mouse input anywhere on the system, or `None` where the OS offers no cheap way (Linux: the web app then
/// falls back to its own in-window activity tracking).
#[tauri::command]
fn idle_seconds() -> Option<u64> {
    system_idle_seconds()
}

#[cfg(target_os = "windows")]
fn system_idle_seconds() -> Option<u64> {
    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        dw_time: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }
    let mut info = LastInputInfo { cb_size: std::mem::size_of::<LastInputInfo>() as u32, dw_time: 0 };
    // SAFETY: `info` is a valid, correctly sized LASTINPUTINFO and outlives the call.
    unsafe {
        if GetLastInputInfo(&mut info) == 0 {
            return None;
        }
        Some(u64::from(GetTickCount().wrapping_sub(info.dw_time)) / 1000)
    }
}

#[cfg(target_os = "macos")]
fn system_idle_seconds() -> Option<u64> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        // state 1 = kCGEventSourceStateCombinedSessionState, event type u32::MAX = kCGAnyInputEventType
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }
    // SAFETY: plain C call with scalar arguments.
    let s = unsafe { CGEventSourceSecondsSinceLastEventType(1, u32::MAX) };
    if s.is_finite() && s >= 0.0 { Some(s as u64) } else { None }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn system_idle_seconds() -> Option<u64> {
    None
}

/// Resume-from-sleep detection without OS hooks: a ticker whose wall-clock gap is far larger than its sleep means the machine was suspended.
/// Emits `jorcord://power` with `"resume"` so the web app can reconnect and refresh presence. (Suspend itself cannot be observed before it happens.)
fn watch_power(app: AppHandle) {
    std::thread::spawn(move || {
        const TICK: std::time::Duration = std::time::Duration::from_secs(5);
        let mut last = std::time::SystemTime::now();
        loop {
            std::thread::sleep(TICK);
            let now = std::time::SystemTime::now();
            if now.duration_since(last).map(|d| d > TICK * 3).unwrap_or(false) {
                let _ = app.emit("jorcord://power", "resume");
            }
            last = now;
        }
    });
}

pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single instance must be registered first. A second launch (or a jorcord:// link) focuses the first.
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        forward_urls(
            app,
            argv.into_iter().filter(|a| a.starts_with("jorcord://")).collect(),
        );
    }));

    builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_overlay(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().with_denylist(&["overlay"]).build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        // Auto-start is opt-in: the web app calls the autostart plugin enable()/disable() from settings.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            watch_power(handle.clone());

            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let h = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    forward_urls(&h, event.urls().iter().map(|u| u.to_string()).collect());
                });
            }

            let open = MenuItem::with_id(app, "open", "Open Jorcord", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("window icon").clone())
                .tooltip("Jorcord")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = ev
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Started by auto-start with --minimized: stay in the tray.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        // Closing the window hides to tray so calls and notifications keep working. Quit from the tray menu.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![list_running_games, overlay_apply, secure_set, secure_get, secure_delete, idle_seconds])
        .run(tauri::generate_context!())
        .expect("error while running Jorcord");
}
