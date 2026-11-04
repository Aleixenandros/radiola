// SPDX-License-Identifier: Apache-2.0
//
// Downloads station logos once and keeps them in ~/.cache/radiola.
// Many logo URLs are broken or slow; checking them here means the menu
// can always fall back to the Radiola icon, and logos load instantly
// the next time. Logos chosen by the user are file:// URIs (see logos.js)
// and are used as they are.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {createSession} from './http.js';

Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const MAX_SIZE = 512 * 1024;

export class FaviconCache {
    /**
     * @param {string} userAgent
     */
    constructor(userAgent) {
        this._session = createSession(userAgent);
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'radiola', 'favicons']));
        this._failed = new Set();
        this._pending = new Map();
    }

    _fileFor(url) {
        return this._dir.get_child(GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1));
    }

    /**
     * @param {string} url
     * @returns {Gio.File|null} the cached logo, if it was downloaded before
     */
    lookup(url) {
        if (!url)
            return null;
        const file = url.startsWith('file://') ? Gio.File.new_for_uri(url) : this._fileFor(url);
        return file.query_exists(null) ? file : null;
    }

    /**
     * @param {string} url
     * @returns {Promise<Gio.File|null>} the logo, or null if it cannot be used
     */
    get(url) {
        if (url?.startsWith('file://'))
            return Promise.resolve(this.lookup(url));
        if (!/^https?:\/\//i.test(url ?? '') || this._failed.has(url))
            return Promise.resolve(null);

        const cached = this.lookup(url);
        if (cached)
            return Promise.resolve(cached);

        // Several menu items may ask for the same logo at once.
        if (!this._pending.has(url)) {
            this._pending.set(url, this._download(url).finally(() => this._pending.delete(url)));
        }
        return this._pending.get(url);
    }

    async _download(url) {
        let bytes;
        try {
            const message = Soup.Message.new('GET', url);
            if (!message)
                throw new Error('invalid URL');

            bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_LOW, null);
            const [type] = message.get_response_headers().get_content_type();
            if (message.get_status() !== Soup.Status.OK || !type?.startsWith('image/') ||
                bytes.get_size() === 0 || bytes.get_size() > MAX_SIZE)
                throw new Error('unusable logo');
        } catch {
            this._failed.add(url);
            return null;
        }

        try {
            GLib.mkdir_with_parents(this._dir.get_path(), 0o755);
            const file = this._fileFor(url);
            await file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            return file;
        } catch {
            return null;
        }
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }
}
