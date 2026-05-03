# Known issues

Limitations and partially-mitigated risks accepted in the current scope, with planned follow-up. Each entry: brief risk description + scope/impact + planned phase to address.

---

## JS-side passphrase residue (Phase 1, accepted)

**Risk:** when the user types a passphrase into the GUI, the value briefly exists as a V8/JavaScriptCore string in the webview heap before being passed to the Rust backend via Tauri IPC. JavaScript strings are immutable and garbage-collected on an unpredictable schedule, so the secret remains reachable in webview memory for a few seconds (or longer under low memory pressure) even after the app has dropped its reference. An attacker with devtools access, a heap-dump tool, or a successfully-injected webview script (e.g. via XSS in rendered markdown) could observe the passphrase during this window.

**Phase 1 mitigation:** drop JS reference immediately after the IPC resolves; never store passphrase in any persistent JS state (no Zustand, no localStorage, no useState across renders); single function-local variable scope. This minimizes the residue window but does not eliminate it.

**Phase 2 plan:** see "Tauri binary IPC for secret transport" entry below.

---

## Plaintext content residue in JS + memory (Phase 1, accepted)

**Risk:** decrypted markdown body (and comment sidecars) lives in JS state — Zustand store, ProseMirror editor state, React component state. JavaScript memory cannot be reliably zeroized (immutable strings, unpredictable GC). The plaintext also exists as a Rust-side `Vec<u8>` between decryption and IPC return. Both copies can be paged to disk by the OS (swap, macOS hibernation file, Linux swap partition) without our knowledge, where they outlive the running session. An attacker with later disk access could find plaintext content even from files that were cleanly closed.

**Phase 1 mitigation: NONE for the plaintext content itself.** Keys, passphrases, and CEKs are protected (zeroize + secrecy + mlock + RLIMIT_CORE=0 in Rust), but plaintext markdown is not. The editor needs constant random-access reads, and JS-side mlock is impossible. Encrypting the running plaintext buffer would require restructuring so plaintext stays in Rust and JS sees only rendered fragments — out of scope for Phase 1.

**Phase 2 plan:** investigate hybrid options — keep plaintext primarily in Rust, expose render-only views to JS. May couple with the "Tauri binary IPC" plumbing below to make this practical. Pure-Rust frontend (egui / iced / Floem) would solve this fully but requires throwing away the React editor — a 6-12 month rewrite that loses all current editor features. Not on the critical path.

---

## Tauri binary IPC for secret transport (Phase 2 enhancement, not blocking)

**Context:** Tauri's standard `invoke()` IPC serializes arguments via JSON, which means any byte buffer (passphrase, plaintext) passed JS → Rust crosses as a JSON-encoded string. JSON-encoded strings are V8 strings — same immutability and GC issues as the source string. So even if the source `Uint8Array` on the JS side is zeroed after the call, the JSON-encoded copy lingers in the V8 heap.

**Tauri 2 has a binary channel API** that bypasses JSON serialization — JS can send a `Uint8Array` and Rust receives it as `Vec<u8>` directly. The `Uint8Array` can be `fill(0)`'d after the call, materially shrinking JS-side residue.

**Phase 2 plan:** plumb the passphrase entry path AND the plaintext-content path through binary IPC channels. Replace the JSON-string transport with `Uint8Array` for any secret-bearing payload. Combined with the "drop reference + zero" pattern already in Phase 1, this would reduce the JS residue window from "until next GC" to "until the JS event loop yields after `fill(0)`" — orders of magnitude shorter.

**Why this isn't Phase 1:** the standard `invoke()` flow is what the existing app and Tauri tooling use everywhere. Binary channels require custom plumbing (channel registration, type-marshaling) and we'd want to scope out the API surface before depending on it. Enhancement, not bug fix.

---

## Local version history disabled for encrypted files (Phase 1, accepted)

**Risk being avoided:** the existing local snapshot history feature writes plaintext markdown to `~/.gutter/history/{path_hash}/{timestamp}.md` on every save (`useSaveHandler.ts` + `commands/history.rs`). Without intervention, encrypting a file would leave its previous plaintext versions sitting next to the encrypted version on the same disk — silently undermining the encryption-at-rest the user just opted into.

**Phase 1 mitigation:** when saving an `.emd` file, skip the local history snapshot write entirely. Plain `.md` files continue to get history snapshots as before. The editor's History side panel shows a large-font notice when opened on an encrypted file, explaining that history is disabled and pointing to the Help → "Why version history doesn't work on encrypted files" entry.

