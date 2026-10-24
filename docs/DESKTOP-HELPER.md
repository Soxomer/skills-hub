# Skills Hub desktop helper

The product has four runtime boundaries: the browser UI, the Tauri helper, the Rust worker, and the API backed by PostgreSQL. The helper and worker ship in one installer. The helper owns only pairing, tray/window controls, sign-in startup and process lifecycle. All project and skill operations remain in `ahm`; the helper does not link the runner crate or expose generic shell/filesystem commands to its webview.

## User experience

- Browse, search and preview skills on the web without installing the helper.
- Selecting Install while disconnected opens **Set up this computer**, preserving the selected source (including a preview's pinned revision). The first step offers the platform installer; the user can choose Windows x64, macOS Apple silicon/Intel or Linux x64.
- After installation, **I have installed the helper → Open Skills Hub helper** prepares enrollment automatically. The helper shows the workspace origin and requires an explicit Connect. Arriving from the installed app skips the download step. Codes and CLI instructions stay in Connection help.
- The browser only offers Continue once the worker reports with library capability. Continue resumes the selected install. Cancelling returns to browsing. A pending skill selection survives reload in session storage, but requires another user action before executing.
- On first launch without a saved connection, the helper offers **Connect to Skills Hub**, opening the website's connection flow. After pairing it runs the worker, offers Return to Skills Hub, and retains the connection across restarts. Startup at sign-in is opt-in on every OS.
- Closing the helper hides it in the tray. Pause/Quit let the current worker cycle finish. The worker retries transient network failures. If the tray cannot be created, the window remains the control surface and closing it requests a graceful quit.

The browser cannot reliably detect a registered protocol handler, so “installed” is an explicit user step, never a claim that the computer is connected. Browser OS detection only chooses a default download; it cannot reliably distinguish Apple silicon from Intel. Both macOS choices remain available.

## Native boundaries

The Tauri frontend is bundled local content with a restrictive CSP and no remote-origin capability. Custom Rust commands accept bounded lifecycle actions, not arbitrary executables or command lines. The colocated `ahm` is invoked directly without a shell. Pairing accepts exactly one bounded code and one HTTPS origin, or HTTP on `localhost`, `127.0.0.1`, or `[::1]` for a workspace on the same computer. Local origins may include a port; remote HTTP and remote nonstandard ports remain rejected. Duplicate/extra parameters and credentials are rejected, and codes stay out of snapshots and logs. A confirmation is bound to the pending request ID, preventing a replacement link from silently changing the confirmed request.

Single-instance and deep-link plugins deliver links to the existing helper, including the platform-specific macOS event flow. Autostart uses the Tauri plugin's native implementation with `--background`. First launch stays visible; subsequent sign-in startup uses the saved connection.

The runner owns an OS file lock beside its SQLite state. Duplicate workers and reconnecting during work are rejected. Stop/Quit request a stop at the cycle boundary, with a 60-second wait; timeout leaves the operation intact. Worker children are reaped normally and are not killed when the window hides. `worker --status` exposes only lifecycle status and whether an identity exists, never the credential.

## Development and packaging

Install the [Tauri desktop prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. Linux builds require WebKitGTK 4.1 and AppIndicator development packages. Windows uses WebView2; the NSIS installer handles installation if missing. There is no C# or .NET build/runtime requirement.

```sh
npm ci
npm run build:runner
node scripts/prepare-helper.mjs --local
npm run helper:dev
```

`npm run check` builds and checks all four runtimes. Tauri and its plugins are scoped to `apps/helper`; the browser and runner boundary checks still forbid Tauri imports. Product versions include both the helper manifests and Tauri configuration.

Release CI builds the runner for each target, prepares its target-suffixed sidecar, and bundles the helper:

| Target | Artifact |
| --- | --- |
| Windows x64 | `ahm-windows-x64-setup.exe` (per-user NSIS) |
| macOS Apple silicon | `ahm-macos-arm64.dmg` |
| macOS Intel | `ahm-macos-x64.dmg` |
| Linux x64 | `ahm-linux-x64.deb` |

Each artifact contains the corresponding runner; users do not need Cargo or a source checkout. Windows release binaries statically link the MSVC runtime. Manual release workflow dispatch builds artifacts; only version tags publish a release.

Override the hosted installer defaults with these web environment variables **only after assets are published**: `VITE_HELPER_WINDOWS_URL`, `VITE_HELPER_MAC_ARM_URL`, `VITE_HELPER_MAC_INTEL_URL`, `VITE_HELPER_LINUX_URL`. Values must be HTTPS URLs. An explicitly invalid override shows installer unavailability instead of a broken download. `VITE_RUNNER_INSTALLER_URL` remains the existing Windows setting fallback.

Without overrides, hosted web builds use the published v0.10.0 installer assets. Local Vite development instead offers only a native debug installer matching the current workspace version. Build it with `npm run build:runner`, `node scripts/prepare-helper.mjs --local`, and `npm run tauri --workspace @ahm/helper -- build --debug --bundles nsis` on Windows (`dmg` on macOS, `deb` on Linux). Vite serves the matching bundle through a fixed development-only download route; older local bundles and the older hosted installer are not offered for a local workspace. Debug helpers return to `http://localhost:5173/`; release helpers open the hosted website. No tunnel is required for loopback pairing.

## Verification and release limits

Automated coverage includes malformed/deceptive pairing links, fresh and saved runner state, lifecycle exclusivity, reconnect after outage, stop during a held claim, browser onboarding cancellation/expiry/heartbeat gating, and resuming the exact skill selection with the connected client. CI compiles/tests the Rust workspace on Windows/macOS/Linux. Windows CI installs/upgrades/uninstalls a debug bundle in a disposable account and verifies protocol quoting and preservation of user data. NSIS hooks stop the worker before installer process handling; uninstall removes its sign-in entry while an upgrade preserves it.

Signing/notarization credentials and automatic updates are not configured. Do not describe these draft artifacts as signed or production-ready. Before publishing, validate installed first launch, OS browser handoff, connection, a skill operation, sign-in startup and Quit on each supported desktop. Linux tray support depends on the desktop environment. macOS drag-to-Trash and Linux package removal are OS actions rather than a coordinated helper shutdown: quit from the helper before replacing/removing the app, and disable its opt-in startup entry before removal. Skills, project files and runner databases remain outside the application bundle.
