# Master Plan — Hard fork → Rebrand → Phase 1 encryption build

Status: blocked on app-name decision (Track A1).

## Context

- Current product = "Gutter v1" (this fork's main, including all post-fork additions). Last public release of v1 stays in current repo as historical artifact.
- New product = v2 of a new app, encryption-first markdown editor. New name TBD. Lives in a **new GitHub repo** (not a rename).
- New bundle ID: `com.objectsconsulting.<NEWNAME>`.
- No config migration from Gutter v1 → v2. Clean slate.
- Non-technical rebrand work (PR, social, copy strategy) runs in parallel; not blocking the engineering plan.

## Track A — Stable v1 archive + new-repo bootstrap + restructure

Sequential. Must complete before encryption work begins on Track B.

- **A0 — Final v1 release in current repo.** Tag `v1.0.0` (or whatever final version reflects current state). Cut GitHub release with all platform binaries via existing release workflow. Update README + site/index.html to mark this as "Gutter v1, the legacy single-binary editor." No further development on this repo after A0.
- **A1 — App name decision.** BLOCKING. Drives A2–A5. Domain check, GitHub repo name, bundle ID suffix.
- **A2 — Bootstrap new repo.** New GitHub repo under user's control. Copy current codebase as initial commit. Update `package.json` name + version=2.0.0-alpha, `tauri.conf.json` productName + identifier=`com.objectsconsulting.<NEWNAME>`, `Cargo.toml` package names, source-code "gutter" string references (display + comments), config path `~/.gutter/` → `~/.<newname>/`. No migration shim. Rename `gutter/` subdirectory to `app/` (or `<newname>/`).
- **A3 — Repo hygiene.** New README (encryption-first markdown editor, encryption shipping in v2.1). Fresh CHANGELOG starting at v2.0.0 with "forked from gutter v1.x" note. New site/index.html (or fork-and-rebrand of existing one).
- **A4 — Cargo workspace conversion.** Single Cargo project → workspace at repo root. Move existing Tauri Rust under `app/src-tauri/`. Empty `crates/` dir created. Verify `npm run tauri dev` still launches.
- **A5 — Cut v2.0.0 release of rebranded product (no encryption yet).** Verifies release pipeline works under new identity before encryption complexity layers on.

## Track B — Encryption Phase 1

Branch: `feature/encryption-phase-1` off post-A5 main of new repo. Each phase ends with hands-on macOS verification.

- **B1 — `emd-format` library core.** Types, AEAD wrap (XChaCha20-Poly1305), Argon2id, header MAC, body zstd. KAT vectors. No GUI/Tauri.
- **B2 — Parser hardening.** All 5 bounds. Negative-test corpus (malformed headers, oversized claims, zip-bombs).
- **B3 — Tauri commands.** `encrypt_file`, `decrypt_file`, `verify_emd_structure`. Invoked via dev console; no UI binding yet.
- **B4 — GUI vertical slice.** Typed-passphrase modal → encrypt this file → save as `.emd` → close → reopen → prompt → unlock → edit → save. Strict write order + verify roundtrip. **First user-visible milestone — locks core flow.** No address book, no biometric, no settings refactor.
- **B5 — Lock icon (3 states) + per-file lock action.** Plaintext / unlocked / locked. Click behaviors per spec.
- **B6 — Comments bundled inside `.emd` body.** Sidecars stay external for `.md`. Body schema with version field.
- **B7 — History disabled for `.emd`.** Panel shows large-font notice. `useSaveHandler` skips snapshot for `.emd`.
- **B8 — Cache modes (None / One / All).** Strict per-file binding for None.
- **B9 — Settings panel refactor.** Top-right popover → centered tabbed modal. Existing tabs moved as-is. New General + Encryption tabs (skeleton; populate as features land).
- **B10 — Named passphrases.** Address-book CRUD, folder claims, default selection, Diceware generator, strength requirements.
- **B11 — macOS Keychain + Touch ID.** Phase-1 platform; Win/Linux toggle disabled.
- **B12 — `emd-cli` binary.** `encrypt` / `decrypt` / `info` / bulk. Built from `emd-format` library — same code, two consumers.
- **B13 — Hot-reload for `.emd`.** Composite hash (plaintext + header MAC). Drop self-suppression windows. Read-before-write etag.
- **B14 — Autosave for `.emd`.** Unified setting; 30s default; no per-format split.
- **B15 — Danger zone — find orphaned plaintext companions.** Manual cleanup tool.
- **B16 — Help tab content.** Encryption Q&A entries per spec.
- **B17 — Hardening pass.** Memory hygiene (mlock, RLIMIT_MEMLOCK, RLIMIT_CORE=0), zeroize, secrecy crate. Final review against `known_issues.md` to confirm no scope creep.

## Track C — Ship

- **C1 — macOS release of Phase 1 (v2.1.0).** Lock design via real use.
- **C2 — Bug-fix iteration.** Hands-on; surface UX papercuts.
- **C3 — Port to Windows + Linux.**
- **C4 — Cross-platform v2.1.x release.**

## Branch + flag strategy

- Track A on `main` of new repo. Each phase its own commit; A5 is the public release boundary.
- Track B on `feature/encryption-phase-1`. Rebase against main weekly. Merge to main only when B17 is complete and v2.1.0 is shippable.
- No build-time feature flag — branch-level isolation handles it.

## Open items (resolve as we go)

- **A0 final v1 version number** — last commit on current repo. Pick concrete number when cutting A0.
- **Old "Gutter" releases** — keep visible in current repo indefinitely, or hide / move to a `*-legacy` archive repo? Default: keep visible. Decide before A0.
- **App name (A1)** — only blocker for everything below.
