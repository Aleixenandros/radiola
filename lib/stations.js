// SPDX-License-Identifier: GPL-2.0-or-later
//
// Favorite stations, stored as JSON in GSettings. Shared by the extension
// and the preferences window.

/** @typedef {import('./radioBrowser.js').Station} Station */

/**
 * Keep only the fields we store, and drop invalid entries.
 *
 * @param {object} station
 * @returns {Station|null}
 */
export function cleanStation(station) {
    const name = String(station?.name ?? '').trim();
    const url = String(station?.url ?? '').trim();
    if (!name || !/^https?:\/\//i.test(url))
        return null;

    const clean = {name, url};
    if (station.uuid)
        clean.uuid = String(station.uuid);
    if (station.favicon)
        clean.favicon = String(station.favicon);
    return clean;
}

/**
 * @param {Station} a
 * @param {Station} b
 * @returns {boolean}
 */
export function sameStation(a, b) {
    if (!a || !b)
        return false;
    if (a.uuid && b.uuid)
        return a.uuid === b.uuid;
    return a.url === b.url;
}

/**
 * Parse a JSON list of stations, ignoring anything invalid.
 *
 * @param {string} json
 * @returns {Station[]}
 */
export function parseStations(json) {
    try {
        const list = JSON.parse(json);
        return Array.isArray(list) ? list.map(cleanStation).filter(Boolean) : [];
    } catch {
        return [];
    }
}

export class StationStore {
    /**
     * @param {Gio.Settings} settings the extension settings
     */
    constructor(settings) {
        this._settings = settings;
    }

    /** @returns {Station[]} */
    get favorites() {
        return parseStations(this._settings.get_string('stations'));
    }

    /** @param {Station[]} list */
    set favorites(list) {
        const clean = list.map(cleanStation).filter(Boolean);
        this._settings.set_string('stations', JSON.stringify(clean, null, 1));
    }

    isFavorite(station) {
        return this.favorites.some(s => sameStation(s, station));
    }

    add(station) {
        if (!this.isFavorite(station))
            this.favorites = [...this.favorites, station];
    }

    remove(station) {
        this.favorites = this.favorites.filter(s => !sameStation(s, station));
    }

    toggle(station) {
        if (this.isFavorite(station))
            this.remove(station);
        else
            this.add(station);
    }

    /**
     * @param {number} index
     * @param {number} delta -1 to move up, +1 to move down
     */
    move(index, delta) {
        const list = this.favorites;
        const target = index + delta;
        if (target < 0 || target >= list.length)
            return;
        [list[index], list[target]] = [list[target], list[index]];
        this.favorites = list;
    }

    /** @returns {Station|null} */
    get lastStation() {
        try {
            return cleanStation(JSON.parse(this._settings.get_string('last-station')));
        } catch {
            return null;
        }
    }

    set lastStation(station) {
        const clean = cleanStation(station);
        this._settings.set_string('last-station', clean ? JSON.stringify(clean) : '');
    }
}
