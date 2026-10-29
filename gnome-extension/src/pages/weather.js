// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// One place's weather, from the cities saved in GNOME Weather. Others stay in that list
// and are chosen from Edit; only the chosen one is fetched.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GWeather from 'gi://GWeather?version=4.0';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {icon, iconButton, label} from '../widgets.js';
import {kindForIcon} from '../weatherArt.js';
import {WeatherScene} from '../weatherScene.js';
import {allCities} from '../worldClocks.js';
import {Page} from './page.js';

/** How often a shown page asks GNOME Weather again. */
const REFRESH_MS = 15 * 60 * 1000;
/** Wait after the last key before searching, so a half-typed city is not filtered. */
const SEARCH_MS = 200;
const WEATHER_SCHEMA = 'org.gnome.Weather';

/** GNOME Weather's saved cities, or null when that app's settings are not installed. */
function weatherSettings() {
    const source = Gio.SettingsSchemaSource.get_default();
    return source?.lookup(WEATHER_SCHEMA, true)?.has_key('locations')
        ? new Gio.Settings({schema_id: WEATHER_SCHEMA}) : null;
}

/** `{location, name, detail}` for each city GNOME Weather shows. */
function readPlaces(settings) {
    if (!settings)
        return [];
    const world = GWeather.Location.get_world();
    const places = [];
    for (const serialized of settings.get_value('locations').deepUnpack()) {
        const location = world?.deserialize(serialized);
        if (!location)
            continue;
        const name = location.get_city_name?.() || location.get_name?.() || '';
        if (!name)
            continue;
        places.push({
            location,
            name,
            detail: location.get_country_name?.() || '',
        });
    }
    return places;
}

/** Writes GNOME Weather's city list. `locations` are GWeather locations. */
function writePlaces(settings, locations) {
    settings.set_value('locations', new GLib.Variant('av', locations.map(location => location.serialize())));
}

/** A temperature GNOME Weather actually has. "--" is what it prints when the high or low is unknown. */
function temperature(text) {
    return text && /\d/.test(text) ? text : '';
}

/** Humidity, wind and today's high and low, on one line. */
function detailLine(info) {
    const high = temperature(info.get_temp_max?.());
    const low = temperature(info.get_temp_min?.());
    const humidity = temperature(info.get_humidity?.()) ? info.get_humidity() : '';
    const wind = info.get_wind?.() || '';
    const usefulWind = wind && !wind.includes('--') ? wind : '';
    return [
        high && low ? `${high} / ${low}` : high || low,
        humidity && `Humidity ${humidity}`,
        usefulWind,
    ].filter(Boolean).join('  ·  ');
}

/** Forecast entries GNOME Weather attached to this reading. */
function forecastItems(info) {
    try {
        const list = info.get_forecast_list?.();
        if (!list)
            return [];
        if (Array.isArray(list))
            return list;
        const items = [];
        for (let node = list; node; node = node.next)
            items.push(node.data);
        return items;
    } catch (e) {
        return [];
    }
}

/** "15:00" from a forecast slot, or "". */
function forecastWhen(item) {
    try {
        const when = item.get_value_update?.() ?? item.get_update?.();
        if (when?.format)
            return when.format('%H:%M');
        if (typeof when === 'string' && /\d/.test(when))
            return when.split(' ').pop();
    } catch (e) {
        return '';
    }
    return '';
}

/** The cities on screen. Pair mode adds the next saved city beside the chosen one. */
function shownPlaces(isle, gnome) {
    const places = readPlaces(gnome);
    if (!places.length)
        return {places, index: 0, shown: [], pair: false};
    const index = Math.min(Math.max(isle.get_int('weather-place'), 0), places.length - 1);
    const pair = isle.get_string('weather-layout') === 'pair' && places.length > 1;
    const shown = pair ? [places[index], places[(index + 1) % places.length]] : [places[index]];
    return {places, index, shown, pair};
}

