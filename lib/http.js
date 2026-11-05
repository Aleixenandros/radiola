// SPDX-License-Identifier: Apache-2.0
//
// Small HTTP helpers on top of libsoup 3. Used by the extension and by
// the preferences window.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

/**
 * @param {string} userAgent
 * @returns {Soup.Session}
 */
export function createSession(userAgent) {
    return new Soup.Session({user_agent: userAgent, timeout: 15});
}

/**
 * Download a URL as text.
 *
 * @param {Soup.Session} session
 * @param {string} url
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<string>}
 */
export async function fetchText(session, url, cancellable = null) {
    const message = Soup.Message.new('GET', url);
    if (!message)
        throw new Error(`Invalid URL: ${url}`);

    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
    const status = message.get_status();
    if (status !== Soup.Status.OK)
        throw new Error(`HTTP ${status} for ${url}`);

    return new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
}

/**
 * @param {Error} error
 * @returns {boolean} whether the error comes from a cancelled request
 */
export function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * Many stations publish a .pls or .m3u playlist instead of the stream
 * itself. GStreamer cannot open those, so return the first stream URL
 * inside. Any other URL (including HLS .m3u8) is returned unchanged.
 *
 * @param {Soup.Session} session
 * @param {string} url
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<string>}
 */
export async function resolveStreamUrl(session, url, cancellable = null) {
    const path = url.split(/[?#]/)[0].toLowerCase();
    const isPls = path.endsWith('.pls');
    const isM3u = path.endsWith('.m3u');
    if (!isPls && !isM3u)
        return url;

    const text = await fetchText(session, url, cancellable);
    const lines = text.split(/\r?\n/).map(line => line.trim());
    const found = isPls
        ? lines.find(line => /^File\d+=/i.test(line))?.replace(/^File\d+=/i, '')
        : lines.find(line => /^https?:\/\//i.test(line));

    return found?.trim() || url;
}
