/*
 * GigAgent dashboard: when should the live stream (GET /api/stream) be open?
 *
 * Every open stream polls the database, which costs serverless time and keeps the database compute awake. So the
 * stream is open only when someone can benefit from it:
 *   - a job is live (connecting / working / idle): always, even in a background tab, so "job done" desktop
 *     notifications keep working;
 *   - otherwise, only while the tab is visible and the operator has interacted within `idlePauseMs`;
 *   - a hidden tab with no live job keeps the stream for `hiddenGraceMs` (quick tab switches stay seamless), then closes.
 * A closed stream reopens on interaction, when the tab becomes visible, or via resume(). The caller refetches
 * state on every (re)connect, so nothing is missed while paused.
 *
 * Plain script (no build step). Browser: window.GigStreamPolicy. Node tests: module.exports.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GigStreamPolicy = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var DEFAULTS = { hiddenGraceMs: 30000, idlePauseMs: 10 * 60000 };

  /**
   * deps: { now(), setTimer(fn, ms), clearTimer(id), isHidden(), hasLive(), connect(), disconnect(),
   *         onState(state, reason), hiddenGraceMs?, idlePauseMs? }
   * state: 'live' | 'paused'; reason (when paused): 'hidden' | 'idle'.
   */
  function createStreamPolicy(deps) {
    var hiddenGraceMs = deps.hiddenGraceMs != null ? deps.hiddenGraceMs : DEFAULTS.hiddenGraceMs;
    var idlePauseMs = deps.idlePauseMs != null ? deps.idlePauseMs : DEFAULTS.idlePauseMs;
    var running = false;
    var open = false; // we want a stream right now
    var pausedReason = null;
    var lastActivity = 0;
    var hiddenSince = null;
    var timer = null;

    function clear() {
      if (timer !== null) { deps.clearTimer(timer); timer = null; }
    }

    function evaluate() {
      if (!running) return;
      var t = deps.now();
      var deadline = Infinity;
      var reason = null;
      var want;

      if (deps.hasLive()) {
        hiddenSince = null; // a finished job restarts the hidden-tab grace period
        want = true;
      } else if (deps.isHidden()) {
        reason = 'hidden';
        if (hiddenSince === null) hiddenSince = t;
        deadline = hiddenSince + hiddenGraceMs;
        want = open && t < deadline; // a hidden tab never opens a stream, it only keeps one briefly
      } else {
        reason = 'idle';
        hiddenSince = null;
        deadline = lastActivity + idlePauseMs;
        want = t < deadline;
      }

      clear();
      if (want) {
        if (!open) { open = true; pausedReason = null; deps.connect(); deps.onState('live', null); }
        if (deadline !== Infinity) timer = deps.setTimer(evaluate, Math.max(deadline - t, 1));
      } else if (open || pausedReason !== reason) {
        var was = open;
        open = false;
        pausedReason = reason;
        if (was) deps.disconnect();
        deps.onState('paused', reason);
      }
    }

    return {
      /** Begin managing the stream (call after sign-in). Opens it immediately. */
      start: function () { running = true; lastActivity = deps.now(); hiddenSince = null; open = false; pausedReason = null; evaluate(); },
      /** Stop managing and close (sign-out). */
      stop: function () { running = false; clear(); if (open) { open = false; deps.disconnect(); } pausedReason = null; hiddenSince = null; },
      /** The operator interacted (call from pointer/key/scroll/focus listeners; cheap). */
      activity: function () { lastActivity = deps.now(); if (running && (pausedReason === 'idle' || timer !== null)) evaluate(); },
      /** document.visibilityState changed. */
      visibilityChanged: function () { if (!deps.isHidden()) lastActivity = deps.now(); evaluate(); },
      /** The live-session set may have changed (after any session/invite update). */
      liveChanged: function () { evaluate(); },
      /** Explicit "resume" (clicking the paused badge). */
      resume: function () { lastActivity = deps.now(); hiddenSince = null; evaluate(); },
      /** True if a stream is wanted right now (use before auto-reopening a closed EventSource). */
      wantsStream: function () { return running && open; },
      pausedReason: function () { return pausedReason; },
    };
  }

  return { createStreamPolicy: createStreamPolicy, DEFAULTS: DEFAULTS };
});
