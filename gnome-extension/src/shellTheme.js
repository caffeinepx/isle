// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Optional colours from the GNOME Shell theme. The shell's theme object is never edited while a
// change notification is still running: doing that reloads the stylesheet forever and freezes the session.
// If it ever tries to load more than a few times in one second, Shell colours turn themselves off.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** What the island's cairo fills with. Black until Shell colours are on and a background was found.
 * `accent` is that theme's accent as RGB 0..255 while Shell colours are on, else null. */
export const paint = {red: 0, green: 0, blue: 0, alpha: 1, edge: 0.1, accent: null};

/** GNOME's accent names (`org.gnome.desktop.interface` accent-color), as RGB 0..1. */
const ACCENT_NAMES = {
    blue: [0x35, 0x84, 0xe4],
    teal: [0x21, 0x90, 0xa4],
    green: [0x3a, 0x94, 0x4a],
    yellow: [0xc8, 0x88, 0x00],
    orange: [0xed, 0x5b, 0x00],
    red: [0xe6, 0x2d, 0x42],
    pink: [0xd5, 0x61, 0x99],
    purple: [0x91, 0x41, 0xac],
    slate: [0x6f, 0x83, 0x96],
};

/** Isle artwork drawn in white. A symbolic icon is recoloured by the shell; these are not.
 * Brand marks and the two-tone output icon stay as drawn. */
const PLAIN_ICON = /^isle-(?!claude\.svg$|output-fill\.svg$)/;

const ICON_TINT = 'isle-shell-tint';

const SKIP = /privacy-dot|recording-dot|recording-pill|recording-time|call-icon|call-muted|compact-call|compact-second-call|call-duration|tab-call|peek-allowed|peek-denied|card-done|card-failed|card-risk|card-output-failed|reminders-title|reminders-count|reminder-check|reminder-dot|compact-warning|compact-assistant|chat-copied|card-copied/;

let settings = null;
let island = null;
let stylesheet = null;
let sheet = null;
let handles = [];
let repaint = null;
let applying = false;
let loadedKey = '';
let loads = [];
let stopped = false;
let idle = 0;
/** Cogl colour for white Isle icons while the bar's text is dark, else null. */
let iconTint = null;
let tintKey = '';

/** Follows `settings` and the shell theme. `changed` runs after the colours change, including once now. */
export function watch(extensionSettings, islandActor, stylesheetFile, changed) {
    unwatch();
    settings = extensionSettings;
    island = islandActor;
    stylesheet = stylesheetFile;
    repaint = changed ?? null;
    stopped = false;
    trackIcons(island);
    const context = St.ThemeContext.get_for_stage(global.stage);
    handles = [[settings, settings.connect('changed::appearance', () => schedule())]];
    try {
        handles.push([context, context.connect('changed', () => schedule())]);
    } catch (e) {
        // This Shell does not emit that. The setting still applies once, below.
    }
    schedule();
}

/** Drops the override. Safe to call more than once. */
export function unwatch() {
    if (idle) {
        GLib.source_remove(idle);
        idle = 0;
    }
    for (const [source, id] of handles) {
        try {
            source.disconnect(id);
        } catch (e) {
            // Already gone with the shell theme.
        }
    }
    handles = [];
    clearOverride();
    resetPaint();
    syncIcons(null);
    island?.remove_style_class_name('isle-shell');
    settings = null;
    island = null;
    stylesheet = null;
    repaint = null;
    loadedKey = '';
    applying = false;
}

/** Runs the colour change after the notification that asked for it has returned. */
function schedule() {
    if (idle || stopped || applying)
        return;
    idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        idle = 0;
        apply();
        return GLib.SOURCE_REMOVE;
    });
}

