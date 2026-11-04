// SPDX-License-Identifier: Apache-2.0
//
// Top bar button and its menu:
//
//   +-------------------------------------------+
//   | [logo] Station name     [fav] [copy] [play]|  now playing
//   |        Song title                          |
//   | [vol]  ------------o---------              |  volume
//   | Favorites                                  |
//   |   Station A                                |  click to play
//   |   Station B                                |
//   | Discover stations                       >  |  search radio-browser.info
//   | Preferences                                |
//   +-------------------------------------------+

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {isCancelled} from './http.js';
import {State} from './player.js';
import {localCountryCode} from './radioBrowser.js';
import {sameStation} from './stations.js';

const SEARCH_DELAY_MS = 500;

/** St.Icon showing the station logo, or the Radiola icon if it has none. */
function makeStationIcon(styleClass, fallback) {
    const icon = new St.Icon({style_class: styleClass, gicon: fallback});
    icon._radiolaFallback = fallback;
    icon.connect('destroy', () => (icon._radiolaDestroyed = true));
    return icon;
}

/**
 * Show the Radiola icon right away, then the station logo once the cache
 * has it. Broken logos simply keep the Radiola icon.
 */
async function setStationIcon(icon, station, favicons) {
    const url = station?.favicon ?? '';
    if (icon._radiolaUrl === url)
        return;
    icon._radiolaUrl = url;
    icon.gicon = icon._radiolaFallback;

    const file = await favicons.get(url);
    if (file && !icon._radiolaDestroyed && icon._radiolaUrl === url)
        icon.gicon = new Gio.FileIcon({file});
}

