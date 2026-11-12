# Orbit Remote

**English** · [Tiếng Việt](README.vi.md)

Control every Claude Code session on every one of your computers from your phone: open sessions, chat, approve
permissions, view and control each machine's screen, and let sessions message each other and work as a team, even when
they run on different machines.

- The app is a **PWA** (a web page you add to your home screen): no App Store, no Apple Developer account.
- **No external dependencies**, only Node.js 20 or newer.
- Data only travels between your own machines. Away from home, the app reaches the hub through **Tailscale** (your own
  private network).
- The app interface is currently in Vietnamese. This README gives the Vietnamese label next to each button it mentions.

## Features

**Machines and sessions**

- Every machine running Orbit Remote **shows up in the app by itself**: tap **Cho nối** (allow) once, and from then on the
  machine is remembered, even while it is off. The home screen is an **Online / Offline** tree of machines, session groups
  and sessions.
- **Sessions already on a machine show up right away**, even on a machine that has just been set up and has not opened
  anything from the app: under each machine that is on, the home screen lists the Claude sessions open in VS Code or a
  terminal and the five newest old sessions from Claude Code's transcripts, with **See all** (*Xem tất cả*) for the rest.
  Tap one to read the conversation, then continue it in the app or fork it.
- **Open, close and restart sessions** on the machine you pick; **reopen old sessions** from Claude Code's transcripts;
  view (read-only), continue or fork sessions that are open by hand in VS Code or a terminal.
- **Chat, stop the running turn, approve permissions** (allow, deny, always allow) and answer Claude's multiple-choice
  questions.
- A composer like the Claude app: attach files and images (Ctrl+V works), pick model, effort and permission mode, dictate
  instead of typing, and keep each session's unsent draft. Images and files that Claude mentions open right on the phone.
- **Browse the working folder** on the target machine when opening a new session.
- **Remote Control**: turn it on for a session to continue it on claude.ai/code or in the Claude app.
- **Tag sessions** with `@Session-name` in the composer to point at any session on any machine.
- **Quick commands**: Continue, Report progress, Review changes, Run tests, Commit, Commit and push, Restart hub, Set up
  machine, plus every token in the token table (see "Customization").
- **Always the newest model** of the Opus, Sonnet and Haiku lines: one button asks Anthropic for the model list and moves
  every machine and running session to the new version.

**Machine screens** (Windows machines)

- View and control the screen through `ffmpeg` (H.264 or JPEG); pick a **screen, app window or folder window**; three
  quality levels (Fast, Sharp, Saver) with automatic step-down when the network is congested.
- Three control modes: **touch**, **mouse** (trackpad-style) and **joystick** (a virtual stick moves the pointer, four
  buttons click and scroll); pinch zoom, drag, the iPhone keyboard types straight into the machine (Vietnamese input
  methods included), plus a key row with Ctrl, Alt, Win, F5 and more.
- **Rotate with the phone**: the screen or window switches between landscape and portrait to match how you hold the
  phone, and is restored when you stop watching.
- **Two-way clipboard** like Remote Desktop: paste text, files and whole folders into the viewed machine and copy them back.
- **See and type on the lock screen**, click UAC prompts (optional helper that runs as SYSTEM).
- **Floating session**: chat with a session in a floating panel on top of the screen you are watching.

**Machine management**

- **Shut down** now or on a timer; **wake machines over the network** (Wake-on-LAN), sent by a machine that is awake on the
  same network.
- **Temperatures** of CPU, GPU, drives and motherboard (full detail with the optional sensor helper; otherwise NVIDIA GPU
  and ACPI thermal zones).
- **Claude account per machine**: see which account a machine uses and sign in to another one from the phone.
- **Claude usage**: 5-hour session, weekly limits, reset times, and Claude Code tokens used this week across all machines
  with an estimate of what is left.
- **Remote setup**: one button makes a machine pull the newest code, install what is missing and restart; the result
  shows up in the app.
- **PC app**: the app opens in its own Edge window with a two-column layout on wide windows; shortcuts in Start and on the
  Desktop.

**Sessions working together**

- **Sessions message each other**, across machines too: a message is pushed straight into the receiving session as a new
  turn. Messages that only inform (`needs_action: false`) are held and folded into the receiver's next turn to save tokens.
- **Work on another machine**: a session running on machine A runs commands, reads and edits files, and sees and clicks
  the screen of machine B (machine B must allow it).
- **Move a session to another machine**: work in progress is committed as a temporary commit and pushed, the target pulls
  it, the session transcript is copied over, and the session continues with its full context.