/** Shell colours, or Isle's own. A failure leaves the black notch and does not try again in a loop. */
function apply() {
    if (applying || stopped)
        return;
    applying = true;
    try {
        const shell = settings?.get_string('appearance') === 'shell';
        if (!shell || !stylesheet) {
            resetPaint();
            syncIcons(null);
            island?.remove_style_class_name('isle-shell');
            clearOverride();
            loadedKey = '';
            return;
        }
        const colors = themeColors();
        if (!colors) {
            console.warn('Isle: shell colours could not be read; the black notch stays');
            return;
        }
        // White artwork follows a dark bar's text. Light text leaves the artwork white.
        syncIcons(luminance(colors.fgChannels) < 0.55 ? colors.fgChannels : null);
        const key = `${colors.bg}|${colors.fg}|${colors.card}|${colors.accent}`;
        if (key === loadedKey)
            return;
        const now = GLib.get_monotonic_time();
        loads = loads.filter(time => now - time < 1_000_000);
        loads.push(now);
        if (loads.length > 3) {
            giveUp('the shell theme asked to restyle too often');
            return;
        }
        const [, bytes] = stylesheet.load_contents(null);
        const css = retint(new TextDecoder().decode(bytes), colors);
        install(css);
        loadedKey = key;
        paint.red = colors.bgChannels[0];
        paint.green = colors.bgChannels[1];
        paint.blue = colors.bgChannels[2];
        paint.alpha = colors.bgAlphaValue;
        paint.edge = 0.18;
        paint.accent = colors.accentChannels.map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255));
        island?.add_style_class_name('isle-shell');
    } catch (e) {
        giveUp(e.message);
    } finally {
        applying = false;
    }
    try {
        repaint?.();
    } catch (e) {
        console.warn(`Isle: shell colours could not repaint: ${e.message}`);
    }
}

/** Stops Shell colours for this session and puts the black notch back, including the saved setting. */
function giveUp(reason) {
    console.warn(`Isle: shell colours are off (${reason})`);
    stopped = true;
    resetPaint();
    syncIcons(null);
    island?.remove_style_class_name('isle-shell');
    clearOverride();
    loadedKey = '';
    try {
        if (settings?.get_string('appearance') === 'shell')
            settings.set_string('appearance', 'isle');
    } catch (e) {
        // The setting window can fix it later.
    }
}

function resetPaint() {
    paint.red = 0;
    paint.green = 0;
    paint.blue = 0;
    paint.alpha = 1;
    paint.edge = 0.1;
    paint.accent = null;
}

/** The shell theme's surfaces and text, or null when they cannot be read.
 * Named colours are the stock theme. A custom shell theme paints the panel and menus, often translucent. */
function themeColors() {
    const sampled = sampleShell();
    if (!sampled?.bg || !sampled?.fg)
        return null;
    const {bg, fg, card, accent, selectedFg, bgAlpha} = sampled;
    // A clear bar (the usual custom theme) has no fill. Buttons are a wash of its text, as the bar's own are.
    const clear = bgAlpha < 0.05;
    const cardColor = clear ? fg : (card ?? mix(bg, fg, 0.08));
    const fromShell = accent ? null : shellAccent();
    const accentColorValue = accent ?? fromShell?.rgb ?? desktopAccent() ?? [0.208, 0.517, 0.894];
    const selected = onAccentText(accentColorValue, selectedFg ?? fromShell?.fg);
    const rgbaOf = (channels, alpha) => {
        const byte = channel => Math.round(Math.min(1, Math.max(0, channel)) * 255);
        return `rgba(${byte(channels[0])}, ${byte(channels[1])}, ${byte(channels[2])}, ${alpha})`;
    };
    const surface = alpha => alpha < 0.05 ? 'transparent' : rgbaOf(bg, alpha);
    return {
        bg: surface(bgAlpha),
        fg: hex(fg),
        card: clear ? rgbaOf(fg, 0.12) : rgbaOf(cardColor, Math.min(1, bgAlpha + 0.12)),
        cardHover: clear ? rgbaOf(fg, 0.2) : rgbaOf(mix(cardColor, fg, 0.12), Math.min(1, bgAlpha + 0.18)),
        accent: hex(accentColorValue),
        selectedFg: hex(selected),
        fgAlpha: alpha => rgbaOf(fg, alpha),
        bgAlpha: alpha => rgbaOf(bg, alpha),
        accentAlpha: alpha => rgbaOf(accentColorValue, alpha),
        bgChannels: bg,
        fgChannels: fg,
        accentChannels: accentColorValue,
        bgAlphaValue: bgAlpha,
    };
}

