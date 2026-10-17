use std::collections::BTreeSet;
use std::sync::OnceLock;
use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;

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
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        // Auto-start is opt-in: the web app calls the autostart plugin enable()/disable() from settings.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            let handle = app.handle().clone();

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
        .invoke_handler(tauri::generate_handler![list_running_games])
        .run(tauri::generate_context!())
        .expect("error while running Jorcord");
}
