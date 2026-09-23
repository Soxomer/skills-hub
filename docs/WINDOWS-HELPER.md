# Windows helper delivery

OMA-237 adds a per-user Windows launcher for the existing Rust runner. The browser remains the product UI; the small .NET Framework notification-area helper handles pairing and local Start/Stop. It does not execute project operations or expose an HTTP listener. No Tauri runtime is introduced.

## User flow

1. Install `ahm-windows-x64-setup.exe` on the computer containing the skills. No Rust, Cargo, Git CLI, source checkout or administrator account is required.
2. Choose **Connect this computer** on the website, then **Open helper to connect**. Confirm the displayed HTTPS server in the helper. Browsers may ask permission to open the registered `ahm:` protocol. If blocked, open the helper from Start and paste the website's connection link.
3. Pairing starts the worker without a terminal. The single-use code expires after ten minutes; the stored credential does not expire on that timer. Expired/reused codes require a new browser enrollment.
4. Open the helper from Start or its notification-area icon to see connected/offline/stopped state, Start/Stop, and an explicit opt-in **Start helper when I sign in** checkbox. Network errors retry automatically.
5. Stop waits for the current poll/job cycle. Quit, update and uninstall also request a graceful stop; if work takes more than 60 seconds, they leave it intact and ask the user to retry. Closing the helper window hides it in the notification area.

The website cannot reliably detect whether an OS protocol handler is installed. It shows recovery instructions and only reports a connection when the control plane observes enrollment/worker activity. Browser offline status cannot distinguish a stopped machine from lost connectivity; the local helper can.

## Local lifecycle

All worker invocations take an OS file lock beside their runner state (`runner.worker/lock` for the default `runner.db`). A second worker and re-enrollment are rejected while that lock is held. `worker --stop` requests a stop at the cycle boundary; `worker --stop --wait` waits at most 60 seconds, and `worker --status` reports lock-backed liveness plus the last local connection state. A crash releases the OS lock, so stale status cannot claim that the worker is still running.

The helper delegates to the colocated `ahm.exe`, passing arguments directly without a shell. Connection links accept exactly one bounded code and one HTTPS origin; credentials, path components, extra arguments and duplicate parameters are rejected. Pairing requires a local confirmation and stops the existing worker first. The helper never displays or persists raw enrollment output. CLI arguments contain the short-lived pairing code, never the established credential. Local users with access to the account can still inspect process arguments.

Skills, projects, library state and runner credentials remain outside the application installation folder and are preserved by update/uninstall. Uninstall removes the helper's protocol handler, Start menu shortcut and sign-in entry. Credential revocation remains an explicit account action, not a side effect of uninstall.

## Build and publish

Build requirements: Windows x64, Rust, .NET Framework 4.8 reference assemblies and Inno Setup 6. Normal Windows 10/11 installations provide the .NET Framework runtime; the build does not require a separately deployed .NET SDK/runtime bundle.

```powershell
cargo build --locked --release -p ahm-runner --bin ahm
./scripts/test-windows-helper.ps1
./scripts/build-windows-helper.ps1
```

Output: `target/release-assets/ahm-windows-x64-setup.exe`. Override `-Iscc` to select an existing compiler or `-Runner` to supply a target-specific CLI build. `-HelperOnly` compiles the launcher without building an installer.

Windows CI builds a **test installer with a debug CLI** for acceptance, runs native pairing validation and the real CLI lifecycle test. Release CI packages an optimized CLI and publishes the installer alongside existing platform archives only for a version tag. Manual workflow dispatch builds artifacts without creating a release named after a branch.

After the release asset exists, set `VITE_RUNNER_INSTALLER_URL` to its HTTPS URL in the web deployment and rebuild. Until then the UI does not advertise a broken download. The installer is unsigned unless a release operator adds signing with a trusted certificate; do not claim publisher verification or bypass Windows warnings.

## Acceptance evidence and remaining release gate

Local checks cover native deep-link parsing, actual CLI pairing with a disposable HTTP server, exclusive worker ownership, rejected re-enrollment while active, network outage/reconnect, stop during an in-flight poll, restart with the saved credential, and preservation of unrelated files. `scripts/test-worker-lifecycle.mjs` isolates home, library and runner state.

Browser verification uses the actual connection component with a synthetic enrollment at desktop and mobile sizes; this does not prove the OS handoff. Before marking OMA-237 Done, verify the packaged installer on a Windows account without Rust/Cargo: install, hosted pairing, preview/authorized skill operation, Stop/Start, expired pairing, sign-in startup on/off, upgrade and uninstall preserving populated skills/projects. Publish the release and configure the download only after those checks pass. Retain this distinction in Linear and PR validation.