function makeLabel(styleClass, text = '') {
    const label = new St.Label({style_class: styleClass, text, x_expand: true});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

function makeIconButton(iconName, accessibleName, callback) {
    const button = new St.Button({
        style_class: 'icon-button radiola-button',
        can_focus: true,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName}),
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', callback);
    return button;
}

/**
 * Non-interactive line of help text. It wraps instead of widening the
 * menu (whose width is capped in the stylesheet).
 *
 * @param {string} text
 * @returns {PopupMenu.PopupMenuItem}
 */
function makeHint(text) {
    const hint = new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
    hint.add_style_class_name('radiola-hint');
    hint.label.clutter_text.line_wrap = true;
    hint.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return hint;
}

// ── Menu items ─────────────────────────────────────────────────────

const NowPlayingItem = GObject.registerClass(
class NowPlayingItem extends PopupMenu.PopupBaseMenuItem {
    constructor(controller) {
        super({reactive: false, can_focus: false, style_class: 'radiola-now-playing'});
        this._controller = controller;

        this._cover = makeStationIcon('radiola-cover', controller.icon);
        this.add_child(this._cover);

        const labels = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._stationLabel = makeLabel('radiola-station-name');
        this._titleLabel = makeLabel('radiola-song-title');
        labels.add_child(this._stationLabel);
        labels.add_child(this._titleLabel);
        this.add_child(labels);

        this._favoriteButton = makeIconButton('non-starred-symbolic', _('Add to favorites'),
            () => this._controller.toggleFavorite());
        this._copyButton = makeIconButton('edit-copy-symbolic', _('Copy song title'),
            () => this._copyTitle());
        this._playButton = makeIconButton('media-playback-start-symbolic', _('Play or stop'),
            () => this._controller.player.toggle());
        this._playButton.add_style_class_name('radiola-play-button');

        this.add_child(this._favoriteButton);
        this.add_child(this._copyButton);
        this.add_child(this._playButton);
    }

    _copyTitle() {
        const text = this._controller.player.title;
        if (text)
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    /**
     * @param {string} errorText message of the last failure, if any
     */
    sync(errorText) {
        const {player, store} = this._controller;
        const station = player.station;
        const active = player.state !== State.STOPPED;

        setStationIcon(this._cover, station, this._controller.favicons);
        this._stationLabel.text = station?.name ?? _('No station selected');

        let subtitle;
        if (errorText)
            subtitle = errorText;
        else if (player.state === State.LOADING)
            subtitle = _('Connecting…');
        else if (player.state === State.PLAYING)
            subtitle = player.title || _('Playing');
        else
            subtitle = station ? _('Stopped') : _('Choose a station below');
        this._titleLabel.text = subtitle;

        if (errorText)
            this._titleLabel.add_style_class_name('radiola-error');
        else
            this._titleLabel.remove_style_class_name('radiola-error');

        const favorite = station !== null && store.isFavorite(station);
        this._favoriteButton.visible = station !== null;
        this._favoriteButton.child.icon_name = favorite ? 'starred-symbolic' : 'non-starred-symbolic';
        this._favoriteButton.accessible_name = favorite ? _('Remove from favorites') : _('Add to favorites');

        this._copyButton.visible = active && player.title !== '';

        this._playButton.reactive = station !== null;
        this._playButton.child.icon_name = active
            ? 'media-playback-stop-symbolic'
            : 'media-playback-start-symbolic';
    }
});

const VolumeItem = GObject.registerClass(
class VolumeItem extends PopupMenu.PopupBaseMenuItem {
    constructor(controller) {
        super({activate: false, style_class: 'radiola-volume'});

        this._icon = new St.Icon({style_class: 'popup-menu-icon'});
        this.add_child(this._icon);

        this.slider = new Slider(controller.player.volume);
        this.slider.x_expand = true;
        this.slider.accessible_name = _('Volume');
        this.slider.connect('notify::value', () => {
            controller.setVolume(this.slider.value);
            this._syncIcon();
        });
        this.add_child(this.slider);
        this._syncIcon();
    }

    _syncIcon() {
        const value = this.slider.value;
        let name = 'audio-volume-high-symbolic';
        if (value === 0)
            name = 'audio-volume-muted-symbolic';
        else if (value < 0.34)
            name = 'audio-volume-low-symbolic';
        else if (value < 0.67)
            name = 'audio-volume-medium-symbolic';
        this._icon.icon_name = name;
    }

    sync(volume) {
        if (Math.abs(this.slider.value - volume) > 0.001)
            this.slider.value = volume;
    }
});

const StationItem = GObject.registerClass(
class StationItem extends PopupMenu.PopupBaseMenuItem {
    /**
     * @param {object} station
     * @param {string} details second line, e.g. "ES · MP3 128 kbps"
     * @param {object} controller the extension
     */
    constructor(station, details, controller) {
        super({style_class: 'radiola-station-item'});
        this.station = station;

        const icon = makeStationIcon('radiola-station-icon', controller.icon);
        setStationIcon(icon, station, controller.favicons);
        this.add_child(icon);

        const labels = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        labels.add_child(makeLabel('radiola-station-item-name', station.name));
        if (details)
            labels.add_child(makeLabel('radiola-station-item-details', details));
        this.add_child(labels);
    }
});

/** "ES · MP3 128 kbps" */
function stationDetails(station) {
    const parts = [];
    if (station.country)
        parts.push(station.country);
    if (station.codec)
        parts.push(station.bitrate ? `${station.codec} ${station.bitrate} kbps` : station.codec);
    return parts.join(' · ');
}

// ── Panel button ───────────────────────────────────────────────────

export const RadiolaIndicator = GObject.registerClass(
class RadiolaIndicator extends PanelMenu.Button {
    /**
     * @param {object} controller the extension (see extension.js)
     */
    constructor(controller) {
        super(0.5, 'Radiola');
        this._controller = controller;
        this._settings = controller.getSettings();
        this._errorText = '';
        this._searchTimeoutId = 0;
        this._cancellable = null;
        this._discoverLoaded = false;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._panelIcon = new St.Icon({gicon: controller.icon, style_class: 'system-status-icon'});
        this._panelLabel = new St.Label({
            style_class: 'radiola-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._panelLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._panelIcon);
        box.add_child(this._panelLabel);
        this.add_child(box);

        this._buildMenu();

        controller.player.connectObject(
            'changed', () => {
                if (controller.player.state !== State.STOPPED)
                    this._errorText = '';
                this._sync();
            },
            'error', (_player, message) => {
                this._errorText = message;
                this._sync();
            },
            this);
        this._settings.connectObject(
            'changed::stations', () => this._rebuildFavorites(),
            'changed::custom-stations', () => this._rebuildFavorites(),
            'changed::show-title-in-panel', () => this._sync(),
            'changed::country-code', () => (this._discoverLoaded = false),
            this);
        this.connect('destroy', () => this._onDestroy());

        this._rebuildFavorites();
        this._sync();
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('radiola-menu');

        this._nowPlaying = new NowPlayingItem(this._controller);
        this.menu.addMenuItem(this._nowPlaying);

        this._volume = new VolumeItem(this._controller);
        this.menu.addMenuItem(this._volume);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Favorites')));

        // Favorites live in a scroll view so a long list does not make the
        // menu taller than the screen.
        this._favoritesSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._favoritesSection);
        this.menu.box.remove_child(this._favoritesSection.actor);
        this._favoritesScroll = new St.ScrollView({
            style_class: 'radiola-favorites',
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            child: this._favoritesSection.actor,
        });
        this.menu.box.add_child(this._favoritesScroll);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._discover = new PopupMenu.PopupSubMenuMenuItem(_('Discover stations'), true);
        this._discover.icon.icon_name = 'system-search-symbolic';
        this.menu.addMenuItem(this._discover);
        this._buildDiscover();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Preferences'), () => this._controller.openPreferences());
    }

    _buildDiscover() {
        const searchItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'radiola-search-item',
        });
        this._searchEntry = new St.Entry({
            style_class: 'radiola-search-entry',
            hint_text: _('Search by name…'),
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'popup-menu-icon'}),
        });
        this._searchEntry.clutter_text.connect('text-changed', () => this._queueSearch());
        this._searchEntry.clutter_text.connect('activate', () => this._runSearchNow());
        searchItem.add_child(this._searchEntry);
        this._discover.menu.addMenuItem(searchItem);

        this._resultsTitle = new PopupMenu.PopupSeparatorMenuItem('');
        this._discover.menu.addMenuItem(this._resultsTitle);

        // Results get their own scroll view, like the favorites: a long list
        // scrolls below the search entry instead of making the menu as tall
        // as the screen. GNOME only scrolls a submenu when the whole menu
        // does not fit, so a max-height on the submenu itself would clip it.
        this._resultsSection = new PopupMenu.PopupMenuSection();
        this._discover.menu.addMenuItem(this._resultsSection);
        this._discover.menu.box.remove_child(this._resultsSection.actor);
        this._resultsScroll = new St.ScrollView({
            style_class: 'radiola-results',
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            child: this._resultsSection.actor,
        });
        this._discover.menu.box.add_child(this._resultsScroll);

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._fitFavorites();
        });

        this._discover.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen)
                return;
            this._searchEntry.grab_key_focus();
            if (!this._discoverLoaded)
                this._runSearchNow();
        });
    }

    // ── Favorites ────────────────────────────────────────────────

    _rebuildFavorites() {
        this._favoritesSection.removeAll();
        const favorites = this._controller.store.favorites;

        if (favorites.length === 0) {
            this._favoritesSection.addMenuItem(makeHint(
                _('No favorites yet. Play a station and press the star button to save it.')));
        }

        for (const station of favorites)
            this._favoritesSection.addMenuItem(this._makeStationItem(station, '', this._favoritesScroll));

        // Custom stations share the scroll view, under their own title.
        const custom = this._controller.store.custom;
        if (custom.length > 0)
            this._favoritesSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Custom')));
        for (const station of custom)
            this._favoritesSection.addMenuItem(this._makeStationItem(station, '', this._favoritesScroll));

        if (this.menu.isOpen)
            this._fitFavorites();
        this._sync();
    }

    /**
     * @param {object} station
     * @param {string} details second line under the name
     * @param {St.ScrollView} scrollView the list the item goes in
     */
    _makeStationItem(station, details, scrollView) {
        const item = new StationItem(station, details, this._controller);
        item.connect('activate', () => this._controller.playStation(station));
        // Keep the item in view when moving through the list with the keyboard.
        item.connect('key-focus-in', () => ensureActorVisibleInScrollView(scrollView, item));
        return item;
    }

    /**
     * The favorites scroll view must not shrink below its content (up to
     * its CSS max-height); otherwise opening "Discover stations" squeezes
     * the favorites away instead of scrolling the results.
     */
    _fitFavorites() {
        const scroll = this._favoritesScroll;
        scroll.style = null;
        const [, natural] = this._favoritesSection.actor.get_preferred_height(-1);
        const max = scroll.get_theme_node().get_max_height();
        const height = max > 0 ? Math.min(natural, max) : natural;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        scroll.style = `min-height: ${Math.ceil(height / scale)}px;`;
    }

    // ── Discover (radio-browser.info) ────────────────────────────

    _queueSearch() {
        if (this._searchTimeoutId)
            GLib.source_remove(this._searchTimeoutId);
        this._searchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this._searchTimeoutId = 0;
            this._runSearch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _runSearchNow() {
        if (this._searchTimeoutId) {
            GLib.source_remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }
        this._runSearch();
    }

    async _runSearch() {
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        const text = this._searchEntry.text.trim();
        const country = this._settings.get_string('country-code').trim().toUpperCase() ||
            localCountryCode();

        this._resultsTitle.label.text = text
            ? _('Results')
            : _('Popular stations (%s)').replace('%s', country || _('worldwide'));
        this._showResultsMessage(_('Searching…'));

        try {
            const {browser} = this._controller;
            const stations = text
                ? await browser.search(text, cancellable)
                : await browser.popular(country, cancellable);
            if (cancellable.is_cancelled())
                return;

            this._discoverLoaded = true;
            this._resultsSection.removeAll();
            if (stations.length === 0)
                this._showResultsMessage(_('No stations found'));
            for (const station of stations)
                this._resultsSection.addMenuItem(this._makeStationItem(station, stationDetails(station), this._resultsScroll));
            this._sync();
        } catch (error) {
            if (!isCancelled(error)) {
                console.warn(`[Radiola] radio-browser.info: ${error.message}`);
                this._showResultsMessage(_('Could not reach radio-browser.info'));
            }
        }
    }

    _showResultsMessage(text) {
        this._resultsSection.removeAll();
        this._resultsScroll.vadjustment.value = 0;
        this._resultsSection.addMenuItem(makeHint(text));
    }

    // ── State ────────────────────────────────────────────────────

    _sync() {
        const {player} = this._controller;
        const active = player.state !== State.STOPPED;

        if (active)
            this._panelIcon.add_style_class_name('radiola-active');
        else
            this._panelIcon.remove_style_class_name('radiola-active');

        const showTitle = active && this._settings.get_boolean('show-title-in-panel');
        this._panelLabel.visible = showTitle;
        if (showTitle)
            this._panelLabel.text = player.title || player.station?.name || '';

        this._nowPlaying.sync(this._errorText);
        this._volume.sync(player.volume);

        // Mark the station that is playing in both lists.
        for (const section of [this._favoritesSection, this._resultsSection]) {
            for (const item of section._getMenuItems()) {
                if (item instanceof StationItem) {
                    item.setOrnament(active && sameStation(item.station, player.station)
                        ? PopupMenu.Ornament.DOT
                        : PopupMenu.Ornament.NO_DOT);
                }
            }
        }
    }

    _onDestroy() {
        this._cancellable?.cancel();
        if (this._searchTimeoutId) {
            GLib.source_remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }
    }
});