/** The installed user theme's menu colour, as that stylesheet writes it. Null for the stock theme. */
function themeFileColor() {
    let name = '';
    try {
        name = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.user-theme'}).get_string('name');
    } catch (e) {
        return null;
    }
    if (!name || name === 'Default')
        return null;
    const path = [
        `/usr/share/themes/${name}/gnome-shell/gnome-shell.css`,
        `${GLib.get_home_dir()}/.themes/${name}/gnome-shell/gnome-shell.css`,
        `${GLib.get_user_data_dir()}/themes/${name}/gnome-shell/gnome-shell.css`,
    ].find(candidate => GLib.file_test(candidate, GLib.FileTest.EXISTS));
    if (!path)
        return null;
    let css = '';
    try {
        css = new TextDecoder().decode(GLib.file_get_contents(path)[1]);
    } catch (e) {
        return null;
    }
    // The island sits in the top bar. The buttons' text is what the clock and status icons use;
    // the bar's own `color` is the fallback. A menu's grey is neither.
    const panel = cssBlock(css, '#panel');
    const button = cssBlock(css, '#panel .panel-button');
    const background = parseCssColor(cssProp(panel, 'background-color'))
        ?? parseCssColor(cssProp(panel, 'background'));
    const foreground = parseCssColor(cssProp(button, 'color'))
        ?? parseCssColor(cssProp(panel, 'color'));
    if (!background && !foreground)
        return null;
    const accent = themeAccent(css);
    return {bg: background, fg: foreground, accent};
}

/** The colour a selected "today" is painted, when the theme writes a real colour for it. */
function themeAccent(css) {
    const block = cssBlock(css, '.calendar-today:selected');
    const background = parseCssColor(cssProp(block, 'background-color'));
    const foreground = parseCssColor(cssProp(block, 'color'));
    const usable = background && background.alpha > 0.4 && !nearExtreme(background.rgb);
    return {
        rgb: usable ? background.rgb : null,
        fg: foreground?.rgb ?? null,
    };
}

