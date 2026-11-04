#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: Apache-2.0
//
// Radiola playback process. It is NOT loaded by GNOME Shell: player.js
// starts it with `gjs -m` when a station plays, so GStreamer never runs
// inside the compositor.
//
// Why a separate process: the first Gst.init() after boot rescans some
// GStreamer plugins (Vulkan, VA-API), because they depend on /dev/dri,
// which is recreated on every boot. The plugin scanner then connects to
// the Wayland display and waits for an answer. Inside GNOME Shell that
// display is the shell itself, blocked in Gst.init() waiting for the
// scanner: the session freezes for good.
//
// Protocol: one JSON object per line.
//   stdin, commands:  {cmd: 'play', id, uri, volume}
//                     {cmd: 'stop'}
//                     {cmd: 'volume', value}
//   stdout, events:   {event: 'state', id, state: 'loading' | 'playing'}
//                     {event: 'title', id, title}
//                     {event: 'error', id, message}
//                     {event: 'eos', id}
//                     {event: 'unavailable', id}
// `id` identifies the play command an event belongs to. The process exits
// cleanly on SIGTERM (sent by player.js when playback stops) and when stdin
// is closed, so it never outlives GNOME Shell.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';

const SIGTERM = 15;

// playbin flags: play audio only, with software volume.
const PLAY_FLAG_AUDIO = 1 << 1;
const PLAY_FLAG_SOFT_VOLUME = 1 << 4;

let Gst = null;
try {
    Gst = (await import('gi://Gst?version=1.0')).default;
    Gst.init(null);
} catch (error) {
    printerr(`[Radiola] GStreamer is not available: ${error.message}`);
    Gst = null;
}

const loop = new GLib.MainLoop(null, false);
const encoder = new TextEncoder();
const stdout = new GioUnix.OutputStream({fd: 1, close_fd: false});
const stdin = new Gio.DataInputStream({
    base_stream: new GioUnix.InputStream({fd: 0, close_fd: false}),
});

let playbin = null;
let playId = 0;
let active = false;
let buffering = false;
let title = '';

function send(event) {
    try {
        stdout.write_all(encoder.encode(`${JSON.stringify(event)}\n`), null);
    } catch {
        // GNOME Shell is gone.
        quit();
    }
}

function ensurePipeline() {
    if (playbin)
        return true;

    playbin = Gst?.ElementFactory.make('playbin', 'radiola') ?? null;
    if (!playbin)
        return false;

    playbin.flags = PLAY_FLAG_AUDIO | PLAY_FLAG_SOFT_VOLUME;
    const bus = playbin.get_bus();
    bus.add_signal_watch();
    bus.connect('message', (_bus, message) => onMessage(message));
    return true;
}

function play(id, uri, volume) {
    stop();
    playId = id;
    if (!ensurePipeline()) {
        send({event: 'unavailable', id});
        return;
    }

    active = true;
    buffering = false;
    title = '';
    playbin.uri = uri;
    playbin.volume = volume;
    if (playbin.set_state(Gst.State.PLAYING) === Gst.StateChangeReturn.FAILURE)
        fail('Could not start the pipeline');
}

function stop() {
    active = false;
    playbin?.set_state(Gst.State.NULL);
}

function fail(message) {
    const id = playId;
    stop();
    send({event: 'error', id, message});
}

function onMessage(message) {
    if (!active)
        return;

    switch (message.type) {
    case Gst.MessageType.STATE_CHANGED: {
        if (message.src !== playbin)
            break;
        const [, newState] = message.parse_state_changed();
        if (newState === Gst.State.PLAYING)
            send({event: 'state', id: playId, state: 'playing'});
        break;
    }
    case Gst.MessageType.BUFFERING: {
        // Recommended GStreamer pattern for network streams: pause while
        // the buffer fills up, resume when it is full.
        const percent = message.parse_buffering();
        if (percent < 100 && !buffering) {
            buffering = true;
            playbin.set_state(Gst.State.PAUSED);
            send({event: 'state', id: playId, state: 'loading'});
        } else if (percent >= 100 && buffering) {
            buffering = false;
            playbin.set_state(Gst.State.PLAYING);
        }
        break;
    }
    case Gst.MessageType.TAG: {
        const [found, value] = message.parse_tag().get_string(Gst.TAG_TITLE);
        const clean = found ? value.trim() : '';
        if (clean && clean !== title) {
            title = clean;
            send({event: 'title', id: playId, title});
        }
        break;
    }
    case Gst.MessageType.ERROR: {
        const [error] = message.parse_error();
        fail(error.message);
        break;
    }
    case Gst.MessageType.EOS: {
        const id = playId;
        stop();
        send({event: 'eos', id});
        break;
    }
    }
}

function handle(line) {
    let command;
    try {
        command = JSON.parse(line);
    } catch {
        printerr(`[Radiola] Ignoring invalid command: ${line}`);
        return;
    }

    switch (command.cmd) {
    case 'play':
        play(command.id, command.uri, command.volume);
        break;
    case 'stop':
        stop();
        break;
    case 'volume':
        if (playbin)
            playbin.volume = command.value;
        break;
    }
}

function readCommands() {
    stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
        let line;
        try {
            [line] = stream.read_line_finish_utf8(result);
        } catch (error) {
            printerr(`[Radiola] Could not read commands: ${error.message}`);
            quit();
            return;
        }

        // End of file: GNOME Shell closed the pipe or exited.
        if (line === null) {
            quit();
            return;
        }

        handle(line);
        readCommands();
    });
}

function quit() {
    stop();
    loop.quit();
}

GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, SIGTERM, () => {
    quit();
    return GLib.SOURCE_REMOVE;
});

readCommands();
await loop.runAsync();
