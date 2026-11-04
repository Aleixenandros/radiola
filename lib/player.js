// SPDX-License-Identifier: Apache-2.0
//
// Internet radio player. GStreamer runs in a separate process
// (playerHelper.js, started on demand) and this class drives it through
// its stdin and stdout. GStreamer must never be initialized inside GNOME
// Shell: see the note at the top of playerHelper.js.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {createSession, isCancelled, resolveStreamUrl} from './http.js';

/** @typedef {import('./radioBrowser.js').Station} Station */

export const State = Object.freeze({
    STOPPED: 'stopped',
    LOADING: 'loading',
    PLAYING: 'playing',
});

const SIGTERM = 15;

const encoder = new TextEncoder();

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

        this._session = createSession(userAgent);
        this._state = State.STOPPED;
        this._station = null;
        this._title = '';
        this._volume = 0.6;
        this._cancellable = null;

        // Playback process and the commands waiting to be written to it.
        this._process = null;
        this._processCancellable = null;
        this._queue = [];
        this._writing = false;
        this._playId = 0;
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
        this._send({cmd: 'volume', value: this._gain});
        this.emit('changed');
    }

    /** @returns {number} volume for GStreamer, on a perceptual curve */
    get _gain() {
        return this._volume ** 3;
    }

    /**
     * @param {Station} station
     */
    async play(station) {
        this._cancelPending();
        // Silence the previous station while the new one loads.
        this._send({cmd: 'stop'});

        this._station = station;
        this._title = '';
        this._setState(State.LOADING);

        const id = ++this._playId;
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
            this._ensureProcess();
        } catch (error) {
            console.warn(`[Radiola] Could not start the playback process: ${error.message}`);
            this._fail(_('Could not play this station'));
            return;
        }

        this._send({cmd: 'play', id, uri, volume: this._gain});
    }

    stop() {
        this._cancelPending();
        this._stopProcess();
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

    _cancelPending() {
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    // ── Playback process ─────────────────────────────────────────

    _ensureProcess() {
        if (this._process)
            return;

        const gjs = GLib.find_program_in_path('gjs');
        if (!gjs)
            throw new Error('gjs not found');

        const [thisFile] = GLib.filename_from_uri(import.meta.url);
        const helper = GLib.build_filenamev([GLib.path_get_dirname(thisFile), 'playerHelper.js']);
        const process = Gio.Subprocess.new(
            [gjs, '-m', helper],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
        const cancellable = new Gio.Cancellable();

        this._process = process;
        this._processCancellable = cancellable;
        this._queue = [];
        this._writing = false;

        const stdout = new Gio.DataInputStream({
            base_stream: process.get_stdout_pipe(),
            close_base_stream: true,
        });
        this._readEvents(stdout, cancellable);

        process.wait_async(cancellable, (_process, result) => {
            try {
                process.wait_finish(result);
            } catch {
                return;
            }
            if (!cancellable.is_cancelled())
                this._onProcessExited();
        });
    }

    _stopProcess() {
        // SIGTERM: the process stops GStreamer and exits by itself.
        this._process?.send_signal(SIGTERM);
        this._dropProcess();
    }

    /** Forget the process; its pending reads and writes are cancelled. */
    _dropProcess() {
        this._processCancellable?.cancel();
        this._process = null;
        this._processCancellable = null;
        this._queue = [];
        this._writing = false;
    }

    _onProcessExited() {
        this._dropProcess();

        if (this._state !== State.STOPPED) {
            console.warn('[Radiola] The playback process exited unexpectedly');
            this._fail(_('Could not play this station'));
        }
    }

    /**
     * Queue a command for the playback process. Does nothing if it is
     * not running: it always receives the volume with each play command.
     *
     * @param {object} command
     */
    _send(command) {
        if (!this._process)
            return;

        // While the slider moves, only the latest volume matters.
        const last = this._queue.at(-1);
        if (command.cmd === 'volume' && last?.cmd === 'volume')
            this._queue[this._queue.length - 1] = command;
        else
            this._queue.push(command);

        this._flush();
    }

    _flush() {
        if (this._writing || this._queue.length === 0)
            return;

        const command = this._queue.shift();
        this._write(encoder.encode(`${JSON.stringify(command)}\n`));
    }

    /**
     * Asynchronous, so GNOME Shell never blocks if the process stops
     * reading.
     *
     * @param {Uint8Array} data
     */
    _write(data) {
        this._writing = true;
        const cancellable = this._processCancellable;
        this._process.get_stdin_pipe().write_bytes_async(
            new GLib.Bytes(data), GLib.PRIORITY_DEFAULT, cancellable, (stream, result) => {
                let written;
                try {
                    written = stream.write_bytes_finish(result);
                } catch (error) {
                    if (!isCancelled(error))
                        console.warn(`[Radiola] Could not talk to the playback process: ${error.message}`);
                    return;
                }
                if (cancellable.is_cancelled())
                    return;

                this._writing = false;
                if (written < data.length)
                    this._write(data.subarray(written));
                else
                    this._flush();
            });
    }

    /**
     * @param {Gio.DataInputStream} stdout
     * @param {Gio.Cancellable} cancellable
     */
    _readEvents(stdout, cancellable) {
        stdout.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, result) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(result);
            } catch (error) {
                if (!isCancelled(error))
                    console.warn(`[Radiola] Could not read from the playback process: ${error.message}`);
                return;
            }

            // End of file: the process exited (handled by wait_async).
            if (line === null || cancellable.is_cancelled())
                return;

            this._onEvent(line);
            this._readEvents(stdout, cancellable);
        });
    }

    /**
     * @param {string} line one JSON event from the playback process
     */
    _onEvent(line) {
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            return;
        }

        // Ignore events from a station that is no longer playing.
        if (event.id !== this._playId || this._state === State.STOPPED)
            return;

        switch (event.event) {
        case 'state':
            this._setState(event.state === 'playing' ? State.PLAYING : State.LOADING);
            break;
        case 'title': {
            const clean = String(event.title ?? '').trim();
            if (clean && clean !== this._title) {
                this._title = clean;
                this.emit('changed');
                this.emit('title-changed', clean);
            }
            break;
        }
        case 'error':
            console.warn(`[Radiola] ${this._station?.url}: ${event.message}`);
            this._fail(_('Could not play this station'));
            break;
        case 'eos':
            this._fail(_('The station stopped broadcasting'));
            break;
        case 'unavailable':
            this._fail(_('GStreamer is not available'));
            break;
        }
    }

    // ── Helpers ──────────────────────────────────────────────────

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
        this._cancelPending();
        this._stopProcess();
        this._session.abort();
        this._session = null;
    }
});