- **Session groups**: put several sessions in a group with a leader and a shared goal, give each one a role (a token from
  the token table) and press Start. The leader splits the goal into tasks, assigns them and reviews the handoffs. Includes
  a task board, a per-member queue, a shared-tool board (Unity, Blender...), token cost and budget, automatic context
  compaction, pause and resume.

## Requirements

- **Windows 10 or 11** for the full feature set (screen, mouse and keyboard, power, temperatures). The installer and
  autostart only support Windows today; on macOS or Linux run `node src/main.mjs node` by hand (hub, sessions and
  messaging; not tested much outside Windows).
- **Node.js 20+**, **Git**, and **Claude Code** signed in. `setup.cmd` installs whatever is missing with winget, including
  `ffmpeg`.
- **Tailscale** (optional) to use the app away from home.

## Getting started

The hub is Orbit Remote's small server; the phone app is bound to the hub's address. Put the hub on a machine that is
always on at home. Every other machine is a **session machine**: it finds the hub and asks to join.

1. On the hub machine: clone this repository, double-click **`setup.cmd`** (safe to run again: finished steps are only
   checked), then double-click **`run.cmd`**. The window prints a QR code and a 6-digit pairing code.
2. On the iPhone: open **Camera**, scan the code and tap the link. Safari opens the pairing page: **Share → Add to Home
   Screen**, then open Orbit Remote from the home screen (it pairs itself with the code in the address).
3. On every other machine: clone the repository and double-click `setup.cmd`. The app's home screen shows a **new machine
   asks to join** card (*Máy mới xin nối*): tap **Cho nối** (allow).

Run **one hub** per app: `run.cmd` on another machine only starts the machine agent and tells you there is nothing to
scan. To move the hub role to another machine (rarely needed): `node src/main.mjs start --hub` on that machine.

New pairing code at any time: run `run.cmd` again, `node src/main.mjs pair`, or on a paired device open **Settings → Pair
a phone with a QR code** (*Cài đặt → Ghép điện thoại bằng mã QR*).

### What the installer does

`setup.cmd` pulls the newest code (`git pull --ff-only`), installs Node.js if needed, then runs
`node src/main.mjs setup`, which checks each step on the real machine and installs or fixes what is missing:

| Step | Notes |
|---|---|
| Node.js 20+, Git, Claude Code | Installed with winget or npm. Sign in to Claude Code by running `claude` once (reminder only). |
| `ffmpeg` with `ddagrab`, one test frame | For screen view. Tries the same fallback chain as the stream: DXGI then GDI, hardware encoder then `libx264`. |
| Mouse and keyboard | Compiles `src/win-input.cs` with the `csc.exe` that ships with Windows. |
| Lock screen (optional) | One UAC prompt: installs `src/win-secure.cs` as the "Orbit Remote Secure Desktop" task running as SYSTEM. |
| Temperatures (optional) | One UAC prompt: PawnIO driver, LibreHardwareMonitor 0.9.6 (SHA256 pinned), "Orbit Remote Sensors" task. |
| Firewall | One UAC prompt: opens TCP 8796 (screen); on the hub machine also TCP/UDP 8795. |
| Tailscale | Installs and signs in with the same account as the hub machine; `tailscale set --unattended` so it runs before Windows sign-in. |
| Wake-on-LAN (optional) | One UAC prompt: enables wake on the wired adapter and turns off Fast Startup. BIOS settings are only reminded. |
| Autostart, PC shortcuts | Starts at Windows sign-in; **Orbit Remote** shortcuts in Start and on the Desktop. |
| Newest code running, joined | Restarts the machine agent (asks first if a session is mid-turn) and waits for you to tap **Cho nối** in the app. |

Check only, change nothing: `node src/main.mjs doctor`. No UAC prompts: `setup.cmd --no-admin`.

## Away from home: Tailscale

