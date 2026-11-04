// SPDX-License-Identifier: Apache-2.0
//
// Radiola: internet radio in the GNOME top bar.
//
// This class is the "controller" shared by the panel menu and the MPRIS
// server: it owns the player, the station lists and the radio-browser client.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FaviconCache} from './lib/favicons.js';
import {RadiolaIndicator} from './lib/indicator.js';
import {MprisServer} from './lib/mpris.js';
import {RadioPlayer} from './lib/player.js';
import {RadioBrowser} from './lib/radioBrowser.js';
import {StationStore, sameStation} from './lib/stations.js';

const SAVE_VOLUME_DELAY_MS = 500;

export default class RadiolaExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this.icon = new Gio.FileIcon({
            file: this.dir.resolve_relative_path('icons/radiola-symbolic.svg'),
        });

        const userAgent = `Radiola/${this.metadata['version-name']} (+${this.metadata.url})`;
        this.store = new StationStore(this._settings);
        this.browser = new RadioBrowser(userAgent);
        this.favicons = new FaviconCache(userAgent);

        this.player = new RadioPlayer(userAgent);
        this.player.volume = this._settings.get_double('volume');
        this.player.station = this.store.lastStation;
        this.player.connectObject('title-changed', (_p, title) => this._notifyTitle(title), this);

        this._mpris = new MprisServer(this);

        // The panel menu only exists outside the lock screen.
        Main.sessionMode.connectObject('updated', () => this._syncSessionMode(), this);
        this._syncSessionMode();
    }

    disable() {
        // Radiola uses the unlock-dialog session mode so the music keeps
        // playing while the screen is locked. On the lock screen only the
        // player and the media controls (MPRIS) stay: the panel menu, with
        // all its keyboard handling, is destroyed (see _syncSessionMode()).
        // GNOME enables the extensions that support the lock screen first,
        // so locking does not disable Radiola. When disable() runs,
        // everything is stopped and destroyed.
        Main.sessionMode.disconnectObject(this);
        this._saveVolumeNow();

        this._destroyIndicator();
        this._mpris.destroy();
        this._mpris = null;

        this.player.disconnectObject(this);
        this.player.destroy();
        this.player = null;
        this.browser.destroy();
        this.browser = null;
        this.favicons.destroy();
        this.favicons = null;

        this._notificationSource?.disconnectObject(this);
        this._notificationSource?.destroy();
        this._notificationSource = null;
        this.store = null;
        this.icon = null;
        this._settings = null;
    }

    // ── Actions used by the menu and by MPRIS ────────────────────

    playStation(station) {
        this.player.play(station);
        this.store.lastStation = station;
        // Only if the user agreed to it in the preferences.
        if (this._settings.get_boolean('report-plays'))
            this.browser.countClick(station.uuid);
    }

    toggleFavorite() {
        if (this.player.station)
            this.store.toggle(this.player.station);
    }

    /** Whether next/previous can move to another favorite or custom station. */
    get canSkip() {
        const playlist = this.store.playlist;
        return playlist.length > 1 ||
            (playlist.length === 1 && !sameStation(playlist[0], this.player.station));
    }

    next() {
        this._skip(1);
    }

    previous() {
        this._skip(-1);
    }

    _skip(delta) {
        const playlist = this.store.playlist;
        if (playlist.length === 0)
            return;

        const index = playlist.findIndex(s => sameStation(s, this.player.station));
        const target = index < 0
            ? (delta > 0 ? 0 : playlist.length - 1)
            : (index + delta + playlist.length) % playlist.length;
        this.playStation(playlist[target]);
    }

    setVolume(value) {
        this.player.volume = value;

        // Saving on every slider step would write to disk constantly.
        if (this._saveVolumeId)
            GLib.source_remove(this._saveVolumeId);
        this._saveVolumeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_VOLUME_DELAY_MS, () => {
            this._saveVolumeId = 0;
            this._settings.set_double('volume', this.player.volume);
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveVolumeNow() {
        if (!this._saveVolumeId)
            return;
        GLib.source_remove(this._saveVolumeId);
        this._saveVolumeId = 0;
        this._settings.set_double('volume', this.player.volume);
    }

    openMenu() {
        if (!Main.sessionMode.isLocked)
            this._indicator?.menu.open();
    }

    // ── Helpers ──────────────────────────────────────────────────

    _syncSessionMode() {
        if (Main.sessionMode.isLocked) {
            this._destroyIndicator();
        } else if (!this._indicator) {
            this._indicator = new RadiolaIndicator(this);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        }
    }

    _destroyIndicator() {
        this._indicator?.destroy();
        this._indicator = null;
    }

    _notifyTitle(title) {
        if (!this._settings.get_boolean('notify-title-change') || Main.sessionMode.isLocked)
            return;

        if (!this._notificationSource) {
            this._notificationSource = new MessageTray.Source({title: 'Radiola', icon: this.icon});
            this._notificationSource.connectObject(
                'destroy', () => (this._notificationSource = null), this);
            Main.messageTray.add(this._notificationSource);
        }

        const notification = new MessageTray.Notification({
            source: this._notificationSource,
            title,
            body: this.player.station?.name ?? '',
            isTransient: true,
        });
        this._notificationSource.addNotification(notification);
    }
}
