/**
 * jsdom, for `window.localStorage`.
 *
 * @jest-environment jsdom
 */
import { loadPref, savePref } from '../debug-prefs';
import { FogDebug } from '../fog-debug';
import { LightDebug } from '../light-debug';
import { WmoDebug, WmoDebugMode } from '../wmo-debug';

beforeEach(() => window.localStorage.clear());

describe('loadPref / savePref', () => {
  it('round-trips a boolean', () => {
    savePref('x', true);

    expect(loadPref('x', false)).toBe(true);
  });

  it('round-trips a string', () => {
    savePref('mode', 'vertexColor');

    expect(loadPref('mode', 'off')).toBe('vertexColor');
  });

  it('returns the fallback for a key never written', () => {
    expect(loadPref('missing', true)).toBe(true);
    expect(loadPref('missing', 'off')).toBe('off');
  });

  it('returns the fallback rather than the wrong TYPE', () => {
    // localStorage outlives builds: a value written by an older shape must not be pushed into a
    // uniform as a string where a boolean belongs.
    savePref('x', 'not a boolean');

    expect(loadPref('x', false)).toBe(false);
  });

  it('returns the fallback on corrupt JSON', () => {
    window.localStorage.setItem('debug.pref.x', '{broken');

    expect(loadPref('x', false)).toBe(false);
  });

  it('distinguishes a stored false from a missing key', () => {
    savePref('x', false);

    expect(loadPref('x', true)).toBe(false);
  });

  it('namespaces its keys, so it cannot collide with the saved mark', () => {
    savePref('savedCoords', true);

    expect(window.localStorage.getItem('debug.savedCoords')).toBeNull();
    expect(window.localStorage.getItem('debug.pref.savedCoords')).toBe('true');
  });
});

describe('debug switch persistence', () => {
  it('a fog switch survives a fresh instance', () => {
    new FogDebug().disabled = true;

    expect(new FogDebug().disabled).toBe(true);
  });

  it('a lighting switch survives a fresh instance', () => {
    new LightDebug().disabled = true;

    expect(new LightDebug().disabled).toBe(true);
  });

  it('a WMO mode survives a fresh instance', () => {
    new WmoDebug().mode = WmoDebugMode.VertexColor;

    expect(new WmoDebug().mode).toBe(WmoDebugMode.VertexColor);
  });

  it('switching back off persists too, rather than falling back to the default', () => {
    const debug = new FogDebug();
    debug.disabled = true;
    debug.disabled = false;

    expect(new FogDebug().disabled).toBe(false);
  });

  it('defaults to off with nothing stored', () => {
    expect(new FogDebug().disabled).toBe(false);
    expect(new LightDebug().disabled).toBe(false);
    expect(new WmoDebug().mode).toBe(WmoDebugMode.Off);
  });
});