/** The weather page: the chosen GNOME Weather city, or that list. */
export const WeatherPage = GObject.registerClass(
class WeatherPage extends Page {
    /** `settings` is Isle's, only for which saved city is on screen. */
    _init(daemon, settings, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-weather-page',
            layout_manager: new Clutter.BinLayout(),
            height,
        });
        this.name = 'weather';
        this._settings = settings;
        this._gnome = weatherSettings();
        this._editing = false;
        this._info = null;
        this._infoId = 0;
        this._info2 = null;
        this._info2Id = 0;
        /** When the city on screen was last asked for, so opening the island does not fetch again. */
        this._fetchedAt = 0;
        this._fetchedName = '';
        this._fetchedName2 = '';

        this._card = this._buildCard();
        this._editor = this._buildEditor();
        this.add_child(this._card);
        this.add_child(this._editor);

        if (this._gnome)
            this._gnomeChanged = this._gnome.connect('changed::locations', () => this._placesChangedNow());
        this._placeChanged = settings.connect('changed::weather-place', () => this._placesChangedNow());
        this._layoutChanged = settings.connect('changed::weather-layout', () => this._placesChangedNow());
        this.connect('destroy', () => {
            if (this._infoId)
                this._info.disconnect(this._infoId);
            if (this._info2Id)
                this._info2.disconnect(this._info2Id);
            this._info?.abort();
            this._info2?.abort();
            if (this._gnomeChanged)
                this._gnome.disconnect(this._gnomeChanged);
            settings.disconnect(this._placeChanged);
            settings.disconnect(this._layoutChanged);
        });
        this._showReport();
        this._syncMode();
    }

    /** Fetches while this page is the one open. */
    onActivate() {
        const pair = this._settings.get_string('weather-layout') === 'pair';
        this._scene.animated = true;
        this._scene2.animated = pair;
        this._fetch();
        this._armRefresh();
    }

    /** The scene stops when the page is not the one on screen. */
    onDeactivate() {
        this._scene.animated = false;
        this._scene2.animated = false;
    }

    /** One GWeather info for the city on screen. Providers need an id and a contact. */
    _ensureInfo() {
        if (this._info)
            return true;
        try {
            this._info = new GWeather.Info({location: null});
            this._info.application_id = 'io.github.zickrian.isle';
            this._info.contact_info = 'https://github.com/zickrian/isle';
            this._info.enabled_providers = GWeather.Provider.METAR | GWeather.Provider.MET_NO;
            this._infoId = this._info.connect('updated', () => this._showReport());
            return true;
        } catch (e) {
            console.warn(`Isle: weather could not start: ${e.message}`);
            return false;
        }
    }

    /** A second info, only used when two cities are shown. */
    _ensureInfo2() {
        if (this._info2)
            return true;
        try {
            this._info2 = new GWeather.Info({location: null});
            this._info2.application_id = 'io.github.zickrian.isle';
            this._info2.contact_info = 'https://github.com/zickrian/isle';
            this._info2.enabled_providers = GWeather.Provider.METAR | GWeather.Provider.MET_NO;
            this._info2Id = this._info2.connect('updated', () => this._showReport());
            return true;
        } catch (e) {
            return false;
        }
    }

    /** Asks for one city, unless that reading is still fresh. */
    _fetchOne(info, place, previous) {
        if (!info || !place)
            return previous;
        if (previous === place.name && info.is_valid?.())
            return previous;
        const current = info.get_location?.();
        if (current !== place.location)
            info.set_location(place.location);
        info.update();
        return place.name;
    }

    /** Asks GNOME Weather's services for the cities on screen. */
    _fetch() {
        const {shown} = shownPlaces(this._settings, this._gnome);
        if (!shown.length) {
            this._showReport();
            return;
        }
        if (!this._ensureInfo())
            return;
        const fresh = Date.now() - this._fetchedAt < REFRESH_MS;
        if (!fresh || this._fetchedName !== shown[0].name) {
            this._fetchedName = this._fetchOne(this._info, shown[0], '');
            this._fetchedAt = Date.now();
        }
        if (shown[1] && this._ensureInfo2() && this._fetchedName2 !== shown[1].name) {
            this._fetchedName2 = this._fetchOne(this._info2, shown[1], '');
        }
        this._showReport();
    }

    /** The card, or the saved places. */
    _syncMode() {
        this._card.visible = !this._editing;
        this._editor.visible = this._editing;
        if (this._editing)
            this._fillPlaces();
    }

    /** One city: icon beside its name, temperature and condition. */
    _buildCity() {
        const box = new St.BoxLayout({style_class: 'isle-weather-city', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const scene = new WeatherScene();
        const copy = new St.BoxLayout({...VERTICAL, style_class: 'isle-weather-copy', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const place = label('', 'isle-weather-place');
        place.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const temp = label('—', 'isle-weather-temp');
        const condition = label('', 'isle-weather-condition');
        const facts = label('', 'isle-weather-facts');
        facts.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const forecast = new St.BoxLayout({style_class: 'isle-weather-forecast'});
        for (const child of [place, temp, condition, facts, forecast])
            copy.add_child(child);
        box.add_child(scene);
        box.add_child(copy);
        return {box, copy, scene, place, temp, condition, facts, forecast};
    }

    /** The cities side by side, with Edit at the right edge. */
    _buildCard() {
        const row = new St.BoxLayout({style_class: 'isle-weather', x_expand: true, y_expand: true});
        const first = this._buildCity();
        this._scene = first.scene;
        this._place = first.place;
        this._temp = first.temp;
        this._condition = first.condition;
        this._facts = first.facts;
        this._forecast = first.forecast;
        this._empty = new St.BoxLayout({...VERTICAL, style_class: 'isle-weather-empty'});
        this._empty.add_child(label(this._gnome ? 'No place yet' : 'GNOME Weather is not installed', 'isle-empty-title'));
        if (this._gnome) {
            const add = new St.Button({style_class: 'isle-pill isle-pill-small', label: 'Add a place', can_focus: true});
            add.connect('clicked', () => this._setEditing(true));
            this._empty.add_child(add);
        }
        first.copy.add_child(this._empty);
        row.add_child(first.box);

        this._divider = label('|', 'isle-weather-divider');
        row.add_child(this._divider);

        const second = this._buildCity();
        this._pair = second.box;
        this._scene2 = second.scene;
        this._place2 = second.place;
        this._temp2 = second.temp;
        this._condition2 = second.condition;
        second.facts.visible = false;
        second.forecast.visible = false;
        row.add_child(second.box);

        row.add_child(iconButton('isle-settings', 'isle-button-flat isle-weather-edit', () => this._setEditing(true),
            {size: 16, accessibleName: 'Edit places'}));
        return row;
    }

    /** Search, then GNOME Weather's cities. A row chooses what the card shows. */
    _buildEditor() {
        const column = new St.BoxLayout({...VERTICAL, style_class: 'isle-weather-editor', x_expand: true, y_expand: true});
        const head = new St.BoxLayout({style_class: 'isle-weather-head'});
        head.add_child(label('Places', 'isle-weather-place', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        head.add_child(iconButton('isle-check-symbolic', 'isle-button-flat', () => this._setEditing(false),
            {size: 16, accessibleName: 'Done'}));
        column.add_child(head);

        this._entry = new St.Entry({
            style_class: 'isle-entry isle-weather-search',
            hint_text: 'Add a city',
            can_focus: true,
            x_expand: true,
            visible: Boolean(this._gnome),
        });
        this._entry.clutter_text.connect('text-changed', () => this.later('search', SEARCH_MS, () => this._search()));
        this._entry.clutter_text.connect('button-press-event', () => {
            this.emit('request-keyboard', true);
            return Clutter.EVENT_PROPAGATE;
        });
        column.add_child(this._entry);

        this._results = new St.BoxLayout({...VERTICAL, style_class: 'isle-weather-list'});
        this._saved = new St.BoxLayout({...VERTICAL, style_class: 'isle-weather-list'});
        const scroll = new St.ScrollView({
            style_class: 'isle-cal-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        const lists = new St.BoxLayout({...VERTICAL, style_class: 'isle-weather-lists'});
        lists.add_child(this._results);
        lists.add_child(this._saved);
        scroll.set_child(lists);
        column.add_child(scroll);
        return column;
    }

    /** Opens the list, or goes back to the one place. */
    _setEditing(editing) {
        this._editing = editing;
        if (!editing) {
            this._entry.text = '';
            this._results.destroy_all_children();
            this.emit('request-keyboard', false);
        }
        this._syncMode();
    }

    /** The saved list changed, or which one is shown did. */
    _placesChangedNow() {
        this._fetch();
        if (this._editing)
            this.later('places', 0, () => {
                if (this._editing)
                    this._fillPlaces();
            });
    }

    /** Again later, while this page is the one open. */
    _armRefresh() {
        this.later('refresh', REFRESH_MS, () => {
            if (!this.active)
                return;
            this._info?.update();
            this._armRefresh();
        });
    }

    /** Details under the city, or a second city, as Settings say. */
    _syncLayout() {
        const pair = this._settings.get_string('weather-layout') === 'pair' && readPlaces(this._gnome).length > 1;
        this._facts.visible = !pair;
        this._forecast.visible = !pair;
        this._pair.visible = pair;
        this._divider.visible = pair;
        if (pair)
            this.add_style_class_name('isle-weather-pair');
        else
            this.remove_style_class_name('isle-weather-pair');
    }

    /** Fills the card from GNOME Weather, or the empty state when nothing is saved. */
    _showReport() {
        this._syncLayout();
        const {shown, pair} = shownPlaces(this._settings, this._gnome);
        const place = shown[0] ?? null;
        this._empty.visible = !place;
        this._temp.visible = Boolean(place);
        this._condition.visible = Boolean(place);
        this._place.text = place ? place.name : 'Weather';
        if (!place) {
            this._scene.setWeather('clear', false);
            this._facts.text = '';
            this._forecast.destroy_all_children();
            this._pair.visible = false;
            return;
        }
        this._fillCity(this._info, place, {
            temp: this._temp,
            condition: this._condition,
            scene: this._scene,
            facts: pair ? null : this._facts,
            forecast: pair ? null : this._forecast,
        });
        if (pair && shown[1])
            this._fillCity(this._info2, shown[1], {
                temp: this._temp2,
                condition: this._condition2,
                scene: this._scene2,
                place: this._place2,
            });
    }

    /** One city's reading into the labels it owns. */
    _fillCity(info, place, {temp, condition, scene, facts, forecast, place: placeLabel}) {
        if (placeLabel)
            placeLabel.text = place.name;
        const infoName = info?.get_location_name?.() || '';
        const ready = Boolean(info?.is_valid?.() && (!infoName || infoName === place.name));
        if (!ready) {
            temp.text = '—';
            condition.text = info?.network_error?.() ? 'Can’t reach the weather' : 'Looking…';
            if (facts)
                facts.text = '';
            forecast?.destroy_all_children();
            scene.setWeather('partly', false);
            return;
        }
        const summary = info.get_weather_summary?.() || '';
        const named = summary.startsWith(`${place.name}:`)
            ? summary.slice(place.name.length + 1).trim()
            : summary;
        temp.text = info.get_temp?.() || '—';
        condition.text = named;
        let night = false;
        try {
            night = info.is_daytime() === false;
        } catch (e) {
            night = false;
        }
        scene.setWeather(kindForIcon(info.get_icon_name?.() || info.get_symbolic_icon_name?.()), night);
        if (facts)
            facts.text = detailLine(info);
        if (forecast)
            this._fillForecast(forecast, info);
    }

    /** The next few hours, under the condition. */
    _fillForecast(box, info) {
        box.destroy_all_children();
        for (const item of forecastItems(info).slice(0, 4)) {
            const when = forecastWhen(item);
            const value = temperature(item.get_temp?.());
            if (!when || !value)
                continue;
            const chip = new St.BoxLayout({...VERTICAL, style_class: 'isle-weather-hour'});
            chip.add_child(label(when, 'isle-weather-hour-time'));
            chip.add_child(label(value, 'isle-weather-hour-temp'));
            box.add_child(chip);
        }
        box.visible = box.get_n_children() > 0;
    }

    /** GNOME Weather's cities, the shown one marked. */
    _fillPlaces() {
        this._saved.destroy_all_children();
        const {places, index} = shownPlaces(this._settings, this._gnome);
        if (!this._gnome) {
            this._saved.add_child(label('Install GNOME Weather to keep cities', 'isle-weather-condition'));
            return;
        }
        if (!places.length) {
            this._saved.add_child(label('Search for a city to add', 'isle-weather-condition'));
            return;
        }
        places.forEach((place, i) => {
            const row = new St.BoxLayout({style_class: 'isle-weather-row', x_expand: true});
            const name = label(place.name, 'isle-weather-row-name', {x_expand: true});
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(name);
            row.add_child(new St.Icon({
                gicon: icon('isle-check-symbolic'),
                icon_size: 14,
                opacity: i === index ? 255 : 0,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const button = new St.Button({
                style_class: `isle-weather-place-button${i === index ? ' active' : ''}`,
                child: row,
                x_expand: true,
                can_focus: true,
            });
            button.connect('clicked', () => {
                this._settings.set_int('weather-place', i);
                this._setEditing(false);
            });
            const line = new St.BoxLayout({x_expand: true});
            line.add_child(button);
            line.add_child(iconButton('isle-close-symbolic', 'isle-button-flat', () => this._remove(i),
                {size: 14, accessibleName: `Remove ${place.name}`}));
            this._saved.add_child(line);
        });
    }

    /** Drops a city from GNOME Weather. The next one is shown, or the one before when it was last. */
    _remove(index) {
        const places = readPlaces(this._gnome);
        const current = this._settings.get_int('weather-place');
        const locations = places.map(place => place.location);
        locations.splice(index, 1);
        let next = current;
        if (index < current)
            next -= 1;
        else if (index === current)
            next = Math.min(current, Math.max(locations.length - 1, 0));
        writePlaces(this._gnome, locations);
        this._settings.set_int('weather-place', Math.max(0, next));
    }

    /** Cities from GNOME's own list, under the field. */
    _search() {
        const query = this._entry.text.trim().toLowerCase();
        this._results.destroy_all_children();
        if (!query || !this._gnome)
            return;
        const found = allCities().filter(city => city.search.includes(query)).slice(0, 6);
        for (const city of found) {
            const row = new St.BoxLayout({...VERTICAL, style_class: 'isle-weather-row', x_expand: true});
            row.add_child(label(city.name, 'isle-weather-row-name'));
            if (city.place)
                row.add_child(label(city.place, 'isle-weather-condition'));
            const button = new St.Button({style_class: 'isle-weather-place-button', child: row, x_expand: true, can_focus: true});
            button.connect('clicked', () => this._add(city));
            this._results.add_child(button);
        }
    }

    /** Saves a city into GNOME Weather and shows it. */
    _add(city) {
        const places = readPlaces(this._gnome);
        const existing = places.findIndex(place => {
            try {
                return place.location.equal(city.location);
            } catch (e) {
                return place.name === city.name;
            }
        });
        const locations = places.map(place => place.location);
        const index = existing >= 0 ? existing : locations.length;
        if (existing < 0)
            locations.push(city.location);
        writePlaces(this._gnome, locations);
        this._settings.set_int('weather-place', index);
        this._setEditing(false);
    }
});