**Trade-off accepted:** users editing encrypted files lose the local version-history timeline. They can still recover via external version history (Dropbox/iCloud/syncthing version retention, git commits) — they're not entirely without recovery, just without the in-app local timeline.

**Phase 2 plan:** restore the feature by storing snapshots as separate encrypted `.emd`-format files in `~/.gutter/history/`, each encrypted with the parent file's passphrase. Same path-hash directory layout as today, just per-snapshot encryption. Avoids both the leak and the write-amplification problem of bundling history into the file body.

---

## Markdown input rules are typing-direction-dependent

**Limit:** typing inline markdown syntax in right-to-left order doesn't pick up. Concrete repro: type `Dawm**` first, then prepend `**` before "Dawm" → result is plain text `**Dawm**`, not bold. Typing left-to-right (`**Dawm**` in order) works correctly.

**Why:** ProseMirror's `markInputRule` (and TipTap's StarterKit wrapper around it) only fires on *text-insert* events, with the regex anchored at the end of the inserted text (`...$`). When the user types the closing `**` first, no opening `**` exists yet — no match. When the user later prepends the opening `**`, the cursor is right after the prepended characters; the text-before-cursor is just `**`, not the full `**X**` pattern → no match. The input-rules system does not scan the document for completed patterns regardless of typing direction.

**Workaround for users:** type left-to-right, OR select the word and use Cmd+B / right-click → Bold. The toolbar/menu path bypasses input rules and applies the mark directly via `toggleBold()`.

**Why this isn't fixed:** the workaround is reliable, the limit is shared by most WYSIWYG markdown editors (Typora, Obsidian source mode, Notion, Milkdown), and a custom pattern-scanner that runs on every text input has cost (input-rule conflicts, performance) without changing what most users actually do (left-to-right typing). If an active-line redesign happens (see `docs/backlog.md` "Line-reveal widget UX trap"), a pattern-scanner becomes natural to add at that point.

---

## Plaintext residue on interrupted conversion (Phase 1, accepted)

**Risk:** the conversion between 3 plaintext files (`notes.md` + `notes.comments.json` + `notes.comments.md`) and 1 encrypted file (`notes.emd`) is not atomic on POSIX/NTFS/APFS — there is no syscall for deleting N files atomically. The Phase 1 design uses strict write ordering: the encrypted target is written, fsync'd, and verified by round-trip decrypt before any plaintext is deleted. But the deletion step itself is sequential, and a process death (crash, kill, power loss) between "target verified" and "all companions deleted" leaves both states on disk. The encrypted file is correct; the plaintext companions are correct; but encryption-at-rest has been silently undermined for those companions until the user notices and removes them.

**Phase 1 mitigation:** strict write order guarantees that plaintext is never deleted *until after* the encrypted target is durable and round-trip-verified — so the user can never lose data, only have it linger. A manual *"Find orphaned plaintext companions"* action in Encryption settings → Danger zone lets the user scan and clean up. There is no automatic recovery scan on startup.

**Why no journal:** an earlier draft used an SQLite-style marker journal with a startup-scan recovery pass. Two reviewers independently flagged that its post-commit rollback semantics could destroy the only complete copy of the user's data on certain crash timings — strictly worse than the no-journal approach. Cross-app research found that GnuPG specifically *removed* their auto-delete-after-encrypt feature after similar data-loss bugs (https://dev.gnupg.org/T3506); age leaves plaintext lifecycle to the user explicitly. We follow that documented stance.

**Phase 2 candidates** (both worth investigating; pick after Phase 1 user feedback):
- **(ii) Marker-journal approach** — revisit a marker-file + recovery-scan design if real-world reports show interrupted conversions happen often enough to matter. The earlier draft's bug was the rollback direction, not the journal concept itself; a corrected design (roll forward from the verified-target commit point, with a per-input deletion progress flag) is implementable. Trade-off: more code, more startup-time overhead, but proactive cleanup.
- **(iii) Cryptomator-style architecture** — investigate moving to a model where plaintext never touches disk: in-memory only, virtual-filesystem overlay, or all-state-in-encrypted-DB. Eliminates the residue class entirely. Trade-off: significantly larger architectural change, breaks the "encrypted file sits next to plaintext files in any folder" UX that motivates the 3↔1 model in Phase 1.
