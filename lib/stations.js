// SPDX-License-Identifier: Apache-2.0
//
// Favorite and custom stations, stored as JSON in GSettings. Shared by the
// extension and the preferences window.

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
    // Logo: a web address, or a file:// URI for logos chosen by the user.
    const favicon = String(station.favicon ?? '').trim();
    if (/^(https?|file):\/\//i.test(favicon))
        clean.favicon = favicon;
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

/**
 * Read a backup file. Version 1.0 saved a plain list of favorites; newer
 * backups also have the custom stations.
 *
 * @param {string} json
 * @returns {{favorites: Station[], custom: Station[]}}
 */
export function parseBackup(json) {
    const list = value => Array.isArray(value) ? value.map(cleanStation).filter(Boolean) : [];
    try {
        const data = JSON.parse(json);
        return Array.isArray(data)
            ? {favorites: list(data), custom: []}
            : {favorites: list(data?.favorites), custom: list(data?.custom)};
    } catch {
        return {favorites: [], custom: []};
    }
}

/** GSettings key of each list. */
const LIST_KEYS = Object.freeze({
    favorites: 'stations',
    custom: 'custom-stations',
});

export class StationStore {
    /**
     * @param {Gio.Settings} settings the extension settings
     */
    constructor(settings) {
        this._settings = settings;
    }

    /** @returns {Station[]} stations saved with the star button */
    get favorites() {
        return this.getList('favorites');
    }

    /** @param {Station[]} list */
    set favorites(list) {
        this.setList('favorites', list);
    }

    /** @returns {Station[]} stations added by hand, not from the directory */
    get custom() {
        return this.getList('custom');
    }

    /** @param {Station[]} list */
    set custom(list) {
        this.setList('custom', list);
    }

    /**
     * @returns {Station[]} the favorites, then the custom stations that are
     *   not favorites too: what next and previous go through
     */
    get playlist() {
        const favorites = this.favorites;
        return [...favorites, ...this.custom.filter(c => !favorites.some(f => sameStation(f, c)))];
    }

    /**
     * @param {string} name 'favorites' or 'custom'
     * @returns {Station[]}
     */
    getList(name) {
        return parseStations(this._settings.get_string(LIST_KEYS[name]));
    }

    /**
     * @param {string} name 'favorites' or 'custom'
     * @param {Station[]} list
     */
    setList(name, list) {
        const clean = list.map(cleanStation).filter(Boolean);
        this._settings.set_string(LIST_KEYS[name], JSON.stringify(clean, null, 1));
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
     * @param {string} name 'favorites' or 'custom'
     * @param {number} index
     * @param {number} delta -1 to move up, +1 to move down
     */
    move(name, index, delta) {
        const list = this.getList(name);
        const target = index + delta;
        if (target < 0 || target >= list.length)
            return;
        [list[index], list[target]] = [list[target], list[index]];
        this.setList(name, list);
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
