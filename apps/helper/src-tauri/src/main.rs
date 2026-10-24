#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pairing;

use serde::Serialize;
use std::{
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

const WEBSITE: &str = if cfg!(debug_assertions) {
    "http://localhost:5173/"
} else {
    "https://skill-manager.omarjetti.dev/"
};
type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
struct Helper {
    pending: Mutex<Option<(u64, pairing::Pairing)>>,
    sequence: AtomicU64,
    busy: AtomicBool,
    quitting: AtomicBool,
    tray: AtomicBool,
    error: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    running: bool,
    configured: bool,
    connection: String,
    pending_server: Option<String>,
    pending_id: Option<u64>,
    busy: bool,
    startup: Option<bool>,
    startup_error: Option<String>,
    error: Option<String>,
}

fn runner() -> Result<Command> {
    // Tauri installs external binaries beside the application executable on all desktop targets.
    // Never resolve ahm through PATH or accept executable/argument text from the webview.
    let binary = std::env::current_exe()
        .map_err(|_| "unavailable")?
        .with_file_name(if cfg!(windows) { "ahm.exe" } else { "ahm" });
    let mut command = Command::new(binary);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command)
}

fn execute(args: &[&str]) -> Result<()> {
    let status = runner()?.args(args).status().map_err(|_| "unavailable")?;
    if status.success() {
        Ok(())
    } else if status.code() == Some(6) {
        Err("pendingResults".into())
    } else {
        Err("operationFailed".into())
    }
}

fn worker_status() -> Result<serde_json::Value> {
    let output = runner()?
        .args(["--json", "worker", "--status"])
        .stdout(Stdio::piped())
        .output()
        .map_err(|_| "unavailable")?;
    if !output.status.success() {
        return Err("unavailable".into());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "unavailable".into())
}

fn start() -> Result<()> {
    let status = worker_status()?;
    if status["running"] == true {
        return Ok(());
    }
    if status["configured"] != true {
        return Err("notConnected".into());
    }
    let mut child = runner()?.arg("worker").spawn().map_err(|_| "unavailable")?;
    std::thread::sleep(Duration::from_millis(500));
    if child.try_wait().map_err(|_| "unavailable")?.is_some() {
        return Err("startFailed".into());
    }
    // Reap without killing the worker when the tray hides or its UI crashes.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn reveal(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn remember_error(app: &AppHandle, error: String) {
    *app.state::<Helper>().error.lock().unwrap() = Some(error);
    reveal(app);
}

fn receive_link(app: &AppHandle, link: &str) {
    if matches!(link, "ahm://open" | "ahm://open/") {
        reveal(app);
        return;
    }
    let helper = app.state::<Helper>();
    if helper.busy.load(Ordering::SeqCst) {
        remember_error(app, "busy".into());
        return;
    }
    match pairing::parse(link) {
        Ok(pairing) => {
            let id = helper.sequence.fetch_add(1, Ordering::SeqCst) + 1;
            *helper.pending.lock().unwrap() = Some((id, pairing));
            *helper.error.lock().unwrap() = None;
            reveal(app);
        }
        Err(error) => remember_error(app, error.into()),
    }
}

struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn perform(app: &AppHandle, action: &str, pending_id: Option<u64>) -> Result<()> {
    let helper = app.state::<Helper>();
    if helper.busy.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let _guard = BusyGuard(&helper.busy);
    *helper.error.lock().unwrap() = None;
    match action {
        "start" => start(),
        "stop" => execute(&["worker", "--stop", "--wait"]).map_err(|_| "stillFinishing".into()),
        "quit" => {
            execute(&["worker", "--stop", "--wait"]).map_err(|_| "stillFinishing")?;
            helper.quitting.store(true, Ordering::SeqCst);
            app.exit(0);
            Ok(())
        }
        "connect" => {
            if worker_status()?["pendingResults"].as_u64().unwrap_or(0) > 0 {
                start()?;
                return Err("pendingResults".into());
            }
            let pairing = {
                let pending = helper.pending.lock().unwrap();
                if pending.as_ref().map(|(id, _)| *id) != pending_id || pending_id.is_none() {
                    return Err("changedLink".into());
                }
                pending.as_ref().unwrap().1.clone()
            };
            execute(&["worker", "--stop", "--wait"]).map_err(|_| "stillFinishing")?;
            if let Err(error) = execute(&["connect", &pairing.code, "--server", &pairing.server]) {
                // A cycle can enqueue a result while stopping. Restore the old worker
                // so delivery can finish; never replace its credential or delete its queue.
                if error == "pendingResults" {
                    let _ = start();
                    return Err(error);
                }
                return Err("pairFailed".into());
            }
            *helper.pending.lock().unwrap() = None;
            start()
        }
        _ => Err("invalidAction".into()),
    }
}

fn dispatch(app: AppHandle, action: &'static str) {
    std::thread::spawn(move || {
        if let Err(error) = perform(&app, action, None) {
            remember_error(&app, error);
        }
    });
}

#[tauri::command]
async fn snapshot(app: AppHandle) -> Result<Snapshot> {
    tauri::async_runtime::spawn_blocking(move || {
        let status = worker_status()?;
        let helper = app.state::<Helper>();
        Ok(snapshot_state(
            status,
            &helper,
            app.autolaunch()
                .is_enabled()
                .map_err(|_| "startupFailed".into()),
        ))
    })
    .await
    .map_err(|_| "unavailable")?
}

