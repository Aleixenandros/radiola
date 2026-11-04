// SPDX-License-Identifier: GPL-2.0-or-later
//
// Radiola: internet radio in the GNOME top bar.
//
// This class is the "controller" shared by the panel menu and the MPRIS
// server: it owns the player, the favorites and the radio-browser client.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FaviconCache} from './lib/favicons.js';
import {RadiolaIndicator} from './lib/indicator.js';
import {MprisServer} from './lib/mpris.js';
import {RadioPlayer, State} from './lib/player.js';
import {RadioBrowser} from './lib/radioBrowser.js';
import {StationStore, sameStation} from './lib/stations.js';

const SAVE_VOLUME_DELAY_MS = 500;

// When the screen locks, GNOME disables the extensions that do not run on
// the lock screen and, to keep their order, also disables and re-enables
// every extension enabled after them, Radiola included. To keep the music
// playing through that, a playing player is "parked" on disable() and
// picked up again by the enable() that follows right away. If no enable()
// comes (the user really turned Radiola off), it is destroyed shortly after.
const PARK_TIMEOUT_MS = 1000;
let parkedPlayer = null;
let parkedTimeoutId = 0;

function parkPlayer(player) {
    takeParkedPlayer()?.destroy();
    parkedPlayer = player;
    parkedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PARK_TIMEOUT_MS, () => {
        parkedTimeoutId = 0;
        parkedPlayer?.destroy();
        parkedPlayer = null;
        return GLib.SOURCE_REMOVE;
    });
}

function takeParkedPlayer() {
    if (!parkedPlayer)
        return null;
    GLib.source_remove(parkedTimeoutId);
    parkedTimeoutId = 0;
    const player = parkedPlayer;
    parkedPlayer = null;
    return player;
}

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

        this.player = takeParkedPlayer();
        if (!this.player) {
            this.player = new RadioPlayer(userAgent);
            this.player.volume = this._settings.get_double('volume');
            this.player.station = this.store.lastStation;
        }
        this.player.connectObject('title-changed', (_p, title) => this._notifyTitle(title), this);

        this._mpris = new MprisServer(this);

        this._indicator = new RadiolaIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Keep playing on the lock screen, but never show our menu there.
        Main.sessionMode.connectObject('updated', () => this._syncSessionMode(), this);
        this._syncSessionMode();
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        this._saveVolumeNow();

        this._indicator.destroy();
        this._indicator = null;
        this._mpris.destroy();
        this._mpris = null;

        this.player.disconnectObject(this);
        if (this.player.state === State.STOPPED)
            this.player.destroy();
        else
            parkPlayer(this.player);
        this.player = null;
        this.browser.destroy();
        this.browser = null;
        this.favicons.destroy();
        this.favicons = null;

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
        this.browser.countClick(station.uuid);
    }

    toggleFavorite() {
        if (this.player.station)
            this.store.toggle(this.player.station);
    }

    /** Whether next/previous can move to another favorite. */
    get canSkip() {
        const favorites = this.store.favorites;
        return favorites.length > 1 ||
            (favorites.length === 1 && !sameStation(favorites[0], this.player.station));
    }

    next() {
        this._skip(1);
    }

    previous() {
        this._skip(-1);
    }

    _skip(delta) {
        const favorites = this.store.favorites;
        if (favorites.length === 0)
            return;

        const index = favorites.findIndex(s => sameStation(s, this.player.station));
        const target = index < 0
            ? (delta > 0 ? 0 : favorites.length - 1)
            : (index + delta + favorites.length) % favorites.length;
        this.playStation(favorites[target]);
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
            this._indicator.menu.open();
    }

    // ── Helpers ──────────────────────────────────────────────────

    _syncSessionMode() {
        const locked = Main.sessionMode.isLocked;
        this._indicator.visible = !locked;
        if (locked)
            this._indicator.menu.close();
    }

    _notifyTitle(title) {
        if (!this._settings.get_boolean('notify-title-change') || Main.sessionMode.isLocked)
            return;

        if (!this._notificationSource) {
            this._notificationSource = new MessageTray.Source({title: 'Radiola', icon: this.icon});
            this._notificationSource.connect('destroy', () => (this._notificationSource = null));
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
