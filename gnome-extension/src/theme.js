// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The island's colour is black, or the shell theme's top bar. Glass only blurs what is behind that colour
// and tints it. What Cairo paints in the island's colour asks here; CSS does the rest.

let shellFill = null;
let glassOn = false;
/** 0 is clear liquid glass, 1 is a darker tint and a softer blur. */
let glassAmount = 0.35;

/** `fill` is RGBA 0..1 from the shell theme, or null for Isle's own black. */
export function setShellFill(fill) {
    shellFill = fill;
}

/** Glass is a blur and a tint over the island colour. It does not pick the colour. */
export function setGlass(on, amount = glassAmount) {
    glassOn = Boolean(on);
    glassAmount = Math.min(1, Math.max(0, amount));
}

/** Whether the blur is on. */
export function glass() {
    return glassOn;
}

/** 'glass' while the blur is on, otherwise 'black'. The light and alerts use this. */
export function theme() {
    return glassOn ? 'glass' : 'black';
}

/** 0..1 from the Glass slider. */
export function glassAmountOf() {
    return glassAmount;
}

/** The island's colour. With glass, the same colour at a low alpha so the blur shows through. */
export function fill() {
    const rgb = (shellFill ?? [0, 0, 0]).slice(0, 3);
    if (!glassOn)
        return [...rgb, shellFill ? shellFill[3] : 1];
    const tint = glassAmount;
    // A little white in a light tint, so it reads as glass rather than a flat dark wash.
    const lift = (1 - tint) * 0.1;
    return [...rgb.map(channel => channel + (1 - channel) * lift), 0.18 + tint * 0.46];
}

/** An opaque colour as dark as the island looks, as RGB: for rings and corners painted over it. */
export function solid() {
    const rgb = (shellFill ?? [0, 0, 0]).slice(0, 3);
    if (!glassOn)
        return rgb;
    const tint = glassAmount;
    return rgb.map(channel => channel * (0.4 + tint * 0.6));
}

/** The hairline round the island, as RGBA, or null for none. */
export function edge() {
    if (!glassOn)
        return null;
    return [1, 1, 1, 0.24 - glassAmount * 0.12];
}

/** How what is behind the island is blurred ({radius, brightness}), or null for not at all. */
export function blur() {
    if (!glassOn)
        return null;
    return {radius: Math.round(14 + glassAmount * 22), brightness: 1.08 - glassAmount * 0.2};
}
