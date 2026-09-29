/* Keyboard / mouse / touch input. Presses are queued as edges (consumed by the next simulation tick) so a tap
 * shorter than a frame still registers; key auto-repeat is ignored so holding a key never re-jumps.
 * Touch: during a run the duck zone (config TOUCH_DUCK_ZONE: the bottom third of the LEFT half of the canvas) ducks
 * while held and fast-falls in the air; every other touch jumps, so the right thumb and a tap near the ground on the
 * right always jump. opts: onGesture, onMute, onDebug, onPause, canDuck() (a run is on), surface (the canvas: the zone
 * is measured on its client rect; the viewport without it), duckZone ({x1, y0} fractions), hitUi(x, y) (true when an
 * on-canvas button at client (x, y) handled the press: no jump / duck), isUiTarget(target, event) (true for the DOM
 * overlay UI, e.g. the share button / menu ([data-ui]), and for a press that only dismissed its menu: such events are
 * never game presses and keep their default action, so Space / Enter activate a focused button instead of restarting;
 * only M (mute) and Shift+D still work there). */
(function (root) {
  'use strict';
  var RDG = (root.RDG = root.RDG || {});

  var JUMP_CODES = { Space: 1, ArrowUp: 1, KeyW: 1 };
  var DUCK_CODES = { ArrowDown: 1, KeyS: 1 };
  var BLOCK_CODES = { Space: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, PageUp: 1, PageDown: 1, Home: 1, End: 1 };
  // a modifier on its own is no key press (Shift of Shift+D must not resume a paused game)
  var MODIFIER_CODES = {
    ShiftLeft: 1, ShiftRight: 1, ControlLeft: 1, ControlRight: 1, AltLeft: 1, AltRight: 1, MetaLeft: 1, MetaRight: 1,
    OSLeft: 1, OSRight: 1, CapsLock: 1, Fn: 1, FnLock: 1
  };
  var MODIFIER_KEYS = { Shift: 1, Control: 1, Alt: 1, AltGraph: 1, Meta: 1, OS: 1, CapsLock: 1, Fn: 1, FnLock: 1 };

  var DEFAULT_ZONE = { x1: 0.5, y0: 2 / 3 };

  function create(opts) {
    opts = opts || {};
    var zone = opts.duckZone || DEFAULT_ZONE;
    var st = {
      jumpHeld: false, duckHeld: false, jumpPresses: 0, duckPresses: 0, anyPresses: 0, restartPresses: 0,
      touchSeen: false, keyJump: false, keyDuck: false, touchDucks: 0, // touchDucks: duck-zone presses so far
      pointerJump: {}, pointerDuck: {} // sets of held pointer ids (a second finger lifting never releases the first)
    };

    function gesture() { if (opts.onGesture) opts.onGesture(); }
    function hasAny(o) { for (var k in o) return true; return false; }
    function refresh() {
      st.jumpHeld = st.keyJump || hasAny(st.pointerJump);
      st.duckHeld = st.keyDuck || hasAny(st.pointerDuck);
    }
    function pressJump() { st.jumpPresses++; st.anyPresses++; }
    function pressDuck() { st.duckPresses++; st.anyPresses++; }

    /** Event aimed at the overlay UI (share button / menu) or consumed by it: not a game input. */
    function onUi(e) { return !!(opts.isUiTarget && opts.isUiTarget(e.target, e)); }

    function onKeyDown(e) {
      var code = e.code || '';
      if (onUi(e)) {
        // a focused UI control keeps its keys (Space / Enter activate it, arrows move in its menu, Esc closes it)
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        if (code === 'KeyM') { if (opts.onMute) opts.onMute(); }
        else if (code === 'KeyD' && e.shiftKey) { if (opts.onDebug) opts.onDebug(); }
        return;
      }
      if (BLOCK_CODES[code]) e.preventDefault();
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.repeat) {
        // no auto-repeat presses; but a key still held across a pause / blur (releaseAll dropped it) is held again,
        // without a new press edge, so a held ↓ keeps ducking after resuming
        if (DUCK_CODES[code] && !st.keyDuck) { st.keyDuck = true; refresh(); }
        else if (JUMP_CODES[code] && !st.keyJump) { st.keyJump = true; refresh(); }
        return;
      }
      gesture();
      if (JUMP_CODES[code]) { st.keyJump = true; refresh(); pressJump(); }
      else if (DUCK_CODES[code]) { st.keyDuck = true; refresh(); pressDuck(); }
      else if (code === 'Enter' || code === 'NumpadEnter') { st.restartPresses++; st.anyPresses++; }
      else if (code === 'KeyM') { if (opts.onMute) opts.onMute(); }
      else if (code === 'KeyD' && e.shiftKey) { if (opts.onDebug) opts.onDebug(); }
      else if (code === 'KeyP' || code === 'Escape') { if (opts.onPause) opts.onPause(); }
      else if (!MODIFIER_CODES[code] && !MODIFIER_KEYS[e.key]) st.anyPresses++; // any other key resumes a pause
    }
    function onKeyUp(e) {
      var code = e.code || '';
      // (a key-up on the UI still releases a held game key, but keeps its default: Space activates a button on key-up)
      if (BLOCK_CODES[code] && !onUi(e)) e.preventDefault();
      if (JUMP_CODES[code]) { st.keyJump = false; refresh(); }
      else if (DUCK_CODES[code]) { st.keyDuck = false; refresh(); }
    }

    /** Client rect of the play surface (the canvas), or the viewport. */
    function surfaceRect() {
      var el = opts.surface, r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (r && r.width > 0 && r.height > 0) return r;
      return { left: 0, top: 0, width: root.innerWidth || 1, height: root.innerHeight || 1 };
    }
    /** Client point (x, y) in the duck zone: left of zone.x1 and below zone.y0 (fractions of the surface; touches on
     * a pillarbox band count as left / right of the canvas). */
    function inDuckZone(x, y) {
      var r = surfaceRect();
      return x - r.left < r.width * zone.x1 && y - r.top > r.height * zone.y0;
    }

    function onPointerDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (onUi(e)) return; // the share button / menu, or a press that closed the menu
      e.preventDefault();
      gesture();
      if (e.pointerType === 'touch' || e.pointerType === 'pen') st.touchSeen = true;
      if (e.isPrimary) { st.pointerJump = {}; st.pointerDuck = {}; } // first finger down: drop ids whose pointerup was lost
      if (opts.hitUi && opts.hitUi(e.clientX, e.clientY)) return; // an on-canvas button (mute): not a game press
      // the duck zone ducks (fast-falls in the air) only while the game says ducking is possible (during a run);
      // otherwise it is an ordinary jump press, so a tap anywhere starts / restarts. The mouse never ducks.
      var duck = e.pointerType !== 'mouse' && (!opts.canDuck || opts.canDuck()) && inDuckZone(e.clientX, e.clientY);
      if (duck) { st.pointerDuck[e.pointerId] = 1; st.touchDucks++; refresh(); pressDuck(); }
      else { st.pointerJump[e.pointerId] = 1; refresh(); pressJump(); }
    }
    function onPointerUp(e) {
      if (e.type === 'pointerup') gesture(); // pointerup is a user-activation event (pointercancel is not)
      delete st.pointerJump[e.pointerId];
      delete st.pointerDuck[e.pointerId];
      refresh();
    }
    function releaseAll() {
      st.keyJump = st.keyDuck = false;
      st.pointerJump = {}; st.pointerDuck = {};
      refresh();
    }
    // (never on the overlay UI: a cancelled touchstart would swallow the button's click)
    function prevent(e) { if (e.cancelable && !onUi(e)) e.preventDefault(); }

    root.addEventListener('keydown', onKeyDown, { passive: false });
    root.addEventListener('keyup', onKeyUp, { passive: false });
    root.addEventListener('pointerdown', onPointerDown, { passive: false });
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerUp);
    root.addEventListener('touchend', gesture, { passive: true }); // activation-triggering on iOS: unlock audio here
    root.addEventListener('blur', releaseAll);
    // stop scrolling / pinch-zoom / double-tap zoom / long-press menus while playing
    root.addEventListener('touchstart', prevent, { passive: false });
    root.addEventListener('touchmove', prevent, { passive: false });
    root.addEventListener('gesturestart', prevent, { passive: false });
    root.addEventListener('contextmenu', prevent);
    root.addEventListener('dblclick', prevent);

    st.takeJump = function () { var n = st.jumpPresses; st.jumpPresses = 0; return n > 0; };
    st.takeDuck = function () { var n = st.duckPresses; st.duckPresses = 0; return n > 0; };
    st.takeAny = function () { var n = st.anyPresses; st.anyPresses = 0; return n > 0; };
    st.takeRestart = function () { var n = st.restartPresses; st.restartPresses = 0; return n > 0; };
    st.clear = function () { st.jumpPresses = st.duckPresses = st.anyPresses = st.restartPresses = 0; };
    st.releaseAll = releaseAll;
    st.inDuckZone = inDuckZone;
    st.isTouch = function () {
      return st.touchSeen || (root.matchMedia && root.matchMedia('(pointer: coarse)').matches) || false;
    };
    return st;
  }

  RDG.Input = { create: create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
