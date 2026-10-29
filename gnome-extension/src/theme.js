// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The island's colour is black, or the shell theme's top bar. Glass only blurs what is behind that colour
// and tints it. What Cairo paints in the island's colour asks here; CSS does the rest.

let shellFill = null;
let glassOn = false;
/** 0 is a light tint, 1 is a dark one. It does not change the blur. */
let glassTint = 0.3;
/** 0 barely refracts what is behind, 1 is a strong liquid-glass blur. */
let glassRefraction = 0.45;

/** `fill` is RGBA 0..1 from the shell theme, or null for Isle's own black. */
export function setShellFill(fill) {
    shellFill = fill;
}

/** Glass is a blur and a tint over the island colour. `tint` and `refraction` are 0..1. */
export function setGlass(on, tint = glassTint, refraction = glassRefraction) {
    glassOn = Boolean(on);
    glassTint = Math.min(1, Math.max(0, tint));
    glassRefraction = Math.min(1, Math.max(0, refraction));
}

/** Whether the blur is on. */
export function glass() {
    return glassOn;
}

/** 'glass' while the blur is on, otherwise 'black'. The light and alerts use this. */
export function theme() {
    return glassOn ? 'glass' : 'black';
}

/** The island's colour. With glass, the same colour at a low alpha so the blur shows through. */
export function fill() {
    const rgb = (shellFill ?? [0, 0, 0]).slice(0, 3);
    if (!glassOn)
        return [...rgb, shellFill ? shellFill[3] : 1];
    // A little white in a light tint, so it reads as glass rather than a flat dark wash.
    const lift = (1 - glassTint) * 0.1;
    return [...rgb.map(channel => channel + (1 - channel) * lift), 0.14 + glassTint * 0.5];
}

/** An opaque colour as dark as the island looks, as RGB: for rings and corners painted over it. */
export function solid() {
    const rgb = (shellFill ?? [0, 0, 0]).slice(0, 3);
    if (!glassOn)
        return rgb;
    return rgb.map(channel => channel * (0.45 + glassTint * 0.55));
}

/** The hairline round the island, as RGBA, or null for none. */
export function edge() {
    if (!glassOn)
        return null;
    return [1, 1, 1, 0.22 - glassTint * 0.1];
}

/** How what is behind the island is refracted ({radius, brightness}), or null for not at all. */
export function blur() {
    if (!glassOn)
        return null;
    return {radius: Math.round(2 + glassRefraction * 46), brightness: 1.04};
}
