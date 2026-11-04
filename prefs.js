// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {isCancelled} from './lib/http.js';
import {RadioBrowser, localCountryCode} from './lib/radioBrowser.js';
import {StationStore, cleanStation, parseStations} from './lib/stations.js';

Gio._promisify(Adw.AlertDialog.prototype, 'choose');
Gio._promisify(Gtk.FileDialog.prototype, 'open');
Gio._promisify(Gtk.FileDialog.prototype, 'save');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const REPO_URL = 'https://github.com/Aleixenandros/radiola';
const DIRECTORY_URL = 'https://www.radio-browser.info';

function flatButton(iconName, tooltip, callback) {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    button.connect('clicked', callback);
    return button;
}

function boxedList() {
    return new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ['boxed-list'],
    });
}

function stationDetails(station) {
    const parts = [station.country, station.codec];
    if (station.bitrate)
        parts.push(`${station.bitrate} kbps`);
    return parts.filter(Boolean).join(' · ');
}

export default class RadiolaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        this._settings = this.getSettings();
        this._store = new StationStore(this._settings);
        this._browser = new RadioBrowser(
            `Radiola/${this.metadata['version-name']} (+${this.metadata.url})`);

        window.set_default_size(680, 780);
        window.connect('close-request', () => {
            this._cancellable?.cancel();
            this._browser.destroy();
            return false;
        });

        window.add(this._buildStationsPage());
        window.add(this._buildGeneralPage());
    }

    // ── Stations page ────────────────────────────────────────────

    _buildStationsPage() {
        const page = new Adw.PreferencesPage({
            title: _('Stations'),
            icon_name: 'starred-symbolic',
        });
        page.add(this._buildFavoritesGroup());
        page.add(this._buildSearchGroup());
        page.add(this._buildBackupGroup());
        return page;
    }

    _buildFavoritesGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Favorites'),
            description: _('Shown in the top bar menu in this order.'),
        });
        group.set_header_suffix(flatButton('list-add-symbolic', _('Add a station by address'),
            () => this._addStation()));

        this._favoritesList = boxedList();
        group.add(this._favoritesList);

        this._settings.connect('changed::stations', () => this._rebuildFavorites());
        this._rebuildFavorites();
        return group;
    }

    _rebuildFavorites() {
        const list = this._favoritesList;
        list.remove_all();

        const favorites = this._store.favorites;
        if (favorites.length === 0) {
            list.append(new Adw.ActionRow({
                title: _('No favorites yet'),
                subtitle: _('Search below, or add a station by its address with +.'),
            }));
        }

        favorites.forEach((station, index) => {
            const row = new Adw.ActionRow({
                title: station.name,
                subtitle: station.url,
                subtitle_lines: 1,
                use_markup: false,
            });

            const up = flatButton('go-up-symbolic', _('Move up'), () => this._store.move(index, -1));
            up.sensitive = index > 0;
            const down = flatButton('go-down-symbolic', _('Move down'), () => this._store.move(index, 1));
            down.sensitive = index < favorites.length - 1;

            row.add_suffix(up);
            row.add_suffix(down);
            row.add_suffix(flatButton('document-edit-symbolic', _('Edit'),
                () => this._editStation(index)));
            row.add_suffix(flatButton('user-trash-symbolic', _('Remove'),
                () => this._removeStation(index)));
            list.append(row);
        });
    }

    /**
     * Ask for a station name and address.
     *
     * @param {object|null} station the station to edit, or null to add one
     * @returns {Promise<object|null>} the cleaned station, or null if cancelled
     */
    async _askStation(station) {
        const dialog = new Adw.AlertDialog({
            heading: station ? _('Edit station') : _('Add station'),
            body: _('Use the address of the stream or of its playlist (.pls, .m3u).'),
        });

        const nameRow = new Adw.EntryRow({title: _('Name'), text: station?.name ?? ''});
        const urlRow = new Adw.EntryRow({
            title: _('Address'),
            text: station?.url ?? '',
            input_purpose: Gtk.InputPurpose.URL,
        });
        const fields = boxedList();
        fields.append(nameRow);
        fields.append(urlRow);
        dialog.set_extra_child(fields);

        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('save', _('Save'));
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('save');
        dialog.set_close_response('cancel');

        const read = () => {
            const url = urlRow.text.trim();
            const keepIds = station && url === station.url;
            return cleanStation({
                name: nameRow.text,
                url,
                uuid: keepIds ? station.uuid : undefined,
                favicon: keepIds ? station.favicon : undefined,
            });
        };
        const validate = () => dialog.set_response_enabled('save', read() !== null);
        nameRow.connect('changed', validate);
        urlRow.connect('changed', validate);
        validate();

        const response = await dialog.choose(this._window, null);
        return response === 'save' ? read() : null;
    }

    async _addStation() {
        const station = await this._askStation(null);
        if (station)
            this._store.add(station);
    }

    async _editStation(index) {
        const favorites = this._store.favorites;
        const edited = await this._askStation(favorites[index]);
        if (!edited)
            return;
        favorites[index] = edited;
        this._store.favorites = favorites;
    }

    _removeStation(index) {
        const before = this._store.favorites;
        const [removed] = before.splice(index, 1);
        this._store.favorites = before;

        const toast = new Adw.Toast({
            title: _('“%s” removed').replace('%s', removed.name),
            button_label: _('Undo'),
            use_markup: false,
        });
        toast.connect('button-clicked', () => {
            const list = this._store.favorites;
            list.splice(index, 0, removed);
            this._store.favorites = list;
        });
        this._window.add_toast(toast);
    }

    _buildSearchGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Find stations'),
            description: _('Search the free radio-browser.info directory, with more than 50,000 stations.'),
        });

        const entry = new Adw.EntryRow({title: _('Station name'), show_apply_button: true});
        entry.connect('apply', () => this._search(entry.text));
        entry.connect('entry-activated', () => this._search(entry.text));
        group.add(entry);

        this._resultsList = boxedList();
        this._resultsList.margin_top = 12;
        this._resultsList.visible = false;
        group.add(this._resultsList);
        return group;
    }

    async _search(text) {
        text = text.trim();
        if (!text)
            return;

        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        const list = this._resultsList;
        list.remove_all();
        list.visible = true;
        const status = new Adw.ActionRow({title: _('Searching…')});
        status.add_suffix(new Adw.Spinner());
        list.append(status);

        try {
            const stations = await this._browser.search(text, cancellable);
            list.remove_all();
            if (stations.length === 0)
                list.append(new Adw.ActionRow({title: _('No stations found')}));

            for (const station of stations)
                list.append(this._makeResultRow(station));
        } catch (error) {
            if (isCancelled(error))
                return;
            list.remove_all();
            list.append(new Adw.ActionRow({
                title: _('Could not reach radio-browser.info'),
                subtitle: _('Check your internet connection and try again.'),
            }));
        }
    }

    _makeResultRow(station) {
        const row = new Adw.ActionRow({
            title: station.name,
            subtitle: stationDetails(station),
            use_markup: false,
        });

        const button = flatButton('list-add-symbolic', _('Add to favorites'), () => {
            this._store.add(station);
            sync();
        });
        const sync = () => {
            const saved = this._store.isFavorite(station);
            button.icon_name = saved ? 'object-select-symbolic' : 'list-add-symbolic';
            button.tooltip_text = saved ? _('Already in favorites') : _('Add to favorites');
            button.sensitive = !saved;
        };
        sync();
        row.add_suffix(button);
        return row;
    }

    _buildBackupGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Backup'),
            description: _('Save your favorites to a file, or load them on another computer.'),
        });

        const exportRow = new Adw.ActionRow({title: _('Export favorites'), activatable: true});
        exportRow.add_suffix(new Gtk.Image({icon_name: 'document-save-symbolic'}));
        exportRow.connect('activated', () => this._export().catch(e => this._toastError(e)));
        group.add(exportRow);

        const importRow = new Adw.ActionRow({
            title: _('Import favorites'),
            subtitle: _('Stations already in your favorites are kept.'),
            activatable: true,
        });
        importRow.add_suffix(new Gtk.Image({icon_name: 'document-open-symbolic'}));
        importRow.connect('activated', () => this._import().catch(e => this._toastError(e)));
        group.add(importRow);
        return group;
    }

    _jsonFilter() {
        const filter = new Gtk.FileFilter({name: _('JSON files')});
        filter.add_pattern('*.json');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        return filters;
    }

    async _export() {
        const dialog = new Gtk.FileDialog({
            initial_name: 'radiola-stations.json',
            filters: this._jsonFilter(),
        });
        const file = await dialog.save(this._window, null).catch(() => null);
        if (!file)
            return;

        const json = JSON.stringify(this._store.favorites, null, 2);
        await file.replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(json)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        this._window.add_toast(new Adw.Toast({title: _('Favorites exported')}));
    }

    async _import() {
        const dialog = new Gtk.FileDialog({filters: this._jsonFilter()});
        const file = await dialog.open(this._window, null).catch(() => null);
        if (!file)
            return;

        const [contents] = await file.load_contents_async(null);
        const imported = parseStations(new TextDecoder().decode(contents));
        const before = this._store.favorites.length;
        imported.forEach(station => this._store.add(station));
        const added = this._store.favorites.length - before;

        this._window.add_toast(new Adw.Toast({
            title: _('%d stations imported').replace('%d', String(added)),
        }));
    }

    _toastError(error) {
        console.warn(`[Radiola] ${error.message}`);
        this._window.add_toast(new Adw.Toast({title: _('Something went wrong with the file')}));
    }

    // ── General page ─────────────────────────────────────────────

    _buildGeneralPage() {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const panel = new Adw.PreferencesGroup({title: _('Top bar')});
        page.add(panel);
        panel.add(this._switchRow('show-title-in-panel', _('Show the title next to the icon'),
            _('The song title, or the station name, while playing')));
        panel.add(this._switchRow('notify-title-change', _('Notify song changes'),
            _('Show a notification when a new song starts')));

        const country = localCountryCode() || _('none');
        const discover = new Adw.PreferencesGroup({
            title: _('Popular stations'),
            description: _('Country of the popular stations shown in “Discover stations”. Use a two-letter code such as ES, MX or AR. Leave it empty to use the country of your system language (%s).')
                .replace('%s', country),
        });
        page.add(discover);
        const countryRow = new Adw.EntryRow({
            title: _('Country code'),
            text: this._settings.get_string('country-code'),
            show_apply_button: true,
        });
        countryRow.connect('apply', () =>
            this._settings.set_string('country-code', countryRow.text.trim().toUpperCase()));
        discover.add(countryRow);

        const about = new Adw.PreferencesGroup({title: _('About')});
        page.add(about);
        about.add(this._linkRow(_('Station directory'), 'radio-browser.info', DIRECTORY_URL));
        about.add(this._linkRow(_('Source code and bug reports'), 'GitHub', REPO_URL));
        return page;
    }

    _switchRow(key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _linkRow(title, subtitle, uri) {
        const row = new Adw.ActionRow({title, subtitle, activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        row.connect('activated', () =>
            new Gtk.UriLauncher({uri}).launch(this._window, null, null));
        return row;
    }
}
