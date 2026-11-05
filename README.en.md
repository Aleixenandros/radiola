# Radiola

[Español](README.md) · **English**

Internet radio in the GNOME top bar.

- **More than 50,000 stations worldwide** from the free
  [radio-browser.info](https://www.radio-browser.info) directory: search by
  name or browse the most popular ones in your country.
- **Favorites**: save them with the star, reorder and edit them.
- **Custom stations** for those that are not in the directory: stream
  address (`.pls` and `.m3u` playlists work too), name and an optional
  logo, either an image from your files or its web address. They have
  their own section in the menu.
- **Song title** of what is playing, optionally shown in the top bar, ready
  to copy, or announced with a notification when it changes.
- **Media keys and standard controls (MPRIS)**: works with your keyboard's
  media keys, GNOME's media controls and other extensions such as
  [Unified Panel](https://github.com/Aleixenandros/unified-panel).
  Next and previous go through your favorites and custom stations.
- **Keeps playing while the screen is locked**. The menu is not shown on
  the lock screen.
- Backup: export and import your favorites and custom stations as JSON.

Supported: **GNOME Shell 51**.

## Installation

Check your version with `gnome-shell --version`.

### Option 1: from extensions.gnome.org

Install it with one click from
[its page on extensions.gnome.org](https://extensions.gnome.org/extension/11635/radiola/)
or from the **Extension Manager** app, searching for “Radiola”.

### Option 2: from a published release

1. Download `radiola@aleixenandros.me.shell-extension.zip` from the
   [latest release](https://github.com/Aleixenandros/radiola/releases/latest).
2. Install and enable it:

   ```sh
   gnome-extensions install --force radiola@aleixenandros.me.shell-extension.zip
   gnome-extensions enable radiola@aleixenandros.me
   ```

3. Log out and back in.

### Option 3: from source

No code compilation or Node.js needed: the `build.sh` script packs and
installs the extension with the standard GNOME tools.

```sh
git clone https://github.com/Aleixenandros/radiola.git
cd radiola
./build.sh
```

Without arguments it shows a menu with the most common actions. You can
also call it directly:

| Command                  | What it does                                          |
|--------------------------|-------------------------------------------------------|
| `./build.sh install -e`  | Build, install and enable the extension               |
| `./build.sh install`     | Build and install                                     |
| `./build.sh build`       | Only build the zip in `build/`                        |
| `./build.sh status`      | Version, compatibility with your GNOME and state      |
| `./build.sh prefs`       | Open the preferences                                  |
| `./build.sh uninstall`   | Uninstall                                             |
| `./build.sh help`        | All commands                                          |

If a tool is missing, the script prints the exact command to install it on
Fedora, Debian/Ubuntu, Arch or openSUSE.

When done, log out and back in to load the new version (required on
Wayland).

To update later:

```sh
git pull
./build.sh install
```

If you prefer `make`, the same shortcuts exist (`make install`, `make pack`…).

### Requirements

GStreamer with the usual plugins for MP3 and AAC, and `gjs`. On Fedora
and most distributions they come with GNOME.

### Uninstall

```sh
gnome-extensions uninstall radiola@aleixenandros.me
```

or `./build.sh uninstall` if you installed it from source.

## Usage

- Click the radio icon in the top bar.
- **Discover stations** lists the popular ones in your country; type to
  search by name. Click a station to listen to it.
- Press the **star** to save the station that is playing to your favorites.
- In **Preferences** you can reorder, edit, remove, export and import
  favorites, and choose the country for popular stations.

## Privacy

Radiola connects to:

- **radio-browser.info**, to search stations and list popular ones. If
  you turn on "Help rank the directory" in the preferences (off by default),
  playing a station from the directory tells radio-browser.info, as its API
  asks, to rank the most played stations.
- **The station you listen to**, for the audio and its logo. Logos are kept
  in `~/.cache/radiola` so they are not downloaded every time.

No other data is collected or sent.

## Releasing a new version

From `main`, with no pending changes:

```sh
make release VERSION=1.1
```

This sets `version-name` in `metadata.json`, checks that the package
builds, commits, creates the `v1.1` tag and pushes it. When the tag
arrives, GitHub Actions (`.github/workflows/release.yml`) builds the zip
and creates the GitHub Release with the change notes.

Then download the zip from the Release and upload it by hand at
<https://extensions.gnome.org/upload/>, which has no automated upload.
extensions.gnome.org assigns the `version` number; we only control
`version-name`.

## Project layout

```
extension.js         controller: ties player, menu, MPRIS and notifications
prefs.js             preferences window (libadwaita)
lib/player.js        player: drives the playback process
lib/playerHelper.js  playback process (GStreamer playbin), outside GNOME Shell
lib/mpris.js         MPRIS server on D-Bus
lib/indicator.js     top bar button and its menu
lib/radioBrowser.js  radio-browser.info client
lib/stations.js      favorites stored in GSettings
lib/favicons.js      logo cache in ~/.cache/radiola
lib/logos.js         logos chosen by the user, copied to ~/.local/share/radiola/logos
lib/http.js          HTTP helpers (libsoup 3) and .pls/.m3u playlists
icons/               extension icon
schemas/             GSettings schema (all options)
po/                  translations (es)
build.sh             build, install, translations (also used by the Makefile)
.github/workflows/   automatic release publishing
```

## How it works (for contributors)

- `prefs.js` shares `lib/stations.js`, `lib/radioBrowser.js` and
  `lib/http.js` with the extension; they only depend on GLib and libsoup.
  Do not import anything from GNOME Shell in those three modules.
- **Lock screen**: the extension declares `unlock-dialog` in
  `session-modes` so the music keeps playing while the screen is locked
  (the menu is hidden). At login, GNOME enables the extensions that run
  on the lock screen first, so locking does not disable Radiola.
  `disable()` always stops and destroys everything. If Radiola is turned
  on in the middle of a session, the music stops when the screen locks
  until the next login.
- **GStreamer is never loaded inside GNOME Shell.** `lib/player.js`
  starts `lib/playerHelper.js` with `gjs -m` when a station plays and
  talks to it over stdin/stdout (one JSON line per message). The first
  `Gst.init()` after boot rescans plugins that depend on `/dev/dri`
  (Vulkan, VA-API); the scanner connects to the Wayland display, which
  inside the shell is the shell itself, blocked waiting for it: the
  session freezes at login. Do not import `gi://Gst` in any module the
  shell loads.
- **radio-browser.info** asks clients to send a User-Agent and to report
  each play (`/json/url/<id>`). Radiola only reports plays if the user turns
  on "Help rank the directory" in the preferences (off by default). The
  client spreads requests across several mirrors and retries when one fails.

Guidelines:
- Plain modern JavaScript (ES modules), following the GNOME Shell code style.
- Everything done in `enable()` must be undone in `disable()`.
- User-visible strings go through `_()`; run `./build.sh pot` after changing them.

## Credits

Inspired by [Internet Radio](https://github.com/hslbck/gnome-shell-extension-radio)
by hslbck. Radiola is a new implementation, written from scratch for
GNOME 51.

Station directory: [radio-browser.info](https://www.radio-browser.info).

## License

Apache-2.0. See the [LICENSE](LICENSE) file.