[Tailscale](https://tailscale.com) joins the machines signed in to one account into a private, end-to-end encrypted
network. The hub needs no open ports and no certificates.

On the hub machine, in the repository folder, after installing and signing in to Tailscale:

```
node src/main.mjs tailnet setup      # declare the hub's Tailscale address
node src/main.mjs restart            # the hub announces the new address to the app and machines
node src/main.mjs tailnet status     # is Tailscale running, does the hub answer through it
```

- **Phone**: install the Tailscale app, sign in with the same account, turn it on, then scan the QR code again (it now
  points to the Tailscale address). An app installed from that address works at home and away.
- **Machines on other networks**: install Tailscale with the same account. `tailnet setup` writes the hub's address to
  `custom/hub.json`, and any machine that has this file finds the hub by itself. The file is yours, so `.gitignore` skips
  it: copy it over, commit it to your private fork with `git add -f custom/hub.json`, or run once on the other machine
  `node src/main.mjs join http://<hub Tailscale IP>:8795`.

Over Tailscale the hub only speaks `http://`, and browsers disable the video decoder and service worker on plain `http://`
pages. That is why the PC app opens through the machine agent's `127.0.0.1:8797` port (forwarded to the hub), and why the
screen view connects straight to the machine over WebSocket instead of through the hub.

## PC app

Double-click the **Orbit Remote** shortcut (created by `setup.cmd`) or run `node src/main.mjs app`: the app opens in its
own Edge window (Chrome if Edge is missing) with a separate browser profile. From 1100 px wide the window splits into two
columns: the home screen on the left, the open view on the right; drag the divider to resize. On the hub machine the
window pairs itself; on other machines type the code shown under **Settings → Pair a phone with a QR code** (*Cài đặt →
Ghép điện thoại bằng mã QR*) on a paired device.

## Customization

Everything you customize lives in `custom/`:

| File | Purpose |
|---|---|
| `custom/actions.json` | Buttons: a row in a session's **Quick commands** (`"scope": "session"`) or a button on the home screen (`"home"`). Editable in the app under **Settings → Custom buttons** (*Cài đặt → Nút bấm tuỳ biến*). |
| `custom/tokens.md` | Token table: `$name` shortcuts typed in the composer, and the roles of sessions in a group. Empty on purpose. |
| `custom/theme.css` | Override colors, font size and corner radius (variables listed at the top of `web/styles.css`). |
| `custom/extension.js` | Any JavaScript: listen to events, send messages, open sessions, add buttons, call the hub API. Examples inside. |

### Buttons (`actions.json`)

| Key | Meaning |
|---|---|
| `label` | Button text (required). |
| `scope` | `"session"`: a row in Quick commands. `"home"`: a button on the home screen. |
| `hint` | Note shown under the label in Quick commands. |
| `send` | Send this text to the open session right away. |
| `fill` | Put this text in the composer to finish typing. |
| `broadcast` | Send this text to every running session. |
| `newSession` | Open a session from a template: `cwd`, `name`, `model`, `permissionMode`, `prompt`, `machine`; add `"direct": true` to skip the sheet. |
| `confirm` | `true` or a question: ask before running. |
| `icon` | Icon name from `web/lib/icons.js` (home screen buttons only). |

### Token table (`tokens.md`)

Each token is one table row plus a spec file in `custom/tokens/`:

```
| `$qa [request]` | Full quality check. | `tokens/qa.md` |
```

- The spec file's first line looks like `` # `$qa [request]` — full quality check ``; the text after the dash is shown in
  Quick commands. The rest tells Claude what to do when it meets the token.
- A token with `[...]` takes a request: Quick commands puts it in the composer, and the token **can be a role** in a
  session group. A token without `[...]` is a direct command: Quick commands asks, then sends it.
- When a message contains a token from the table, Claude also receives a hidden note saying what the token is and where
  its spec file is on the machine running the session. Group members receive the path to their role's spec with each task.
- The hub machine's table drives Quick commands and roles; each session machine uses its own table for the note, so keep
  the same table on all machines.

### New-session defaults

Sessions opened from the app start with **Opus**, effort **xhigh** and permission mode **bypass permissions**
(`NEW_SESSION_DEFAULTS` in `web/lib/custom.js`); the New session sheet can change each of them. For a safer default,
edit that constant, for example `permissionMode: 'default'` (ask every time).

## MCP tools in every session

Every session opened by Orbit Remote gets these tools (MCP server `orbit-remote`):

| Tool | Purpose |
|---|---|
| `orbit_remote_sessions` | List running sessions on every machine. |
| `orbit_remote_send` | Message a session (id, name, `name@machine`), `*` for everyone, `#group` for the whole group. `needs_action` is required: `false` means the message only informs. |
| `orbit_remote_group` | Work in a group: view, assign tasks, report done, review, claim shared tools, compact or reset context, report the goal reached. |
| `orbit_machines` | Machines, and which ones this session may work on. |
| `orbit_machine_run`, `_read`, `_write`, `_edit`, `_find` | Run commands and read, write, edit, find files on another machine. |
| `orbit_machine_screen`, `_input` | Screenshot, mouse and keyboard on another machine (Windows). |
| `orbit_machine_unity` | Call the Orbit Unity MCP command line on another machine; that machine must point the `ORBIT_UNITY_MCP_CLI` environment variable at its `cli.mjs`. |

The target machine has to allow it: the machine's screen → three-dot button → **allow sessions on other machines to
control it** (*Cho phiên ở máy khác điều khiển*).

## Commands

```
node src/main.mjs                   run the hub (with this machine's agent)
node src/main.mjs start             start the hub if needed and print the QR code (run.cmd)
node src/main.mjs open              like start, then open the app in this machine's browser
node src/main.mjs app [--pair]      PC app: its own Edge window
node src/main.mjs pair              print a new pairing code
node src/main.mjs node              run the machine agent: find the hub, ask to join, connect (run-node.cmd)
node src/main.mjs ensure            start the hub or machine agent in the background if not running
node src/main.mjs join <url> [code] tell this machine the hub's address
node src/main.mjs autostart on|off  run "ensure" at every Windows sign-in
node src/main.mjs disable|enable    turn Orbit Remote off or on for this machine
node src/main.mjs tailnet setup|status|off
node src/main.mjs restart [--force] restart the hub
node src/main.mjs setup [--no-admin]  install and check (setup.cmd)
node src/main.mjs doctor            check only
node src/main.mjs update            git pull, then unattended setup (the app's Set up machine button)
```

The environment variable `ORBIT_REMOTE_OFF=1` also turns Orbit Remote off on a machine.

## Security

- Every request to the hub needs a token, even from 127.0.0.1. Tokens are stored only as SHA-256 hashes.
- The 6-digit pairing code works once, lives 10 minutes, and five wrong guesses kill every live code.
- A new machine only gets a token after you tap **Cho nối**; a machine's token is bound to that machine's id.
- POST accepts JSON only, cookies are `SameSite=Lax` and `HttpOnly`, Claude's text is HTML-escaped before markdown is
  rendered, and the CSP blocks outside scripts.
- The screen stream needs a one-time ticket that lives 60 seconds. The lock-screen and sensor helpers listen on 127.0.0.1
  only; the lock-screen helper also requires a secret key readable only by SYSTEM, Administrators and the installing user.
- Revoke a device: **Settings → Paired devices → Revoke** (*Cài đặt → Thiết bị đã ghép → Thu hồi*). Revoke a machine: the
  machine's screen → **Forget this machine** (*Quên máy này*).

Default ports: 8795 hub (HTTP, UDP discovery), 8796 screen, 8797 PC app port (127.0.0.1 only), 8798 temperature helper,
8799 lock-screen helper (the last two 127.0.0.1 only).

## Known limitations

- Sessions open by hand in VS Code or a terminal can be viewed, continued (after closing them there) or forked, but not
  driven while they run there; use Anthropic's Remote Control for that.
- UDP discovery only works on the same home network; elsewhere use `custom/hub.json` or `join`.
- The screen view needs a Windows machine with `ffmpeg` and covers screens on the first graphics adapter. iPhone has no real
  full screen, so "full screen" fills the app.
- No push notifications while the app is closed. If the hub machine shuts down, the sessions it opened stop (they can be
  restarted with their context).
- Moving a session needs git with a shared remote and the target folder already cloned; files outside git do not move.

## State files

Per machine, in `~/.orbit/state/remote/`, never in git: `config.json` (port, host, `claudeCommand`, Tailscale address),
`auth.json` (paired devices and machines, hashed tokens), `hub.json` (sessions, machines, groups), `machine.json`,
`node.json`, `role.json`, `local-secret.json`, `uploads/`, `app-profile/`, and the `hub.log` and `node.log` logs. The
newest-model table lives in `~/.orbit/state/models.json`; machines without it use the repository's `data/models.json`.

## Removing the optional helpers

```
Unregister-ScheduledTask -TaskName 'Orbit Remote Sensors' -Confirm:$false
Get-Process orbit-sensors -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item 'C:\Program Files\Orbit Remote\sensors' -Recurse -Force
winget uninstall -e --id namazso.PawnIO
Unregister-ScheduledTask -TaskName 'Orbit Remote Secure Desktop' -Confirm:$false
Get-Process orbit-secure -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item 'C:\ProgramData\OrbitRemote' -Recurse -Force
node src/main.mjs autostart off
```

(Every line except the last runs in an elevated PowerShell.)

## Tests

```
node --test "tests/*.test.mjs"
```

The tests run against a fake Claude (`tests/fake-claude.mjs`), a temporary state folder and a private pipe: no tokens are
spent and the hub or machine agent running on the machine is never touched. The screen tests only read the screen and
never move the mouse or press keys.
