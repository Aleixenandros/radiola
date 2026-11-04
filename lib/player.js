// SPDX-License-Identifier: GPL-2.0-or-later
//
// Internet radio player built on GStreamer's playbin.

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gst from 'gi://Gst?version=1.0';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {createSession, isCancelled, resolveStreamUrl} from './http.js';

/** @typedef {import('./radioBrowser.js').Station} Station */

export const State = Object.freeze({
    STOPPED: 'stopped',
    LOADING: 'loading',
    PLAYING: 'playing',
});

// playbin flags: play audio only, with software volume.
const PLAY_FLAG_AUDIO = 1 << 1;
const PLAY_FLAG_SOFT_VOLUME = 1 << 4;

export const RadioPlayer = GObject.registerClass({
    Signals: {
        // state, station or title changed
        'changed': {},
        // a new song title arrived from the stream
        'title-changed': {param_types: [GObject.TYPE_STRING]},
        // playback failed; the argument is a readable message
        'error': {param_types: [GObject.TYPE_STRING]},
    },
}, class RadioPlayer extends GObject.Object {
    /**
     * @param {string} userAgent sent when downloading playlists
     */
    constructor(userAgent) {
        super();
        Gst.init(null);

        this._session = createSession(userAgent);
        this._state = State.STOPPED;
        this._station = null;
        this._title = '';
        this._volume = 0.6;
        this._playbin = null;
        this._cancellable = null;
    }

    /** @returns {string} one of State */
    get state() {
        return this._state;
    }

    /** @returns {Station|null} the current (or last) station */
    get station() {
        return this._station;
    }

    /** Select a station without playing it, e.g. the last one used. */
    set station(station) {
        if (this._state !== State.STOPPED)
            this.stop();
        this._station = station;
        this.emit('changed');
    }

    /** @returns {string} current song title, if the stream sends one */
    get title() {
        return this._title;
    }

    /** @returns {number} volume between 0 and 1 */
    get volume() {
        return this._volume;
    }

    set volume(value) {
        const volume = Math.min(Math.max(value, 0), 1);
        if (volume === this._volume)
            return;

        this._volume = volume;
        if (this._playbin)
            this._playbin.volume = volume ** 3; // perceptual curve
        this.emit('changed');
    }

    /**
     * @param {Station} station
     */
    async play(station) {
        this._stopPipeline();
        this._station = station;
        this._title = '';
        this._setState(State.LOADING);

        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        let uri;
        try {
            uri = await resolveStreamUrl(this._session, station.url, cancellable);
        } catch (error) {
            if (!isCancelled(error))
                this._fail(_('Could not open the station address'));
            return;
        }
        if (cancellable.is_cancelled())
            return;

        try {
            this._ensurePipeline();
        } catch {
            this._fail(_('GStreamer is not available'));
            return;
        }

        this._playbin.uri = uri;
        if (this._playbin.set_state(Gst.State.PLAYING) === Gst.StateChangeReturn.FAILURE)
            this._fail(_('Could not play this station'));
    }

    stop() {
        this._stopPipeline();
        this._title = '';
        this._setState(State.STOPPED);
    }

    /** Play the current station, or stop if it is already playing. */
    toggle() {
        if (this._state !== State.STOPPED)
            this.stop();
        else if (this._station)
            this.play(this._station);
    }

    _ensurePipeline() {
        if (this._playbin)
            return;

        const playbin = Gst.ElementFactory.make('playbin', 'radiola');
        if (!playbin)
            throw new Error('playbin missing');

        playbin.flags = PLAY_FLAG_AUDIO | PLAY_FLAG_SOFT_VOLUME;
        playbin.volume = this._volume ** 3;

        const bus = playbin.get_bus();
        bus.add_signal_watch();
        this._busId = bus.connect('message', (_bus, message) => this._onMessage(message));

        this._playbin = playbin;
    }

    _stopPipeline() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._playbin?.set_state(Gst.State.NULL);
    }

    _onMessage(message) {
        switch (message.type) {
        case Gst.MessageType.STATE_CHANGED: {
            if (message.src !== this._playbin)
                break;
            const [, newState] = message.parse_state_changed();
            if (newState === Gst.State.PLAYING && this._state === State.LOADING)
                this._setState(State.PLAYING);
            break;
        }
        case Gst.MessageType.BUFFERING: {
            if (this._state === State.STOPPED)
                break;
            // Recommended GStreamer pattern for network streams: pause
            // while the buffer fills up, resume when it is full.
            const percent = message.parse_buffering();
            if (percent < 100) {
                this._playbin.set_state(Gst.State.PAUSED);
                this._setState(State.LOADING);
            } else {
                this._playbin.set_state(Gst.State.PLAYING);
            }
            break;
        }
        case Gst.MessageType.TAG: {
            const [found, title] = message.parse_tag().get_string(Gst.TAG_TITLE);
            const clean = found ? title.trim() : '';
            if (clean && clean !== this._title) {
                this._title = clean;
                this.emit('changed');
                this.emit('title-changed', clean);
            }
            break;
        }
        case Gst.MessageType.ERROR: {
            const [error] = message.parse_error();
            console.warn(`[Radiola] ${this._station?.url}: ${error.message}`);
            this._fail(_('Could not play this station'));
            break;
        }
        case Gst.MessageType.EOS:
            this._fail(_('The station stopped broadcasting'));
            break;
        }
    }

    _setState(state) {
        if (this._state === state)
            return;
        this._state = state;
        this.emit('changed');
    }

    _fail(message) {
        this.stop();
        this.emit('error', message);
    }

    destroy() {
        this._stopPipeline();
        if (this._playbin) {
            const bus = this._playbin.get_bus();
            bus.disconnect(this._busId);
            bus.remove_signal_watch();
            this._playbin = null;
        }
        this._session.abort();
        this._session = null;
    }
});
