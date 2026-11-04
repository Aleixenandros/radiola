// SPDX-License-Identifier: GPL-2.0-or-later
//
// Client for the free and open radio-browser.info directory.
// API docs: https://api.radio-browser.info/

import GLib from 'gi://GLib';

import {createSession, fetchText, isCancelled} from './http.js';

// Public mirrors; one is picked at random and the next ones are tried
// when it does not answer.
const SERVERS = [
    'de1.api.radio-browser.info',
    'de2.api.radio-browser.info',
    'fi1.api.radio-browser.info',
];

const RESULTS_LIMIT = 40;

// The servers sometimes drop connections, so go through the list twice.
const ATTEMPTS = SERVERS.length * 2;

/**
 * @typedef {object} Station
 * @property {string} name
 * @property {string} url       stream or playlist URL
 * @property {string} [uuid]    radio-browser.info station id
 * @property {string} [favicon] logo URL
 * @property {string} [country] ISO country code
 * @property {string} [codec]
 * @property {number} [bitrate] kbit/s
 */

/** @returns {Station} */
function toStation(raw) {
    return {
        uuid: raw.stationuuid,
        name: (raw.name ?? '').trim(),
        url: raw.url_resolved || raw.url,
        favicon: raw.favicon || '',
        country: raw.countrycode || '',
        codec: raw.codec || '',
        bitrate: raw.bitrate || 0,
    };
}

/**
 * Country of the user, from the language settings ("es_ES.UTF-8" gives "ES").
 *
 * @returns {string}
 */
export function localCountryCode() {
    for (const name of GLib.get_language_names()) {
        const match = name.match(/^[a-z]{2,3}_([A-Z]{2})/);
        if (match)
            return match[1];
    }
    return '';
}

export class RadioBrowser {
    /**
     * @param {string} userAgent the API asks clients to identify themselves
     */
    constructor(userAgent) {
        this._session = createSession(userAgent);
        this._serverIndex = Math.floor(Math.random() * SERVERS.length);
    }

    async _get(path, params = {}, cancellable = null) {
        const query = Object.entries(params)
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
            .join('&');
        let lastError = null;

        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            const index = (this._serverIndex + attempt) % SERVERS.length;
            try {
                const text = await fetchText(this._session,
                    `https://${SERVERS[index]}${path}?${query}`, cancellable);
                this._serverIndex = index;
                return JSON.parse(text);
            } catch (error) {
                if (isCancelled(error))
                    throw error;
                lastError = error;
            }
        }
        throw lastError;
    }

    /**
     * @param {string} text station name to look for
     * @param {Gio.Cancellable} [cancellable]
     * @returns {Promise<Station[]>}
     */
    async search(text, cancellable = null) {
        const results = await this._get('/json/stations/search', {
            name: text,
            limit: RESULTS_LIMIT,
            hidebroken: 'true',
            order: 'clickcount',
            reverse: 'true',
        }, cancellable);
        return results.map(toStation);
    }

    /**
     * Most voted stations of a country.
     *
     * @param {string} countryCode ISO code such as "ES"
     * @param {Gio.Cancellable} [cancellable]
     * @returns {Promise<Station[]>}
     */
    async popular(countryCode, cancellable = null) {
        const params = {
            limit: RESULTS_LIMIT,
            hidebroken: 'true',
            order: 'votes',
            reverse: 'true',
        };
        if (countryCode)
            params.countrycode = countryCode;

        const results = await this._get('/json/stations/search', params, cancellable);
        return results.map(toStation);
    }

    /**
     * Tell radio-browser.info that a station was played. The API asks
     * clients to do this; it powers the "most played" ranking.
     *
     * @param {string} uuid
     */
    countClick(uuid) {
        if (uuid)
            this._get(`/json/url/${encodeURIComponent(uuid)}`).catch(() => {});
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }
}