fn snapshot_state(status: serde_json::Value, helper: &Helper, startup: Result<bool>) -> Snapshot {
    let pending = helper.pending.lock().unwrap();
    let error = helper.error.lock().unwrap().clone();
    let (startup, startup_error) = match startup {
        Ok(enabled) => (Some(enabled), None),
        Err(error) => (None, Some(error)),
    };
    Snapshot {
        running: status["running"] == true,
        configured: status["configured"] == true,
        connection: status["report"]["state"]
            .as_str()
            .unwrap_or("starting")
            .into(),
        pending_server: pending.as_ref().map(|(_, pairing)| pairing.server.clone()),
        pending_id: pending.as_ref().map(|(id, _)| *id),
        busy: helper.busy.load(Ordering::SeqCst),
        startup,
        startup_error,
        error,
    }
}

#[tauri::command]
async fn control(app: AppHandle, action: String, pending_id: Option<u64>) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || perform(&app, &action, pending_id))
        .await
        .map_err(|_| "unavailable")?
}

#[tauri::command]
fn accept_link(app: AppHandle, link: String) -> Result<()> {
    pairing::parse(&link).map_err(String::from)?;
    receive_link(&app, &link);
    Ok(())
}

#[tauri::command]
fn dismiss_pairing(app: AppHandle) {
    *app.state::<Helper>().pending.lock().unwrap() = None;
}

#[tauri::command]
fn set_startup(app: AppHandle, enabled: bool) -> Result<()> {
    let result = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    result.map_err(|_| "startupFailed".into())
}

#[tauri::command]
fn open_website(app: AppHandle, connect: bool) -> Result<()> {
    let mut url = url::Url::parse(WEBSITE).map_err(|_| "browserFailed")?;
    if connect {
        url.set_query(Some("connect=helper"));
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| "browserFailed".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|arg| arg == "--shutdown") {
                dispatch(app.clone(), "quit");
            } else if !args.iter().any(|arg| arg.starts_with("ahm:")) {
                reveal(app);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Skills Hub Helper")
                .arg("--background")
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .manage(Helper::default())
        .invoke_handler(tauri::generate_handler![
            snapshot,
            control,
            accept_link,
            dismiss_pairing,
            set_startup,
            open_website
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let deep_handle = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    receive_link(&deep_handle, url.as_str());
                }
            });
            // Windows/macOS bundles register at install time; Linux AppImage needs runtime registration.
            #[cfg(target_os = "linux")]
            if let Err(_error) = app.deep_link().register_all() {
                remember_error(&handle, "registrationFailed".into());
            }
            let open = MenuItem::with_id(app, "open", "Open helper", true, None::<&str>)?;
            let start = MenuItem::with_id(app, "start", "Start", true, None::<&str>)?;
            let stop =
                MenuItem::with_id(app, "stop", "Stop after current work", true, None::<&str>)?;
            let quit =
                MenuItem::with_id(app, "quit", "Quit after current work", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &start, &stop, &quit])?;
            let tray = TrayIconBuilder::new()
                .tooltip("Skills Hub helper")
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => reveal(app),
                    "start" => dispatch(app.clone(), "start"),
                    "stop" => dispatch(app.clone(), "stop"),
                    "quit" => dispatch(app.clone(), "quit"),
                    _ => (),
                })
                .build(app);
            app.state::<Helper>()
                .tray
                .store(tray.is_ok(), Ordering::SeqCst);
            if tray.is_err() {
                remember_error(&handle, "trayUnavailable".into());
            }
            let urls = app.deep_link().get_current()?.unwrap_or_default();
            for url in &urls {
                receive_link(&handle, url.as_str());
            }
            if std::env::args().any(|arg| arg == "--shutdown") {
                dispatch(handle, "quit");
            } else {
                let background = std::env::args().any(|arg| arg == "--background");
                if !background {
                    reveal(&handle);
                }
                std::thread::spawn(move || {
                    if urls.is_empty() {
                        match worker_status() {
                            Ok(status) if status["configured"] == true => {
                                if let Err(error) = perform(&handle, "start", None) {
                                    remember_error(&handle, error);
                                }
                            }
                            Ok(_) => reveal(&handle),
                            Err(error) => remember_error(&handle, error),
                        }
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.state::<Helper>().tray.load(Ordering::SeqCst) {
                    let _ = window.hide();
                } else {
                    dispatch(window.app_handle().clone(), "quit");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("helper initialization failed")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<Helper>().quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    dispatch(app.clone(), "quit");
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_failure_does_not_hide_pending_pairing_or_core_worker_status() {
        let helper = Helper::default();
        *helper.pending.lock().unwrap() = Some((
            7,
            pairing::parse(
                "ahm://connect?code=abcdefghijklmnop&server=https%3A%2F%2Ftrusted.example",
            )
            .unwrap(),
        ));
        let status =
            serde_json::json!({"configured":true,"running":true,"report":{"state":"connected"}});
        let snapshot = snapshot_state(status.clone(), &helper, Err("startupFailed".into()));
        assert!(snapshot.running && snapshot.configured);
        assert_eq!(snapshot.pending_id, Some(7));
        assert_eq!(
            snapshot.pending_server.as_deref(),
            Some("https://trusted.example")
        );
        assert_eq!(snapshot.startup, None);
        assert_eq!(snapshot.startup_error.as_deref(), Some("startupFailed"));
        assert!(snapshot.error.is_none());
        let recovered = snapshot_state(status, &helper, Ok(true));
        assert_eq!(recovered.startup, Some(true));
        assert!(recovered.startup_error.is_none());
        assert_eq!(recovered.pending_id, Some(7));
    }
}
