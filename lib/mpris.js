// SPDX-License-Identifier: Apache-2.0
//
// Publishes the player on D-Bus with the MPRIS standard, so media keys,
// GNOME's media controls and other extensions can see and control it.
// Spec: https://specifications.freedesktop.org/mpris-spec/latest/

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {State} from './player.js';

const BUS_NAME = 'org.mpris.MediaPlayer2.Radiola';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const TRACK_PATH = '/io/github/aleixenandros/Radiola/Track';

const ROOT_IFACE = `<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
</node>`;

const PLAYER_IFACE = `<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek"><arg direction="in" type="x" name="Offset"/></method>
    <method name="SetPosition">
      <arg direction="in" type="o" name="TrackId"/>
      <arg direction="in" type="x" name="Position"/>
    </method>
    <method name="OpenUri"><arg direction="in" type="s" name="Uri"/></method>
    <signal name="Seeked"><arg type="x" name="Position"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

export class MprisServer {
    /**
     * @param {object} controller the extension; provides `player`,
     *   `playStation()`, `next()`, `previous()`, `canSkip` and `openMenu()`
     */
    constructor(controller) {
        this._controller = controller;
        this._player = controller.player;
        this._trackNumber = 0;
        // True if the player kept playing through a lock screen re-enable.
        this._hasPlayed = this._player.state !== State.STOPPED;

        this._root = Gio.DBusExportedObject.wrapJSObject(ROOT_IFACE, this._rootImpl());
        this._root.export(Gio.DBus.session, OBJECT_PATH);
        this._playerObject = Gio.DBusExportedObject.wrapJSObject(PLAYER_IFACE, this._playerImpl());
        this._playerObject.export(Gio.DBus.session, OBJECT_PATH);

        this._nameId = Gio.bus_own_name_on_connection(Gio.DBus.session,
            BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);

        this._lastKey = '';
        this._player.connectObject('changed', () => this._onPlayerChanged(), this);
    }

    _rootImpl() {
        return {
            Raise: () => this._controller.openMenu(),
            Quit: () => this._player.stop(),
            CanQuit: true,
            CanRaise: true,
            HasTrackList: false,
            Identity: 'Radiola',
            SupportedUriSchemes: ['http', 'https'],
            SupportedMimeTypes: ['audio/mpeg', 'audio/aac', 'audio/ogg', 'application/x-mpegurl'],
        };
    }

    _playerImpl() {
        const self = this;
        const player = this._player;
        return {
            Next: () => this._controller.next(),
            Previous: () => this._controller.previous(),
            Pause: () => player.stop(),
            Stop: () => player.stop(),
            PlayPause: () => player.toggle(),
            Play: () => {
                if (player.state === State.STOPPED)
                    player.toggle();
            },
            Seek: () => {},
            SetPosition: () => {},
            OpenUri: uri => this._controller.playStation({name: uri, url: uri}),
            get PlaybackStatus() {
                return self._playerValue('PlaybackStatus');
            },
            Rate: 1.0,
            MinimumRate: 1.0,
            MaximumRate: 1.0,
            Position: 0,
            get Metadata() {
                return self._playerValue('Metadata');
            },
            get Volume() {
                return self._playerValue('Volume');
            },
            set Volume(value) {
                self._controller.setVolume(value);
            },
            get CanGoNext() {
                return self._playerValue('CanGoNext');
            },
            get CanGoPrevious() {
                return self._playerValue('CanGoPrevious');
            },
            get CanPlay() {
                return self._playerValue('CanPlay');
            },
            get CanPause() {
                return self._playerValue('CanPause');
            },
            CanSeek: false,
            CanControl: true,
        };
    }

    _metadata() {
        const station = this._player.station;
        const metadata = {
            'mpris:trackid': new GLib.Variant('o', `${TRACK_PATH}/${this._trackNumber}`),
        };
        if (!station)
            return metadata;

        const title = this._player.title;
        metadata['xesam:title'] = new GLib.Variant('s', title || station.name);
        metadata['xesam:artist'] = new GLib.Variant('as', title ? [station.name] : []);
        metadata['xesam:url'] = new GLib.Variant('s', station.url);
        // Prefer the cached copy of the logo: local files always load.
        const cached = this._controller.favicons.lookup(station.favicon);
        if (cached)
            metadata['mpris:artUrl'] = new GLib.Variant('s', cached.get_uri());
        else if (/^https?:\/\//.test(station.favicon ?? ''))
            metadata['mpris:artUrl'] = new GLib.Variant('s', station.favicon);
        return metadata;
    }

    _onPlayerChanged() {
        if (this._player.state !== State.STOPPED)
            this._hasPlayed = true;

        // A new station or song is a new "track" for MPRIS clients.
        const key = `${this._player.station?.url}|${this._player.title}`;
        if (key !== this._lastKey) {
            this._lastKey = key;
            this._trackNumber++;
        }

        for (const name of ['PlaybackStatus', 'Metadata', 'CanPlay', 'CanPause',
            'CanGoNext', 'CanGoPrevious', 'Volume']) {
            const info = this._playerObject.get_info().lookup_property(name);
            this._playerObject.emit_property_changed(name,
                new GLib.Variant(info.signature, this._playerValue(name)));
        }
        this._playerObject.flush();
    }

    _playerValue(name) {
        switch (name) {
        case 'Metadata': return this._metadata();
        case 'PlaybackStatus': return this._player.state === State.STOPPED ? 'Stopped' : 'Playing';
        // GNOME only shows players that can play, so stay hidden until the
        // user has started the radio at least once.
        case 'CanPlay': return this._hasPlayed && this._player.station !== null;
        case 'CanPause': return this._player.state !== State.STOPPED;
        case 'CanGoNext':
        case 'CanGoPrevious': return this._controller.canSkip;
        case 'Volume': return this._player.volume;
        }
        return null;
    }

    destroy() {
        this._player.disconnectObject(this);
        Gio.bus_unown_name(this._nameId);
        this._playerObject.unexport();
        this._root.unexport();
    }
}
