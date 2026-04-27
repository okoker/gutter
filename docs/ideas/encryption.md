# Encryption — locked-in decisions

Status: design in progress. Only items below are decided. Everything else is open.

## Scope & modes

- **Scope of encryption:** user's `.md` content files only. App source code is not affected.
- **Two operating modes**:
  - **Solo** — single passphrase, one user, no sharing. Phase 1 ships this.
  - **Multi-party** — multiple parties can decrypt the same file. Phase 2.
- **Granularity:** per-file only. No workspace-wide or per-folder encryption. Encrypted and plaintext files sit side-by-side. Use case: keep a private `roadmap.emd` in an otherwise-public repo without `.gitignore` gymnastics.
- **Bulk operations** (later phase, UI affordance only — no architectural change): "Encrypt all files in this folder/workspace" and "Decrypt all" iterate the per-file primitive with a progress bar. Same code path as a single-file encrypt, just looped.
- **App-global setting — Default new file format** (2 options, no per-workspace scope):
  - **Unencrypted (.md)** (default) — new files start as plain markdown; user clicks the lock icon to encrypt individual files.
  - **Encrypted (.emd)** — new files default to encrypted; user can still individually decrypt specific files via the right-click menu. (Renamed from "Required" — the old name overpromised; this setting is a default, not enforcement.)
- **Per-file UI:** lock icon always visible in the editor title area; reflects the file's actual encryption state in a 3-state model — plain (grey lock), encrypted-unlocked (prominent open lock), encrypted-locked (prominent closed lock). Click behaviors for each state are defined in "Per-file lock-icon click behaviors" below.
- **Tab visual treatment:** encrypted file tabs use a different background color from plaintext tabs in the tab bar — visual at-a-glance signal of which open files are encrypted.

## Phased build

- **Phase 1 — Solo, Tier 1.** Per-file passphrase. One person decrypts. No identity / signing / recipient list management. Ship this first as fully working.
- **Phase 2 — Multi-party, Tier 3+4 or Tier 5** (decision deferred). Adds multiple recipients and identity attribution. Must NOT require rewriting Phase 1 code or a file-format break.
- **No recovery feature.** Intentional. Lost passphrase = lost file. Avoids second-credential complexity and attack surface.

## Architectural constraint

- **Single file format from day 1, designed to grow.** The header carries a length-prefixed recipient list and a length-prefixed author block. In Phase 1 these have one passphrase entry and zero authors; in Phase 2 they fill in. Same parser, same on-disk shape.
- **Same file extension** for solo and multi-party. Mode is derived from header contents, not extension.
- **Cargo workspace with separate library + two binaries:**
  - `crates/emd-format/` — library crate. Crypto + `.emd` file format. No GUI deps.
  - `crates/emd-cli/` — CLI binary. Thin wrapper, headless, ~400 LOC.
  - `src-tauri/` — Tauri GUI binary.
  - Both binaries depend on `emd-format`. Same code, two consumers.

## CLI binary (Phase 1, ships alongside GUI)

