# Contributing

Thanks for contributing to Agent Harness Manager.

## Development requirements

- Node.js 20 or newer
- Rust stable
- PostgreSQL 16 or newer for control-plane integration work

## Run locally

```bash
npm install
npm run dev:control-plane
```

Start `npm run dev` in another terminal. Install the local CLI with `cargo install --path crates/ahm-runner --locked` when testing a real browser-to-runner flow.

## Before submitting

Run the complete gate:

```bash
npm run check
```

Keep changes scoped, preserve the browser/control-plane/runner dependency boundaries, and include screenshots or a short recording for visible UI changes. Tests that touch project files must use temporary directories and preserve unmanaged content.

## Reporting issues

Include the operating system, `ahm --version`, reproduction steps, expected and actual behavior, and redacted logs. Never include credentials or private project paths.
