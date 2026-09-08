# Canonical artifact identity

Artifact digest v1 is SHA-256 over these bytes:

1. UTF-8 `AHM-ARTIFACT-V1` followed by a zero byte.
2. All entries sorted by their UTF-8 path bytes (not locale order).
3. Each entry: ASCII `D` or `F`, unsigned 64-bit big-endian path byte length, then UTF-8 path.
4. Files additionally contain unsigned 64-bit big-endian content byte length, then exact content bytes.

Paths are relative, use `/`, and have no empty, dot, parent, `.git`, control-character, backslash, or colon segments. Names must round-trip as UTF-8. The root is implicit; all other directories, including empty directories, are explicit. Symlinks and special files inside an artifact are unsupported. Scan snapshots exclude `.git`; other files, including `.gitignore`, participate in identity. Modification times and file permissions are not represented by the current bundle contract.

The control plane validates entry structure, unique paths, explicit directory parents, content limits, canonical base64, and digest before publication. The runner independently verifies downloaded content before using it. Shared golden data is in `packages/contracts/fixtures/artifacts/canonical-v1.json`.

This replaces the POC's unframed platform-dependent directory hash. Existing POC scans, snapshots, and plans must be recreated with fresh disposable state. There is no legacy digest fallback and no automatic deletion of user data.