- **Headless, standalone.** No GUI, webview, or display deps. Runs in CI / Docker / on a server.
- **Distribution: bundled with GUI install (a) + standalone tarballs on releases (b).** Headless users grab `emd-{platform}.tar.gz`, GUI users get the `.dmg` / `.exe` / `.AppImage` which includes the CLI inside.
- **Surface (small, focused):**
  - `emd encrypt FILE [-o OUT] [--passphrase-stdin]` — text-only input (UTF-8 valid, no null bytes in first 4 KB, size ≤ overall cap). Errors with "emd only encrypts text/markdown files; use a general-purpose tool like age for arbitrary binaries" if input fails the text check. Same heuristic as `snippets.rs`.
  - `emd decrypt FILE [-o OUT] [--passphrase-stdin]` — requires `EMD\0` magic; otherwise errors "not an encrypted file."
  - `emd info FILE` — header inspection (recipient list, KDF params, algo IDs); never decrypts; safe to share output publicly. Also serves as the "structural sanity / is this a valid .emd?" check (exits non-zero if malformed).
  - `emd encrypt -r DIR --pattern '*.md'` — bulk; per-file text check; skip-with-warning on non-text files (don't abort the whole run); requires `--yes` to skip confirmation.
  - `emd decrypt -r DIR --pattern '*.emd'` — bulk; requires `--yes` to skip confirmation.
- **Security defaults:**
  - Interactive no-echo passphrase prompt by default.
  - `--passphrase-stdin` for piping.
  - **Never** `--passphrase=ARG` — argv is visible to other processes via `/proc/<pid>/cmdline`. Refuse this footgun.
  - Atomic writes (temp + fsync + rename + dir-fsync) — same as GUI.
  - Exit codes: 0 success, 1 wrong passphrase, 2 file I/O error, 3 format error.
- **Limitations vs GUI:**
  - No Touch ID / Keychain integration (CLI has no GUI session).
  - No persistent passphrase cache across invocations (each command is independent — no daemon mode in Phase 1).
- **Why this is in Phase 1, not deferred:** the marginal cost is small (~400 LOC + CI step), and having two consumers of the library catches format/API design problems early. CLI also serves as the data-recovery escape hatch if the GUI ever has a bug that prevents launch.

## File format — byte layout (Phase 1)

All multi-byte integers are little-endian. Every length-prefix is the smallest type that fits the maximum value the field could legitimately hold.

```
┌─────────────────────────────────────────────────────────────────┐
│ HEADER                                                           │
├─────────────────────────────────────────────────────────────────┤
│  4 B   magic            "EMD\0"  (0x45 0x4D 0x44 0x00)           │
│  1 B   version          0x01                                     │
│  1 B   flags            reserved bitfield (0x00 in Phase 1)      │
│  1 B   aead_id          0x01 = XChaCha20-Poly1305                │
│  1 B   comp_id          0x01 = zstd                              │
│  2 B   recipient_count  u16 LE — Phase 1: always 1               │
│  for each recipient (variable-length entry):                     │
│    1 B   type           0x01 = passphrase                        │
│                         0x02 = X25519 pubkey (Phase 2)           │
│                         0x03 = YubiKey-PIV (Phase 2)             │
│    [type-specific entry body — see below]                        │
│  2 B   author_count     u16 LE — Phase 1: always 0               │
│  for each author (Phase 2):                                      │
│    [author entry — format TBD in Phase 2]                        │
│  32 B  header_mac       HMAC-SHA256 over all header bytes above  │
│                         (key = HKDF-Expand(CEK,                  │
│                                  info="emd-header-mac-v1", L=32))│
├─────────────────────────────────────────────────────────────────┤
│ BODY                                                             │
│  1 B   body_nonce_len   24 (for XChaCha20-Poly1305)              │
│  24 B  body_nonce       random per save                          │
│  ...   body_ct + tag    AEAD encrypt(CEK, body_nonce,            │
│                                      zstd(structured_payload),   │
│                                      AAD=empty)                  │
│                         extends to EOF                           │
└─────────────────────────────────────────────────────────────────┘
```

### Recipient entry — `type=0x01` passphrase

```
[u8  type]                              = 0x01
[u8  label_len][label_bytes]            ← UTF-8, ≤255 bytes
[u8  salt_len][salt_bytes]              ← Argon2id salt, 16 bytes
[u32 LE kdf_mem_kib]                    ← Argon2id memory (KiB)
[u32 LE kdf_iters]                      ← Argon2id iterations
[u8  kdf_parallelism]                   ← Argon2id parallelism (lanes)
[u8  wrap_nonce_len][wrap_nonce_bytes]  ← XChaCha20 nonce, 24 bytes
[u16 LE wrapped_cek_len][wrapped_cek]   ← 48 bytes (32 CEK + 16 AEAD tag)
```

**Wrap operation:**
```
CEK            = 32 random bytes (CSPRNG)
wrapping_key   = Argon2id(passphrase, salt, mem, iters, parallelism, out_len=32)
wrapped_cek    = XChaCha20-Poly1305_encrypt(
                   key       = wrapping_key,
                   nonce     = wrap_nonce (24 random bytes per wrap),
                   plaintext = CEK (32 bytes),
                   aad       = empty
                 )
               → 48 bytes (32 ciphertext + 16 tag)
```

**Unwrap:** reverse — Argon2id(passphrase, salt, …) → wrapping_key → AEAD-decrypt wrapped_cek → CEK.

### Body payload schema (after AEAD decrypt + zstd decompress)

```
[u32 LE body_schema_version]      ← 0x00000001 in Phase 1
[u32 LE markdown_len][markdown bytes]            ← always present
[u32 LE comments_json_len][comments_json bytes]  ← 0 means no comments
[u32 LE comments_md_len][comments_md bytes]      ← 0 means no companion
```

### Header MAC (age-style, per issue #1 lockdown)

- `mac_key = HKDF-Expand(IKM=CEK, info="emd-header-mac-v1", L=32)`
- `header_mac = HMAC-SHA256(key=mac_key, data=all header bytes from magic up to (but not including) the header_mac field itself)`
- Verified before any other header data is trusted on decrypt.

### Implementation requirement — verify BOTH MAC and AEAD, in order

Decryption MUST proceed in this exact order, refusing to use any data until both checks pass:

1. Parse header structure (magic, version, algo IDs, recipient list, MAC field).
2. Unwrap CEK from a recipient entry using the user-provided passphrase.
3. **Verify header MAC** with `HKDF-Expand(CEK)` — abort if MAC fails.
4. **Verify + decrypt body AEAD** with the same CEK — abort if AEAD tag fails.
5. Decompress + parse body payload.

Skipping the header MAC step ("just trust the header and try the body") would let an attacker tamper with header fields (KDF params, recipient list metadata) undetected even though body AEAD still fails. The chain via CEK ties header and body together; both checks are required to defeat Frankenstein attacks (header from one file + body from another) and tampering-in-place. The CEK is the single point of cryptographic linkage — any mismatch breaks the chain.

### Why per-recipient KDF params (not a global header section)

- Phase 2 pubkey recipients don't use Argon2id; global KDF fields would sit unused.
- Different passphrase recipients can carry different params (e.g. legacy vs ratcheted).
- Self-contained: every entry carries everything needed to unwrap it.

### Why no AAD on the body AEAD

- The header is already authenticated by its own HMAC. Putting the header in body-AEAD AAD would force body re-encryption on every header change (passphrase rewrap, recipient add). Cheap-rewrap rule preserved by keeping AAD empty here.

## Parser hardening — defensive bounds

The parser receives `.emd` files from anywhere (local disk, email attachments, sync, downloads). Some will be malformed; some may be deliberately hostile. Each bound below is a "refuse to process if X exceeds Y" gate applied EARLY in parsing, before any expensive operation. Standard defensive parsing — every mature binary format does this.

### Layered defenses (all apply, complementary)

- **Overall file-size cap** — refuse to even open files larger than the format-wide read ceiling of 25 MB (see Bound #2). Single global gate, not user-tunable.
- **Size coherence check** — declared lengths in the header MUST add up to the file's actual size on disk (cheap `fstat`). Catches truncation, trailing garbage, and "header lies about being huge while file is small."
- **Per-field bounds** — for things size coherence can't see (KDF params, decompression ratio).

### Bound #5 — Decompression bounds (zip-bomb defense)

Two-gate check, both must pass. Pre-check via zstd frame header (cheap, microseconds); streaming counter as backup if header field is absent or lies.

```
if compression_ratio > 25x  OR  decompressed_size > 250 MB:
    reject
```

- **25× ratio cap** catches "small ciphertext, huge expansion" (classic zip bombs).
- **250 MB absolute cap** catches "user genuinely opened a 25 MB ciphertext that expands to 600 MB."
- Either fires → reject before allocating the plaintext buffer.

**Implementation:**
- Read zstd frame header (Frame_Content_Size field) first; if declared size violates either bound, reject immediately without decompressing a byte.
- If our own encoder always emits Frame_Content_Size (it should), this is the cheap path.
- Stream-decompress with a byte counter as backup. Abort the moment counter > 250 MB. Never holds full plaintext if it would exceed the cap.

### Bound #4 — Argon2id parameter bounds

Per-recipient KDF params are validated before being passed to Argon2id. Prevents "header is small but unwrap hangs forever."

| Param | Min | Max | Reasoning |
|---|---|---|---|
| `mem_kib` | **8 MiB** (8192 KiB) | **2 GiB** (2_097_152 KiB) | Below 8 MiB defeats the KDF's purpose; above 2 GiB is malicious or absurd |
| `iters` | **1** | **16** | Real-world legitimate max is ~10 (Cryptomator, KeePassXC paranoid profiles); 16 is generous and bounds open-time to ~5 s on iOS |
| `parallelism` | **1** | **64** | Modern CPUs cap ~16-32 cores; 64 is future-proof |

Phase 1 defaults (`mem=46 MiB, iters=3, parallelism=2`) are well within bounds.

### Bound #3 — Header field bounds

Even within the overall file-size cap, individual header fields are bounded so a malicious file can't claim "the recipient list is 4.99 MB."

| Field | Cap / fixed value | Reasoning |
|---|---|---|
| Total header size | **64 KB** | Fits hundreds of recipients + authors with room to spare |
| `recipient_count` | **256** | Phase 1 always 1; Phase 2 multi-recipient unlikely to exceed ~10 in practice |
| `author_count` | **256** | Phase 2 only; one author per save typical |
| `label_len` | already ≤255 (u8) | UTF-8 byte length |
| `salt_len` | **fixed 16 bytes** | Reject any other value |
| `wrap_nonce_len` | **fixed 24 bytes** | XChaCha20 nonce; reject anything else |
| `wrapped_cek_len` | **fixed 48 bytes** (32 CEK + 16 AEAD tag) | Reject anything else |
| `body_nonce_len` | **fixed 24 bytes** | Reject anything else |

The "fixed length, reject anything else" pattern is stricter than "≤ N" — for these crypto fields, the only legitimate value is the exact value; any deviation is malformed or hostile. Protocol invariants, not user-tunable.

### Bound #2 — Maximum `.emd` file size

- **Format-wide read ceiling: 25 MB.** The parser always refuses to open files larger than this — same on every machine, every platform, every install. This is the hard safety bound (zip-bomb defense + memory-allocation gate) and is **not** user-tunable. Cheap `fstat` check before any allocation.
- **User-tunable save guard: 1–25 MB, default 5 MB.** Settings item in the General tab. The editor refuses to *save* a file whose ciphertext would exceed this user-set value. Smaller defaults reduce sync traffic, disk wear, and accidental "huge encrypted blob" creation.
- Help text on the row: *"Files larger than this setting cannot be saved on this machine. They can still be opened anywhere — the format-wide read ceiling is 25 MB."*
- 5 MB ciphertext represents roughly 25–50 MB of plaintext after zstd decompression — well past any realistic markdown note. Power users with very long docs can raise the save guard to 25 MB; the read ceiling is the same everywhere.
- **Why this split**: a per-machine read cap would break the cross-device portability promise (a file written with the cap raised on Machine A would be unreadable on a default-cap Machine B). The format-wide 25 MB ceiling preserves "passphrase alone is always enough on any device."

### Bound #1 — Magic + version sanity gate (first thing the parser does)

```
if file_size < HEADER_MIN_BYTES:           reject "too small"
if first 4 bytes != "EMD\0":               return NotAnEmdFile sentinel (NOT a hard reject)
if version_byte > MAX_KNOWN_VERSION:       reject "unsupported format version"
```

- **`MAX_KNOWN_VERSION = 0x01`** in Phase 1. Bumped on each incompatible byte-layout change.
- **App-level routing on `NotAnEmdFile`**: the editor falls back to opening as plaintext markdown (UTF-8 decode + render). If UTF-8 decode also fails, then "cannot open this file." So magic mismatch is not a hard error at the app level — it just means "not encrypted, route through the markdown reader."
- **CLI is stricter:** `emd decrypt` errors on non-`EMD\0` magic; `emd encrypt` rejects non-text input (UTF-8 + null-byte heuristic, see CLI section).

## Format & crypto (algorithm choices)

- **File on disk:** single binary blob. File extension `.emd` (encrypted markdown), registered to the app for double-click open. (`.smd` was rejected — Sega Genesis ROM collision.)
- **Compression:** zstd, applied **before** encryption. (Markdown is highly compressible; encrypted bytes aren't.)
- **AEAD cipher:** XChaCha20-Poly1305. Pure-software, predictable across hardware (no AES-NI dependency), 192-bit random nonces (no counter state).
- **Key derivation:** Argon2id. **Parameters stored per-recipient inside the recipient entry** (for `type=passphrase` recipients) so different recipients can use different params. Phase-2 pubkey recipients won't need Argon2id at all.
- **Argon2id Phase 1 defaults:** `mem=46 MiB (47104 KiB), iters=3, parallelism=2`. Wall-clock ~500 ms on M-series Mac, ~800 ms on modern iOS. Targets modern hardware first.
- **Header authentication: age-style HMAC.** The full canonical header (everything above the body nonce) is authenticated by an HMAC-SHA256 tag stored at the end of the header. The HMAC key is derived from the CEK via `HKDF-Expand(CEK, info="emd-header-mac-v1", L=32)`. Tampering with any header field — recipient list, KDF params, algo IDs, salt — invalidates the HMAC.
  - **Why this approach (not full-AAD):** preserves cheap-rewrap. Changing a passphrase or adding a recipient → recompute HMAC only; body untouched. Pure-AAD would force body re-encryption on every header mutation.
  - **Trust model implication:** any current recipient with CEK access can recompute the HMAC, so they can technically rewrite the header (e.g. add a new recipient). Acceptable: they already have content access and can re-share with anyone. Authenticated rewrite by a collaborator is no worse than them leaking the plaintext.

## Memory hygiene (Phase 1)

Rust-side handling for keys/passphrases. Plaintext markdown content is **deliberately not** included — see `docs/known_issues.md` for the residue limitation and Phase 2 plan.

- **Wrap in `secrecy::SecretBox`**: passphrase bytes, derived wrapping keys, CEK bytes, MAC keys. Auto-zeroized on drop. Prevents accidental `Debug`/`Display` printing.
- **mlock the underlying buffers** to prevent swap-to-disk: each cached secret pinned in RAM. Phase 1 cache holds at most a few entries × ~64 bytes = trivial mlock budget. Call `setrlimit(RLIMIT_MEMLOCK, ...)` at startup so we don't hit Linux's default 64 KB user limit.
- **Disable core dumps** at startup: `setrlimit(RLIMIT_CORE, 0)`. Prevents OS from writing process memory (including secrets) to a core file on crash.
- **What this does NOT cover** (documented in known_issues.md): plaintext markdown body in editor memory, plaintext in JS heap (can't mlock V8). These remain swap-vulnerable in Phase 1.

## Unlock UX (Phase 1)

- **Per-file passphrase model.** No "workspace passphrase" concept. Each file has its own passphrase. Cache is a `Set<passphrase>` in memory (no file paths stored). On file open, app tries each cached passphrase against the file's wrapped CEK; on success, opens. On none, prompts.
- **JS-side passphrase hygiene** (locked Phase 1 rules; full risk documented in [docs/known_issues.md](../known_issues.md)):
  - **(a)** Drop the JS reference to the passphrase immediately after the `invoke()` IPC call resolves.
  - **(b)** NEVER store passphrase in any persistent JS state — no Zustand, no localStorage, no useState across renders. Single function-local variable scope.
  - **(c)** Documented architectural constraint: any future code touching passphrase entry must follow this pattern. Worth a code-review checklist item / lint rule.
  - JavaScript string immutability + GC timing means a few-second residue window in the webview heap is unavoidable in Phase 1. Phase 2 plan: Tauri binary-IPC channel or native OS prompt to eliminate JS exposure.
- **Cache strategy — settings option** (3 modes):
  - **Cache none** — strict per-file binding. The passphrase typed (or biometric-fetched) to open File A is held only for File A's lifetime — used for that file's autosave re-encrypts and lock/unlock cycle, then discarded. It is **never tried against any other file**. Opening a second file always re-prompts, even if the user would type the same bytes.
  - **Cache one** (most recent) — single passphrase remembered across files; new entry evicts prior. Same passphrase opens any file that uses it without re-prompt.
  - **Cache all** (session) — every passphrase entered this session is tried on new files. **Default.**
- **Cache cleared on:** app quit, explicit lock-now, "remove from cache" action, cache-mode change.
- **OS biometric/keychain integration** (Phase 1 scope):
  - **macOS** — Touch ID / Face ID via Keychain + LAContext. Full implementation in Phase 1.
  - **Windows + Linux** — toggle visible but disabled with tooltip explaining unavailability. Implement on demand if users request it.
- **Toggle location:** the "Touch ID / Face ID" toggle lives in the Settings → General tab (see "Settings panel — broader refactor"). Disabled state on non-Mac platforms is intentional + transparent, not hidden.

## Settings panel — broader refactor

Phase 1 also refactors the existing top-right anchored Preferences popover into a centered tabbed modal (690×550px, sidebar 170 + content 520). Top-level tabs:

- **Appearance · Editor · Workspace · Comments** — existing settings moved as-is.
- **General** (NEW) — security-adjacent app behaviors that apply across all files: auto-lock-after-N-minutes, hide content from app switcher / Mission Control, hide content from screenshots, Touch ID / Face ID toggle (macOS only), maximum `.emd` save size (1–25 MB, default 5 MB; the read ceiling is always 25 MB — see Parser hardening Bound #2).
- **Encryption** (NEW) — internal sub-tabs:
  - **Defaults** — Default new file format (Unencrypted .md / Encrypted .emd pulldown, default Unencrypted), "Always pick passphrase from list when creating an encrypted file" (toggle, default OFF).
  - **Passphrases** — Named passphrase list + "+ Add" modal (name, passphrase entry with Diceware 🎲 generator, optional folder claim, "make default" toggle). Strength requirements (min chars, min entropy bits) live here too. **Disclosure note on the tab**: *"The name you give a passphrase is stored in the encrypted file's header in cleartext (so the app knows which passphrase to try). The passphrase itself and your file content are encrypted. Don't put sensitive information in the name."*
  - **Cache** — Remember entered passphrases (None / One / All as a pulldown, default All).
  - **Danger zone** — "Remove all encryption" + "Delete all saved passphrases" (each with strong warning + confirmation).
- **Help** (NEW top-level) — app-wide plain-language explainers. Encryption-specific Q&A entries (minimum required set):
  - Getting started with encryption
  - How encryption works in this app (file format, key derivation, what's protected vs not)
  - What happens if I forget my passphrase? (honest: file is gone, no recovery)
  - Sharing encrypted files with others (Phase 1: out-of-band passphrase; Phase 2: multi-recipient)
  - What is Diceware?
  - Algorithms used
  - **Why version history doesn't work on encrypted files** (rationale + Phase 2 plan)

"Lock now" is NOT in Settings — it lives in the main UI (status bar icon + menu item + Cmd+L). See "Lock-now placement" section.

Editor tab also gets two new toggles: **Autosave interval** (Off / 10s / 30s / 60s / 300s, default 30s) and **Hot-reload from disk** (default ON).

The existing inline UI components (`SegmentedControl`, `Toggle`, `Stepper`, `Row`, `SectionHeader`) are reused. Only `PreferencesDialog.tsx` changes layout-wise.

## Named-passphrase storage backend

- **Two-part storage** (everywhere):
  - `~/.gutter/config.json` (plaintext): array of `{name, folder_claim, is_default, keychain_ref}` per entry. The `keychain_ref` is an opaque ID generated when the entry is created.
  - **OS keychain**: actual passphrase bytes, retrieved by `keychain_ref`. NEVER in plaintext config.
- **Per-platform backend** (via `keyring-rs` crate, unified API):
  - **macOS** — Keychain Services with `kSecAccessControlUserPresence` access control. Touch ID / Face ID where the device supports it; falls back to device password otherwise. Settings label: *"Use macOS authentication to unlock encrypted files"* with help text *"Uses Touch ID / Face ID where available, OS password otherwise."*
  - **Windows** — Credential Manager (DPAPI). Tied to Windows user session; no extra prompt for same-session access.
  - **Linux** — Secret Service (gnome-keyring / kwalletd). Auto-unlocks with the desktop session.
    - **Headless Linux fallback: REFUSE** to start with named passphrases enabled if Secret Service is unavailable. Show clear error: "Named passphrases require a desktop session (gnome-keyring or kwallet). Use the CLI with --passphrase-stdin for headless workflows."
- **Prompt cadence** (depends on cache mode):
  - **Cache all / Cache one**: the OS authentication prompt happens **once per session per named passphrase** (when the in-memory cache first needs it). Subsequent file opens within the session use the cached value — no re-prompt.
  - **Cache none**: the OS authentication prompt happens **once per file open** — the keychain fetch is scoped to the opening file, not retained for other files. Trade-off: more biometric prompts; user explicitly chose strict-per-file in this mode.
- Cache clears per the canonical list in Unlock UX (app quit, lock-now, "remove from cache", cache-mode change).

## Named passphrases (replaces single-default model)

- **Address book of named passphrases.** User can define multiple passphrases, each with a name (e.g. "Personal", "Work", "Project X"). One can be marked as the global default.
- **Per-passphrase folder association** (one folder per passphrase, optional). Files created in that folder default to that passphrase. Walks down — subfolders inherit unless they have their own claim.
- **New-file flow:**
  - In a folder claimed by a named passphrase → use that passphrase silently.
  - Otherwise → use the global default named passphrase silently.
  - "Always pick passphrase from list when creating an encrypted file" toggle (default: OFF) shows a dialog every time so the user picks which named passphrase to use.
- **Diceware-style passphrase generator** built in. Six-word default (~77 bits entropy), user can request more. Generates passphrases that meet the configured strength requirements.
- **Passphrase strength requirements** (configurable in Settings):
  - Min character length
  - Min entropy (bits)
  - Default: reasonable but not punishing (e.g. 12 chars or 50 bits, whichever is met first)
- **Files moved between folders later:** passphrase doesn't change (it's in the file header).

## Passphrase setup, change, and removal

- **Setup flow:** hybrid (Preferences-driven + auto-prompted on first need). Add named passphrases via Preferences → Encryption → Passphrases tab; if no passphrase exists when one is first needed, prompt at that moment with "you can manage these in Preferences later."
- **Change a named passphrase:** edits the entry. Triggers re-wrap of the wrapped CEK in every encrypted file that was using this named passphrase (body untouched, just the small wrapped key changes). Progress UI required when many files are affected. Files using OTHER named passphrases are not touched.
- **Delete a named passphrase:** removes the entry from the address book. Files encrypted with it stay encrypted; user must re-enter the passphrase manually each time to open them (no longer auto-unlocked from the list). Confirmation modal explains this.
- **Remove all encryption from workspace** (Danger zone action): bulk-decrypts every `.emd` back to `.md` (+ extracts comment sidecars). Confirmation modal lists exactly what will happen. Doesn't touch the address book unless user also clicks "Delete all passphrases."
- **UX bar for all flows:** creation, change, and removal must be a deliberate study in intuitive UI with ample plain-language explanation. These are the moments where users either form trust or panic. No jargon, no "are you sure?" without context, no irreversible actions without an explicit warning of what's about to happen.

## Comments inside encrypted files (Phase 1)

- **Sidecar files do NOT exist on disk for `.emd` files.** Both `.comments.json` AND `.comments.md` are bundled INSIDE the `.emd` file body, encrypted with the same key as the markdown.
- **Reason:** the existing three-file model puts `notes.comments.json` next to `notes.md` in the same directory, plaintext. If we encrypted only `notes.md → notes.emd` but left the sidecars beside it, sensitive comment content would leak via Finder, git, Dropbox, etc. — the user would think the file was "secured" but the sidecars would be sitting in the same folder, fully readable.
- **Bundling fixes this completely.** Single `.emd` file. No sidecars on disk. Atomic — comments can't be separated from the file they belong to.
- **Format:** body is a structured payload with a small schema. The encrypted+compressed body decrypts to:

```
[u32 LE body_schema_version]      ← 0x00000001 in Phase 1
[u32 LE markdown_len][markdown bytes]            ← always present
[u32 LE comments_json_len][comments_json bytes]  ← 0 means no comments
[u32 LE comments_md_len][comments_md bytes]      ← 0 means no companion
```

  - Files with no comments: 12 bytes of overhead beyond the markdown itself.
  - Files with comments: zstd compresses well across markdown + JSON + companion (lots of repeated tokens).
  - Adding a new section type later → bump `body_schema_version`, append after existing sections. Older readers see newer version → clear error.
- **On encrypt** (multi-file conversion is best-effort — see "Conversion crash semantics" section below for the accepted limitation):
  1. Read `notes.md`, `notes.comments.json`, `notes.comments.md` from disk.
  2. Assemble structured body → compress → encrypt → write `notes.emd` via `atomic-write-file` crate (temp + fsync + rename + dir-fsync).
  3. **Verify the just-written target**: re-open `notes.emd`, parse magic + verify header MAC + decrypt body AEAD + hash-compare the decrypted plaintext against the in-memory plaintext. If verification fails, abort: delete the bad target, leave plaintext inputs intact, surface error to user. Inputs are never touched on a verify failure.
  4. Delete each plaintext file in sequence; fsync parent dir after each.
- **On decrypt back to plaintext**: reverse — write the plaintext outputs (markdown + sidecars) atomically, verify each is readable on disk, then delete the `.emd`. Same best-effort guarantee.

## Local version history (disabled for `.emd` in Phase 1)

The existing local snapshot history feature (`~/.gutter/history/{path_hash}/{timestamp}.md` written by `useSaveHandler.ts` + `history.rs`) currently writes plaintext snapshots on every save. For `.emd` files this would leak plaintext to disk in the same session that the user just encrypted the file — undermining encryption-at-rest.

**Phase 1 fix:** disable local snapshot history for encrypted files. When saving an `.emd`, skip the history snapshot write entirely. Plain `.md` files continue to get history snapshots as before.

**UX requirement:** when the user opens the History side panel for an encrypted file, show a large-font visible notice in place of the timeline:

> **Version history is disabled for encrypted files.**
> Snapshots would otherwise be written in plaintext to `~/.gutter/history/`. See Help → "Why version history doesn't work on encrypted files."

External version history (Dropbox versions, iCloud versions, git commits) continues to work — the user isn't entirely without recovery, just without the local snapshot timeline.

**Phase 2 candidate:** revisit with option (b') — store snapshots as separate encrypted `.emd`-format files in `~/.gutter/history/`, encrypted with the parent file's passphrase. Preserves the feature without the leak.

## Autosave + hot-reload

- **Unified autosave** for `.md` and `.emd` — single interval drives both.
- **Settings options**: Off / 10s / 30s / 60s / 300s. **Default: 30s** (raised from 2s; deliberately conservative — minor latency for big reliability wins on sync, CPU, watcher races, and disk wear).
- **`Cmd+S`** always works for on-demand save regardless of autosave setting.
- **Each save of an `.emd`** = compress + fresh CEK + AEAD encrypt + wrap CEK + atomic write. ~20-100 ms total per save. No Argon2id, no decryption — plaintext is in editor memory the whole session.
- **Write amplification** is real for `.emd` (every save is fully new ciphertext, defeats sync delta-encoding). The 30s default is the mitigation; users picking 10s should know what they're trading (more sync traffic, more disk wear, more CPU while typing).

### Hot-reload (file changed externally)

- **Settings toggle:** "Hot-reload from disk" — ON by default. Lives in Editor tab (paired with autosave). When OFF, external changes are ignored; the editor shows whatever was last loaded.
- **Debounced 500ms** (when ON) to coalesce rapid-fire watcher events from mid-sync writes (Dropbox/iCloud/syncthing rarely deliver one atomic event).
- **Per-tab `diskHash` is a composite** of (a) the plaintext hash (post-decrypt) and (b) the header MAC bytes. NOT the raw ciphertext.
  - Why composite: ciphertext-only hash spuriously fires on every save (fresh CEK = different bytes even for identical plaintext). Plaintext-only hash misses header-only changes (passphrase rewrap, recipient additions, KDF ratchet) — the body is unchanged but the header is materially different, and silently overwriting it would lose security-relevant data.
  - Implementation: `tab.diskHash = djb2(plaintext_bytes) XOR header_mac_bytes` (or any commutative composite). Both layers tracked; any change in either fires reload-needed.

**Per-tab state machine when an external change arrives:**

- **Locked tab** (closed-lock state, watermark): silently ignore content changes — we can't decrypt anyway. Update internal "disk changed" marker; next unlock uses fresh disk bytes.
- **Unlocked + clean tab**: auto-reload silently. Try cached passphrases against the new wrapped CEK. If none match, banner prompts: "File was re-encrypted externally — enter the new passphrase."
- **Unlocked + dirty tab**: same conflict dialog as plaintext, with the encrypted hint "External version may use a different passphrase." [Discard & Reload] / [Keep Mine]. **Keep-Mine path**: next save proceeds normally — generates a fresh CEK as always, wraps it for our cached passphrase recipient. We do NOT reuse the CEK from the prior open (CEKs are always fresh per save). The external version's passphrase changes are overwritten with ours.
  - **Cross-passphrase external rewrites in multi-party scenarios** (the external version was re-encrypted by another collaborator with their own passphrase or pubkey, and we'd be silently overwriting their access) are a **Phase 2 concern** — Phase 1 is solo, single-passphrase per file.
- **Format error / AEAD failure** on reload: don't reload, preserve in-memory copy, surface a clear error.

### Pre-existing self-reload bug to fix during Phase 1

The current app sometimes shows "file changed, reload?" for the app's own autosave write. Four mitigations exist today: Rust per-path 2s suppression (`mark_write` in `watcher.rs`), JS 1.5s blanket window (`lastSaveTimeRef` in `useMultiRootWatcher.ts`), JS 500ms per-path debounce on watcher events, and a `diskHash` content sanity check. The two time-window suppressions (2s + 1.5s) are correctness-mechanisms-of-convenience that no major editor uses; the diskHash is the actual authoritative answer. Encrypted saves are slower (5-10× longer write path) so the existing race becomes more likely + scarier (could surface as decryption errors). Phase 1 fixes:

- **(a) DROP self-suppression windows entirely** (Rust 2s and JS 1.5s). Keep the 500ms watcher-event debounce (different purpose — coalescing rapid sync-mid-transfer events). The composite hash on every watcher event is the authoritative answer.
- **(b)** Update tab `diskHash` synchronously inside the save flow, before `mark_write` returns — eliminates the race where the watcher event arrives before the post-save state update.
- **(c)** For `.emd` tabs, use the composite hash (plaintext + header MAC), not the ciphertext (already locked above).
- **(d)** Read-before-write etag check at save time. Just before writing, re-read the file's current header_mac and compare to last-known. If different → external change happened during the edit session → show conflict prompt; don't overwrite. (VS Code's `FILE_MODIFIED_SINCE` pattern, source-confirmed.)

**Rationale**: industry research across 13 editors (VS Code source, IntelliJ VFS docs, Typora bug #1401, Vim `FileChangedShell`, Emacs `auto-revert-mode`, Sublime, Obsidian, Zed, Helix, Apple NSFileCoordinator, et al.) shows **no major editor uses time-window suppression as a correctness mechanism**. They use content-based correlation (etag, mtime+size, content hash) at write/read time. Widening windows to 5s as previously proposed would silently swallow legitimate external writes within that window — exactly the Typora-#1401 bug class. Source URLs in the research synthesis (search session memory).

## Conversion crash semantics

Multi-file conversions (`.md` ↔ `.emd`, where 3 plaintext files become 1 encrypted file or vice versa) **cannot be atomic on standard filesystems** (POSIX, NTFS, APFS, ext4 have no syscall for "delete N files atomically"). Phase 1 takes a best-effort approach rather than a journal-based one — see `docs/known_issues.md` for the accepted limitation and Phase 2 candidates.

### Strict write order (the safety invariant)

The plaintext is never deleted until the encrypted target is **fully durable and verified**:

1. Write `.emd` via `atomic-write-file` (temp + fsync + rename + dir-fsync).
2. **Verify**: re-open the just-written file, parse magic, verify header MAC, decrypt body, hash-compare the result against the in-memory plaintext. Any failure → delete the bad target, leave plaintext untouched, surface error.
3. Only after verify passes: delete plaintext companions in sequence, fsync parent dir after each.

This guarantees one direction strongly: **a verified `.emd` only exists if its plaintext sources were valid, and plaintext is only deleted once a verified `.emd` exists.** What's *not* guaranteed: that the deletion step completes — see below.

### What can go wrong (the accepted limitation)

If the process dies between steps 2 and 3 — i.e. after the `.emd` is durable on disk but before all plaintext companions are deleted — the user ends up with both states present in the folder. The encrypted file is correct; the plaintext companions are correct; but encryption-at-rest has been silently undermined for those companions. There is no automatic recovery in Phase 1.

This matches the documented stance of age and GnuPG, both of which leave plaintext lifecycle to the user. GnuPG specifically *removed* their auto-delete-after-encrypt feature after data-loss bugs (https://dev.gnupg.org/T3506) — making it explicit rather than automatic is the safer call. We follow the same philosophy.

### Manual cleanup affordance

Encryption settings → Danger zone offers a manual *"Find orphaned plaintext companions"* action: scans the workspace for `<name>.md` (and `.comments.json` / `.comments.md`) files that sit next to a `<name>.emd`, lists them with previews, and lets the user delete them after explicit confirmation. Not automatic; not run on startup; user-driven only.

### Why no marker journal

The earlier design used an SQLite-style super-journal with a `.converting.json` marker and a startup-scan recovery pass. Two reviewers independently flagged that the rollback semantics in the post-commit phase could destroy the only complete copy of the user's data on certain crash timings — strictly worse than no journal at all. Cross-app research (age, GnuPG, Cryptomator, gocryptfs, VeraCrypt, Apple Notes, Standard Notes, Joplin) showed two viable patterns: (a) virtual-filesystem architectures where plaintext never touches disk (Cryptomator), and (b) explicit best-effort with documented limits (age/GnuPG). Our 3↔1 file model precludes (a) without an architectural rewrite, so we adopted (b).

## Phase-2 deferrals (noted, not yet designed)

- Multi-party tier choice (Tier 3+4 vs Tier 5).
- Author identity / signing.
- Per-recipient revocation UX.
- **Duplicate-pubkey detection in recipient list.** Phase 1 doesn't need this (passphrase recipients have random salts/nonces, accidental duplicates can't byte-collide). Phase 2 pubkey recipients have deterministic identifiers; same pubkey bytes appearing twice is detectable and should reject.
- **Portable hardware-backed recipients** (use the existing recipient-list slot — no format change):
  - **YubiKey / smartcards (cross-platform)** — PIV-based ECDH as a recipient. Plug in and tap to unlock. Works on Mac/Win/Linux/Android — moves with the user, not bound to any specific device.
  - **Same code path as collaborator multi-recipient** — YubiKey is just a `type=yubikey_piv` entry alongside `type=passphrase` and `type=pubkey`. The "try each recipient until one unlocks" loop handles all transparently.
  - **Architectural rule:** the passphrase recipient must remain on every file as the portable backstop. UI defaults to "include passphrase" when adding YubiKey; warns loudly if user removes it.
- **Explicitly NOT included — device-bound hardware as a recipient.**
  - Secure Enclave-as-recipient (Mac/iOS) and TPM-as-recipient (Windows/Linux) are deliberately rejected for Phase 2. Reason: laptops are ephemeral (replaced, lost, broken); binding file access to a device's non-exportable key creates fragility even with passphrase backup.
  - This does NOT affect Phase 1 Touch ID, which only stores the passphrase locally in Keychain (still device-portable via the passphrase). That stays as designed.

## Cross-device portability (Phase 1)

- **Passphrase alone is always enough** to open any file on any device, any platform, any time. Argon2id derivation is deterministic from passphrase + per-file salt; no device-specific component in the file. The format-wide 25 MB read ceiling is the same on every machine, so files written within the format limit open everywhere.
- **Two-laptop scenario:** both decrypt with the same passphrase. Each laptop independently enables Touch ID (its own Keychain entry). No coordination.
- **Laptop replacement:** install on new machine, sync files, type passphrase once. Re-enable Touch ID locally if desired. Old machine's Keychain / SE state is irrelevant.
- **Hardware backing in Phase 1 is convenience over the passphrase, not a replacement.** Losing all devices with Touch ID enabled is fine as long as the passphrase is remembered.

## Platforms

- Windows, Linux, macOS (current). iOS via Tauri Mobile when added later. Same file format on every platform.
- **Phase 1 build sequence — macOS first.** Iterate Phase 1 to completion against the macOS build via hands-on use. Lock the design, then port to Windows + Linux. Avoids platform-specific debugging during the iteration phase.

## File associations & double-click open

- App registers as a handler for both `.md` and `.emd` on every supported OS:
  - macOS: `CFBundleDocumentTypes` + UTI declarations in `tauri.conf.json`.
  - Windows: registry entries written by the installer.
  - Linux: `.desktop` file with `MimeType` + `xdg-mime` registration.
- `.emd` becomes default automatically (we're the only handler that knows the format).
- `.md` association: prompt on first app launch — "Make this app your default markdown editor?" — one-click yes/no. Also settable in Preferences anytime.
- **Double-click `.emd` from Finder/Explorer**: app launches (if not running), reader opens the file standalone (no workspace context required), prompts for passphrase (or biometric on macOS).
- App's identity in the OS: markdown reader/editor first; encryption is a feature, not the headline.

## Lock-now placement

- **Status bar** (bottom): lock icon button.
- **Menu bar**: in a logical menu (File or new "Encryption" menu).
- **Keyboard shortcut**: `Cmd+L` (verified free in the existing shortcut map).
- All three trigger the same action: clear cached passphrases AND re-lock all open encrypted files (watermark UX).

## Per-file lock-icon click behaviors

- **Click grey lock (plaintext file)** → modal: "Encrypt this file" with two options:
  - Select from named passphrases (with default highlighted)
  - Set new passphrase (with Diceware generator)
  → confirm → file becomes `<name>.emd`.
- **Click prominent open lock (encrypted, currently unlocked)** → per-file lock: vacates this file's passphrase from the cache, file shows watermark, no dialog.
  - **Side effect**: because the cache is keyed by passphrase (not by file), if other open tabs use the same passphrase, they get locked too.
  - **Workaround**: if user wants to lock just this one tab without affecting others sharing the same passphrase, close the tab instead of clicking the lock.
- **Click prominent closed lock (encrypted, locked)** → passphrase prompt / biometric → unlocks.
- **Right-click lock icon (any state)** → context menu:
  - "Decrypt and save as .md…" (destructive — separate confirmation modal)
  - "Show file info" (recipient list summary, KDF params, algo IDs — no secrets)
