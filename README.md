# emocode v3.1

Desktop AI coding agent powered by the OpenRouter API (Electron + JavaScript). It can inspect, read, and edit files in your workspace, as well as execute terminal commands. Equipped with tiered permission modes, comprehensive diff inspection, and a Midnight Blue theme.

## Installation

Install Node.js 22.12 or newer and npm.

```bash
npm ci
npm start
```

See [CHANGELOG.md](CHANGELOG.md) for changes from the v2 line.

On Fedora (if needed):

```bash
sudo dnf install -y nodejs npm bubblewrap
```

You can also open the project in VS Code and run `npm start` from the terminal, or launch it with F5 using the `.vscode/launch.json` configuration.

## Permission Management (Tiered Modes)

Easily switchable from the top toolbar or via the `/mode` command:

- **🛡️ Strict**: Prompts for every command and file operation. No session bypass; provides complete manual control over every action.
- **⚖️ Normal**: Warns and requests confirmation for risky actions; remembers approvals for safe commands within the session.
- **🤖 Auto**: Autonomous decision mode. Automatically approves safe commands and file edits; prompts only for risky or sensitive actions.
- **⚡ Turbo**: Full autonomous mode. Executes commands and applies code changes directly without confirmation prompts.

## Review & Diff (Changes Inspection)

To review file modifications and diffs made during the session, click the `📝 Changes` button on the top bar or use the `/diff` command:
- Shows additions (`+`) and deletions (`-`) per file.
- Syntax-highlighted, line-numbered diff view (red for deletions, green for additions).
- Single-click file rollback (`undoFile`) or full session rollback support.

## Themes

- **Dark (Night)**
- **Midnight Blue**: Deep navy and electric blue tones
- **Light (Warm Paper)**
- **System Sync**

## Getting Started

1. Go to **Settings** and enter your OpenRouter API key (https://openrouter.ai/keys). The key is encrypted using the operating system's secure storage whenever supported.
2. Select a model or enter a model ID at the top bar. Choose a model that supports tool calling for file modifications.
3. Use **Select Folder** to choose your workspace directory.
4. Enter your prompt to start coding.

## Built-in Tools

`list_dir`, `read_file`, `glob`, `search_files`, `write_file`, `edit_file`, `multi_edit`, `run_command`, `shell_session`, `background_process`, `git`, `web_fetch`, `web_search`, `todo_write`, `ask_user`.

## Security & Rollback

- **Encrypted API Keys**: API keys are securely stored and encrypted via OS keychain/secret store; the frontend never exposes raw keys.
- **Workspace Confinement**: User home directory, root directory, system folders, and critical hidden directories are restricted from being selected as workspaces.
- **Sensitive File Protection**: Private keys and certificates are excluded from model context. `.env` and sensitive files always require explicit user confirmation.
- **Restricted Web Fetch**: `web_fetch` only permits HTTP(S) requests. Local, private, link-local, and reserved IPv4/IPv6 addresses (and redirects to them) are blocked, with DNS rebinding protections.
- **Command Sandboxing**: Commands run through Bash on Linux and PowerShell on Windows. On Linux, Bubblewrap sandboxing is enabled by default on first run when available, with network access disabled. Existing user settings are preserved.
- **Undo & Backup**: File edits and project modifications detected after `run_command` can be rolled back via **Undo**. Binary backups are preserved byte-for-byte. Command approval shows snapshot limits; `.git`, dependency and build directories are excluded, snapshots cover up to 10,000 files and 25 MB, and individual backups are limited to 10 MB.
- **Excluded Directories**: For performance reasons, command tracking ignores `.git`, `node_modules`, `.venv`, `venv`, `vendor`, `dist`, `build`, and `coverage`. We always recommend committing or stashing in Git before running heavy operations.

## Settings

- **Max Steps**: Upper limit of tool call iterations permitted per user request.
- **Command Timeout**: Maximum execution time per command (up to 600s).
- **Chat Budget**: Spending limit based on OpenRouter usage; stops further model and tool requests once reached.
- **Context Window Limit**: 8,000–1,000,000 tokens (dependent on chosen model's maximum limit).

## Commands

- `/help`: Display command help.
- `/init`: Request creation of `EMO.md` for project instructions (requires plan mode to be off).
- `/plan`: Toggle read-only plan mode.
- `/mode <strict|normal|auto|turbo>`: View or change permission mode.
- `/compact`: Compact and summarize conversation context.
- `/undo`: Revert the last batch of changes.
- `/clear`: Clear chat history.
- `/model <name>`: Switch the active model.

Chat exports are available in **JSON** (raw messages and tool calls) or **Markdown** (human-readable transcript).

## Testing

```bash
npm test
npm run test:coverage
npm run test:ui
npm run test:windows
```

`test:coverage` enforces 70% line, 60% branch, and 65% function coverage for the main process, preload bridge, and `lib/`; it does not impose a renderer coverage threshold. `test:ui` starts Electron with an isolated profile and a local OpenRouter fixture, then checks the missing-key guard, a rendered OpenRouter error, cancellation recovery, a full send/response through the real main process and IPC bridge, and settings/chat restoration after restarting Electron. IPC tests also cover approval round trips and image attachment persistence/resolution. The Windows CI job runs the portable IPC, renderer bridge, security, and attachment checks, builds portable and unpacked app targets, then launches the packaged app in a fresh profile and verifies that its renderer page becomes available.

GitHub Actions runs the coverage suite and Electron smoke test on Linux, and the portable checks, Windows package builds, and packaged-app startup smoke test on Windows.

## Project Structure

- `main.js`: Main process, window management, IPC handlers, and agent loop
- `preload.js`: Secure bridge between renderer and main process
- `lib/`: Tools, security checks, OpenRouter client, approval system, and rollback engine
- `renderer/`: Frontend user interface
- `test/`: Unit and tool tests

## Instruction Files

If present in the workspace root, one of the following files will be automatically loaded into the system prompt (first match used):
`EMO.md`, `OR.md`, `AGENTS.md`.

## AI-Assisted Development Statement

The source code and icon (`assets/icon.png`) for this project were substantially generated with AI assistance, architected, curated, and reviewed by a human developer.

Architectural decisions, prompt engineering, refactoring, testing, and verification were guided by human input. This project does not intend to infringe on any third-party brands, logos, characters, or established works.

## License

MIT — see [LICENSE](LICENSE) for details.  
Third-party component licenses: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