/** The `{ ... }` of the first `selector` rule. */
function cssBlock(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

function cssProp(block, name) {
    // Anchored so `background-color` is not read as `color`. That was painting the bar's fill as text.
    return block.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i'))?.[1]?.trim() ?? '';
}

/** `rgba()`, `rgb()`, `#rgb` or `#rrggbb` from a theme file. `!important` is ignored. */
function parseCssColor(text) {
    const value = text.replace(/!important/gi, '').trim();
    if (!value || /^-st-|^st-|^(inherit|unset|initial|currentcolor|none)$/i.test(value))
        return null;
    if (/^transparent$/i.test(value))
        return {rgb: [0, 0, 0], alpha: 0};
    if (/^white$/i.test(value))
        return {rgb: [1, 1, 1], alpha: 1};
    if (/^black$/i.test(value))
        return {rgb: [0, 0, 0], alpha: 1};
    const rgba = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (rgba)
        return {
            rgb: [Number(rgba[1]) / 255, Number(rgba[2]) / 255, Number(rgba[3]) / 255],
            alpha: rgba[4] != null ? Number(rgba[4]) : 1,
        };
    const long = value.match(/#([0-9a-f]{6})\b/i);
    if (long) {
        const hex = long[1];
        return {rgb: [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255), alpha: 1};
    }
    const short = value.match(/#([0-9a-f]{3})\b/i);
    if (!short)
        return null;
    const hex = short[1];
    return {rgb: [0, 1, 2].map(i => parseInt(hex[i] + hex[i], 16) / 255), alpha: 1};
}

/** Background, text and alpha from the user theme, else from a menu the theme has painted. */
function sampleShell() {
    const fromFile = themeFileColor();
    if (fromFile?.bg || fromFile?.fg) {
        const bg = fromFile.bg?.rgb ?? [0, 0, 0];
        const bgAlpha = fromFile.bg?.alpha ?? 0;
        // No readable text in the file: light on a dark bar, dark on a light one. Not the stage's grey.
        const fg = fromFile.fg?.rgb ?? (luminance(bg) > 0.55 ? [0.11, 0.12, 0.14] : [1, 1, 1]);
        return {
            bg, fg, bgAlpha,
            card: null,
            accent: fromFile.accent?.rgb ?? null,
            selectedFg: fromFile.accent?.fg ?? null,
        };
    }

    const panel = Main.layoutManager.panelBox;
    const probe = new St.Widget({style_class: 'popup-menu-boxpointer', opacity: 0});
    const menu = new St.Widget({style_class: 'popup-menu'});
    const content = new St.Widget({style_class: 'popup-menu-content'});
    menu.add_child(content);
    probe.add_child(menu);
    Main.layoutManager.uiGroup.add_child(probe);
    let menuBg = null;
    let menuFg = null;
    let panelBg = null;
    let panelFg = null;
    try {
        const node = content.get_theme_node();
        menuBg = nodeColor(node, 'get_background_color');
        menuFg = nodeColor(node, 'get_foreground_color');
        const panelNode = panel?.get_theme_node();
        panelBg = nodeColor(panelNode, 'get_background_color');
        panelFg = nodeColor(panelNode, 'get_foreground_color');
    } catch (e) {
        probe.destroy();
        return null;
    }
    probe.destroy();
    // The bar's own text, even when the theme leaves the bar clear. A menu colour is only a last resort.
    const liveBg = actorBackground(Main.panel.statusArea.dateMenu?.menu?.box)
        ?? actorBackground(Main.panel.statusArea.quickSettings?.menu?.box);
    const liveFg = actorForeground(Main.panel.statusArea.dateMenu?.menu?.box)
        ?? actorForeground(Main.panel.statusArea.quickSettings?.menu?.box);
    const bg = panelBg ?? liveBg ?? menuBg;
    const fg = panelFg ?? liveFg ?? menuFg;
    if (!bg || !fg)
        return null;
    return {bg: bg.rgb, fg: fg.rgb, bgAlpha: bg.alpha, card: null, accent: null, selectedFg: null};
}

function actorBackground(actor) {
    try {
        return nodeColor(actor?.get_theme_node?.(), 'get_background_color');
    } catch (e) {
        return null;
    }
}

function actorForeground(actor) {
    try {
        return nodeColor(actor?.get_theme_node?.(), 'get_foreground_color');
    } catch (e) {
        return null;
    }
}

/** A theme node's colour. These getters fill a colour you pass; they do not return one. */
function nodeColor(node, method) {
    if (!node?.[method])
        return null;
    const color = new Cogl.Color();
    try {
        const result = node[method](color);
        return colorOf(Array.isArray(result) ? result[0] : (result ?? color));
    } catch (e) {
        return null;
    }
}

/** The shell accent and the text drawn on it, or null. The call fills two colours; it does not return one. */
function shellAccent() {
    try {
        const accent = new Cogl.Color();
        const onAccent = new Cogl.Color();
        let result = null;
        const context = St.ThemeContext.get_for_stage(global.stage);
        try {
            result = context.get_accent_color(accent, onAccent);
        } catch (e) {
            result = context.get_accent_color();
        }
        const pair = Array.isArray(result) ? result : [result ?? accent, onAccent];
        const rgb = readChannels(pair[0]) ?? readChannels(accent);
        if (!rgb || nearBlack(rgb))
            return null;
        const fg = readChannels(pair[1]) ?? readChannels(onAccent);
        return {rgb, fg: fg && !nearBlack(fg) ? fg : null};
    } catch (e) {
        return null;
    }
}

/** The accent chosen in Settings, when the theme does not paint its own. */
function desktopAccent() {
    try {
        const name = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('accent-color');
        const bytes = ACCENT_NAMES[name];
        return bytes ? bytes.map(channel => channel / 255) : null;
    } catch (e) {
        return null;
    }
}

/** Text that stays readable on `accent`. `hint` is the theme's own, when it contrasts. */
function onAccentText(accent, hint) {
    if (hint && Math.abs(luminance(hint) - luminance(accent)) >= 0.28)
        return hint;
    return luminance(accent) > 0.62 ? [0.11, 0.12, 0.14] : [1, 1, 1];
}

/** Relative luminance, 0..1. */
function luminance(rgb) {
    const lin = channel => {
        const value = Math.min(1, Math.max(0, channel));
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = rgb.map(lin);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function nearBlack(rgb) {
    return rgb[0] + rgb[1] + rgb[2] < 0.08;
}

/** Too close to black or white to be an accent swatch. */
function nearExtreme(rgb) {
    const light = luminance(rgb);
    return light < 0.06 || light > 0.94;
}

/** RGB and alpha, or null. A clear colour is kept: that is how a glassy theme is written. */
function colorOf(color) {
    if (!color || Array.isArray(color))
        return null;
    const rgb = readChannels(color);
    if (!rgb)
        return null;
    let alpha = null;
    try {
        alpha = typeof color.get_alpha === 'function' ? color.get_alpha() : color.alpha;
    } catch (e) {
        alpha = null;
    }
    const normalized = typeof alpha === 'number' ? (alpha > 1 ? alpha / 255 : alpha) : 1;
    return {rgb, alpha: normalized};
}

/** `name` as RGB 0..1, or null. Both lookup shapes are tried; neither is allowed to escape. */
function lookup(theme, name) {
    try {
        const found = theme.lookup_color(name);
        const color = Array.isArray(found) ? (found[0] ? found[1] : null) : found;
        if (color && typeof color === 'object')
            return readChannels(color);
    } catch (e) {
        // Some shells fill a colour in instead of returning one.
    }
    try {
        const color = new Cogl.Color();
        if (theme.lookup_color(name, color))
            return readChannels(color);
    } catch (e) {
        return null;
    }
    return null;
}

/** RGB 0..1 from a Cogl colour. The getter is used first: the `.red` field stays 0 when it was never filled,
 * and `??` would keep that 0 and turn the accent black. */
function readChannels(color) {
    if (!color || typeof color !== 'object')
        return null;
    const channel = name => {
        try {
            const getter = color[`get_${name}`];
            if (typeof getter === 'function') {
                const value = getter.call(color);
                if (typeof value === 'number' && !Number.isNaN(value))
                    return value > 1 ? value / 255 : value;
            }
        } catch (e) {
            // The field below is the other shape.
        }
        const value = color[name];
        if (typeof value !== 'number' || Number.isNaN(value))
            return null;
        return value > 1 ? value / 255 : value;
    };
    const rgb = ['red', 'green', 'blue'].map(channel);
    return rgb.some(value => value == null) ? null : rgb;
}

/** `#rrggbb` from RGB 0..1. */
function hex(channels) {
    const byte = channel => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0');
    return `#${byte(channels[0])}${byte(channels[1])}${byte(channels[2])}`;
}

/** `a` stepped toward `b` by `amount` (0..1). */
function mix(a, b, amount) {
    return a.map((channel, index) => channel + (b[index] - channel) * amount);
}

/** The island's rules, recoloured. The panel is left alone. */
function retint(css, colors) {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [];
    const pattern = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while ((match = pattern.exec(stripped))) {
        const selector = match[1].trim();
        if (!selector || selector.startsWith('@') || selector.includes('#panel') || SKIP.test(selector))
            continue;
        const body = paintBody(match[2], colors, selector);
        if (body === match[2])
            continue;
        rules.push(`${scope(selector)} {${body}}`);
    }
    // Labels with no colour of their own inherit this, instead of the stage's dimmer grey.
    rules.push(`#isleIsland.isle-shell { color: ${colors.fg} !important; }`);
    return rules.join('\n');
}

/** `#isleIsland` itself keeps its id; everything else is scoped under the shell class. */
function scope(selector) {
    return selector.split(',').map(part => {
        const trimmed = part.trim();
        if (trimmed === '#isleIsland' || trimmed.startsWith('#isleIsland ') || trimmed.startsWith('#isleIsland.') || trimmed.startsWith('#isleIsland:'))
            return trimmed.replace('#isleIsland', '#isleIsland.isle-shell');
        return `#isleIsland.isle-shell ${trimmed}`;
    }).join(', ');
}

/** Neutral whites, blacks and greys become the theme. Status reds and greens stay. */
function paintBody(body, colors, selector) {
    const onAccent = /cal-day\.today|cal-dot\.on-today/.test(selector);
    const text = onAccent ? colors.selectedFg : colors.fg;
    // A clear bar has no solid fill. Black text sat on white chips; it has to stay an ink, not turn transparent.
    const ink = colors.bg === 'transparent'
        ? (luminance(colors.fgChannels) > 0.55 ? '#141416' : '#f2f2f7')
        : colors.bg;
    let next = body;
    next = next.replace(/#ffffff\b/gi, text);
    next = next.replace(/#fff\b/gi, text);
    next = next.replace(/#000000\b/gi, ink);
    next = next.replace(/#000\b/gi, ink);
    next = next.replace(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([0-9.]+)\s*\)/gi,
        (_match, alpha) => colors.fgAlpha(alpha));
    next = next.replace(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([0-9.]+)\s*\)/gi,
        (_match, alpha) => colors.bgAlpha(alpha));
    next = next.replace(/rgba\(\s*10\s*,\s*132\s*,\s*255\s*,\s*([0-9.]+)\s*\)/gi,
        (_match, alpha) => colors.accentAlpha(alpha));
    for (const [from, to] of [['#1c1c1e', colors.bg], ['#2c2c2e', colors.card], ['#3a3a3c', colors.cardHover],
        ['#48484a', colors.cardHover], ['#4a4a4e', colors.cardHover], ['#5a5a5e', colors.cardHover], ['#e6e6e6', colors.cardHover]])
        next = next.replace(new RegExp(from, 'gi'), to);
    next = next.replace(/#0a84ff\b|#2b95ff\b|#0071e3\b/gi, colors.accent);
    if (/cal-day\.today|cal-month-name/.test(selector))
        next = next.replace(/#ff453a\b|#ff5f55\b|#ff6961\b/gi, colors.accent);
    // Today is a filled accent. Its number has to be the text that sits on that accent, not the bar's.
    if (/cal-day\.today/.test(selector) && !/(?:^|;)\s*color\s*:/i.test(next))
        next += ` color: ${colors.selectedFg};`;
    return next;
}

/** Follows icons added after the colours were applied. */
function trackIcons(actor) {
    if (!actor || actor._isleIconWatch)
        return;
    actor._isleIconWatch = true;
    try {
        actor.connect('child-added', (_parent, child) => {
            trackIcons(child);
            walkIcons(child);
        });
    } catch (e) {
        // A plain actor with no children signal still has its current children, below.
    }
    for (const child of childrenOf(actor))
        trackIcons(child);
}

/** Darkens white Isle icons to `rgb` (0..1), or clears that tint. A failure here must not turn Shell colours off. */
function syncIcons(rgb) {
    const key = rgb ? rgb.map(channel => channel.toFixed(3)).join(',') : '';
    if (key === tintKey)
        return;
    tintKey = key;
    try {
        iconTint = rgb ? coglColor(rgb) : null;
        walkIcons(island);
    } catch (e) {
        iconTint = null;
        tintKey = '';
        console.warn(`Isle: icons could not take the bar colour: ${e.message}`);
    }
}

function walkIcons(actor) {
    if (!actor)
        return;
    if (actor instanceof St.Icon)
        applyIconTint(actor);
    for (const child of childrenOf(actor))
        walkIcons(child);
}

function childrenOf(actor) {
    try {
        const count = actor.get_n_children?.() ?? 0;
        const children = [];
        for (let i = 0; i < count; i++)
            children.push(actor.get_child_at_index(i));
        return children;
    } catch (e) {
        return [];
    }
}

/** White outline artwork takes the bar's text colour. Symbolic icons already follow `color`. */
function applyIconTint(icon) {
    try {
        applyIconTintUnsafe(icon);
    } catch (e) {
        // A going icon can refuse an effect. The text colour still stands.
    }
}

function applyIconTintUnsafe(icon) {
    if (!icon._isleTintHook) {
        icon._isleTintHook = icon.connect('notify::gicon', () => applyIconTint(icon));
    }
    let effect = null;
    try {
        effect = icon.get_effect(ICON_TINT);
    } catch (e) {
        effect = null;
    }
    if (!iconTint || !plainIcon(icon.gicon)) {
        if (effect)
            icon.remove_effect(effect);
        return;
    }
    if (!effect) {
        effect = new Clutter.ColorizeEffect();
        effect.set_tint(iconTint);
        icon.add_effect_with_name(ICON_TINT, effect);
        return;
    }
    effect.set_tint(iconTint);
}

function plainIcon(gicon) {
    if (!(gicon instanceof Gio.FileIcon))
        return false;
    const base = gicon.get_file().get_basename() ?? '';
    return PLAIN_ICON.test(base) && !base.includes('-symbolic');
}

function coglColor(rgb) {
    const color = new Cogl.Color();
    color.init_from_4f(rgb[0], rgb[1], rgb[2], 1);
    return color;
}

/** Loads `css` after Isle's own sheet. */
function install(css) {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'isle']);
    GLib.mkdir_with_parents(dir, 0o700);
    const path = GLib.build_filenamev([dir, 'shell-theme.css']);
    GLib.file_set_contents(path, css);
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    if (sheet)
        theme.unload_stylesheet(sheet);
    sheet = Gio.File.new_for_path(path);
    theme.load_stylesheet(sheet);
}

/** Takes the override off. */
function clearOverride() {
    if (!sheet)
        return;
    try {
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(sheet);
    } catch (e) {
        // The theme was already replaced.
    }
    sheet = null;
}
