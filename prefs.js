// SPDX-License-Identifier: Apache-2.0

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {FaviconCache} from './lib/favicons.js';
import {isCancelled} from './lib/http.js';
import {MAX_LOGO_SIZE, copyLogo, localLogoFile} from './lib/logos.js';
import {RadioBrowser, localCountryCode} from './lib/radioBrowser.js';
import {StationStore, cleanStation, parseBackup, sameStation} from './lib/stations.js';

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

/** What the logo field shows for a stored logo: a path or a web address. */
function logoText(favicon) {
    return favicon?.startsWith('file://') ? Gio.File.new_for_uri(favicon).get_path() : favicon ?? '';
}

/**
 * @param {Gio.File} file
 * @returns {Gdk.Texture|null} the image, or null if it is not a usable one
 */
function loadLogo(file) {
    try {
        const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_size() > MAX_LOGO_SIZE ? null : Gdk.Texture.new_from_file(file);
    } catch {
        return null;
    }
}

export default class RadiolaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        this._settings = this.getSettings();
        this._store = new StationStore(this._settings);
        const userAgent = `Radiola/${this.metadata['version-name']} (+${this.metadata.url})`;
        this._browser = new RadioBrowser(userAgent);
        // Only to show logos already on disk; prefs never downloads them.
        this._favicons = new FaviconCache(userAgent);
        this._fallbackIcon = new Gio.FileIcon({
            file: this.dir.resolve_relative_path('icons/radiola-symbolic.svg'),
        });

        window.set_default_size(680, 820);
        window.add(this._buildStationsPage());
        window.add(this._buildGeneralPage());

        const handlerIds = [
            this._settings.connect('changed::stations', () => this._rebuildList('favorites')),
            this._settings.connect('changed::custom-stations', () => this._rebuildList('custom')),
        ];

        window.connect('close-request', () => {
            handlerIds.forEach(id => this._settings.disconnect(id));
            this._cancellable?.cancel();
            this._browser.destroy();
            this._favicons.destroy();

            this._window = null;
            this._settings = null;
            this._store = null;
            this._browser = null;
            this._favicons = null;
            this._fallbackIcon = null;
            this._favoritesList = null;
            this._customList = null;
            this._resultsList = null;
            this._cancellable = null;
            return false;
        });
    }

    _buildStationsPage() {
        const page = new Adw.PreferencesPage({
            title: _('Stations'),
            icon_name: 'starred-symbolic',
        });
        page.add(this._buildFavoritesGroup());
        page.add(this._buildCustomGroup());
        page.add(this._buildSearchGroup());
        page.add(this._buildBackupGroup());
        return page;
    }

    _buildFavoritesGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Favorites'),
            description: _('Shown in the top bar menu in this order.'),
        });

        this._favoritesList = boxedList();
        group.add(this._favoritesList);
        this._rebuildList('favorites');
        return group;
    }

    _buildCustomGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Custom stations'),
            description: _('Stations that are not in the directory: add the address of the stream, a name and, if you like, a logo. They are shown in the menu below the favorites.'),
        });
        group.set_header_suffix(flatButton('list-add-symbolic', _('Add a custom station'),
            () => this._addCustom().catch(e => this._toastError(e))));

        this._customList = boxedList();
        group.add(this._customList);
        this._rebuildList('custom');
        return group;
    }

    /**
     * @param {string} name 'favorites' or 'custom'
     */
    _rebuildList(name) {
        const list = name === 'favorites' ? this._favoritesList : this._customList;
        list.remove_all();

        const stations = this._store.getList(name);
        if (stations.length === 0) {
            list.append(name === 'favorites'
                ? new Adw.ActionRow({
                    title: _('No favorites yet'),
                    subtitle: _('Press the star button while a station plays, or add one from the search below.'),
                })
                : new Adw.ActionRow({
                    title: _('No custom stations yet'),
                    subtitle: _('Press + to add one.'),
                }));
        }

        stations.forEach((station, index) => {
            const row = new Adw.ActionRow({
                title: station.name,
                subtitle: station.url,
                subtitle_lines: 1,
                use_markup: false,
            });
            row.add_prefix(this._logoImage(station));

            const up = flatButton('go-up-symbolic', _('Move up'),
                () => this._store.move(name, index, -1));
            up.sensitive = index > 0;
            const down = flatButton('go-down-symbolic', _('Move down'),
                () => this._store.move(name, index, 1));
            down.sensitive = index < stations.length - 1;

            row.add_suffix(up);
            row.add_suffix(down);
            row.add_suffix(flatButton('document-edit-symbolic', _('Edit'),
                () => this._editStation(name, index).catch(e => this._toastError(e))));
            row.add_suffix(flatButton('user-trash-symbolic', _('Remove'),
                () => this._removeStation(name, index)));
            list.append(row);
        });
    }

    /** The station logo if it is on disk (chosen by the user or cached). */
    _logoImage(station) {
        const file = this._favicons.lookup(station.favicon);
        const texture = file ? loadLogo(file) : null;
        return texture
            ? new Gtk.Image({paintable: texture, pixel_size: 32})
            : new Gtk.Image({gicon: this._fallbackIcon, pixel_size: 32});
    }

    /**
     * Ask for the name, address and logo of a station.
     *
     * @param {object|null} station the station to edit, or null to add one
     * @param {string} heading title of the dialog
     * @returns {Promise<object|null>} the cleaned station, or null if cancelled
     */
    async _askStation(station, heading) {
        const dialog = new Adw.AlertDialog({
            heading,
            body: _('Use the address of the stream or of its playlist (.pls, .m3u). The logo is optional: an image from your files or its web address.'),
        });

        const nameRow = new Adw.EntryRow({title: _('Name'), text: station?.name ?? ''});
        const urlRow = new Adw.EntryRow({
            title: _('Stream address'),
            text: station?.url ?? '',
            input_purpose: Gtk.InputPurpose.URL,
        });
        const logoRow = new Adw.EntryRow({
            title: _('Logo (optional)'),
            text: logoText(station?.favicon),
        });
        const preview = new Gtk.Image({pixel_size: 32});
        logoRow.add_prefix(preview);
        logoRow.add_suffix(flatButton('document-open-symbolic', _('Choose an image'), async () => {
            const file = await this._chooseImage();
            if (file)
                logoRow.text = file.get_path();
        }));

        const fields = boxedList();
        fields.append(nameRow);
        fields.append(urlRow);
        fields.append(logoRow);
        dialog.set_extra_child(fields);

        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('save', _('Save'));
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('save');
        dialog.set_close_response('cancel');

        // The logo field holds nothing, a web address or an image file.
        // Images are decoded once per path, not on every key press.
        const textures = new Map();
        const readLogo = () => {
            const text = logoRow.text.trim();
            if (!text)
                return {valid: true};
            if (/^https?:\/\/\S+$/i.test(text)) {
                const cached = this._favicons.lookup(text);
                return {valid: true, url: text, texture: cached ? loadLogo(cached) : null};
            }
            const file = localLogoFile(text);
            if (!file)
                return {valid: false};
            const path = file.get_path();
            if (!textures.has(path))
                textures.set(path, loadLogo(file));
            const texture = textures.get(path);
            return texture ? {valid: true, file, texture} : {valid: false};
        };

        const read = () => {
            const url = urlRow.text.trim();
            const keepId = station && url === station.url;
            return cleanStation({
                name: nameRow.text,
                url,
                uuid: keepId ? station.uuid : undefined,
            });
        };

        const validate = () => {
            const logo = readLogo();
            if (logo.texture)
                preview.set_from_paintable(logo.texture);
            else
                preview.icon_name = logo.valid ? 'image-x-generic-symbolic' : 'dialog-warning-symbolic';

            if (logo.valid)
                logoRow.remove_css_class('error');
            else
                logoRow.add_css_class('error');
            dialog.set_response_enabled('save', logo.valid && read() !== null);
        };
        for (const row of [nameRow, urlRow, logoRow])
            row.connect('changed', validate);
        validate();

        const response = await dialog.choose(this._window, null);
        if (response !== 'save')
            return null;

        // Images from the user's files are copied, so they keep working.
        const logo = readLogo();
        const favicon = logo.file ? await copyLogo(logo.file) : logo.url;
        return cleanStation({...read(), favicon});
    }

    /** @returns {Promise<Gio.File|null>} the image chosen, if any */
    _chooseImage() {
        const filter = new Gtk.FileFilter({name: _('Images')});
        filter.add_pixbuf_formats();
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);

        const dialog = new Gtk.FileDialog({title: _('Choose a logo'), filters});
        return dialog.open(this._window, null).catch(() => null);
    }

    async _addCustom() {
        const station = await this._askStation(null, _('Add custom station'));
        if (!station)
            return;

        const custom = this._store.custom;
        if (custom.some(s => sameStation(s, station))) {
            this._window.add_toast(new Adw.Toast({title: _('That station is already in your custom stations')}));
            return;
        }
        this._store.custom = [...custom, station];
    }

    /**
     * @param {string} name 'favorites' or 'custom'
     * @param {number} index
     */
    async _editStation(name, index) {
        const stations = this._store.getList(name);
        const edited = await this._askStation(stations[index], _('Edit station'));
        if (!edited)
            return;
        stations[index] = edited;
        this._store.setList(name, stations);
    }

    /**
     * @param {string} name 'favorites' or 'custom'
     * @param {number} index
     */
    _removeStation(name, index) {
        const before = this._store.getList(name);
        const [removed] = before.splice(index, 1);
        this._store.setList(name, before);

        const toast = new Adw.Toast({
            title: _('“%s” removed').replace('%s', removed.name),
            button_label: _('Undo'),
            use_markup: false,
        });
        toast.connect('button-clicked', () => {
            const list = this._store.getList(name);
            list.splice(index, 0, removed);
            this._store.setList(name, list);
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
            description: _('Save your favorites and custom stations to a file, or load them on another computer. Logos chosen from your files stay on this computer.'),
        });

        const exportRow = new Adw.ActionRow({title: _('Export stations'), activatable: true});
        exportRow.add_suffix(new Gtk.Image({icon_name: 'document-save-symbolic'}));
        exportRow.connect('activated', () => this._export().catch(e => this._toastError(e)));
        group.add(exportRow);

        const importRow = new Adw.ActionRow({
            title: _('Import stations'),
            subtitle: _('Stations you already have are kept.'),
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

        const backup = {favorites: this._store.favorites, custom: this._store.custom};
        const json = JSON.stringify(backup, null, 2);
        await file.replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(json)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        this._window.add_toast(new Adw.Toast({title: _('Stations exported')}));
    }

    async _import() {
        const dialog = new Gtk.FileDialog({filters: this._jsonFilter()});
        const file = await dialog.open(this._window, null).catch(() => null);
        if (!file)
            return;

        const [contents] = await file.load_contents_async(null);
        const backup = parseBackup(new TextDecoder().decode(contents));
        const count = () => this._store.favorites.length + this._store.custom.length;
        const before = count();

        backup.favorites.forEach(station => this._store.add(station));
        const custom = this._store.custom;
        const newCustom = backup.custom.filter(s => !custom.some(c => sameStation(c, s)));
        if (newCustom.length > 0)
            this._store.custom = [...custom, ...newCustom];

        this._window.add_toast(new Adw.Toast({
            title: _('%d stations imported').replace('%d', String(count() - before)),
        }));
    }

    _toastError(error) {
        console.warn(`[Radiola] ${error.message}`);
        this._window.add_toast(new Adw.Toast({title: _('Something went wrong with the file')}));
    }

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
        discover.add(this._switchRow('report-plays', _('Help rank the directory'),
            _('Tell radio-browser.info which of its stations you play. It uses this to rank the most popular ones.')));

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
