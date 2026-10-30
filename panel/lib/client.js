// Browser half of @dsh-external/dsh-memo-tuner: a translucent badge next to the
// session header's current-preset label, shown only while the `memo-river`
// preset is selected. Clicking it opens a follow-along iframe onto
// /memo-river/tuning/panel (the panel page is served by memo-river itself).
//
// This file is served verbatim by the host's client-modules bundle route and
// executed through the lazy CJS module table. No bundler/transpiler runs on it
// — plain ES2017-ish JS.
//
// Design record: DESIGN.md §6.6「GUI 卫星包」(2026-09-13 用户拍板 v2 相对锚定，
// 否掉 v1 右下角浮动按钮).

window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-memo-tuner",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ---- styles ----------------------------------------------------------
    var CSS_ID = "@dsh-external/dsh-memo-tuner/styles";
    if (
      typeof document !== "undefined" &&
      document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null
    ) {
      var style = document.createElement("style");
      style.dataset.plugin = "@dsh-external/dsh-memo-tuner";
      style.dataset.pluginCss = CSS_ID;
      style.textContent = [
        ".memo-tuner-badge{display:inline-flex;align-items:center;gap:2px;",
        "margin-left:6px;padding:1px 7px;border-radius:9px;",
        "font-size:11px;line-height:16px;white-space:nowrap;",
        "opacity:.55;cursor:pointer;user-select:none;",
        "background:rgba(127,127,127,.14);color:inherit;",
        "transition:opacity .15s ease}",
        ".memo-tuner-badge:hover{opacity:1}",
        ".memo-tuner-badge[data-open='true']{opacity:1}",
        ".memo-tuner-frame{position:fixed;z-index:2147483000;",
        "border:1px solid rgba(127,127,127,.35);border-radius:10px;",
        "overflow:hidden;box-shadow:0 10px 34px rgba(0,0,0,.28);",
        "background:var(--dsh-bg,#fff)}",
        ".memo-tuner-frame iframe{display:block;width:100%;height:100%;border:0}",
      ].join("");
      document.head.appendChild(style);
    }

    // ---- constants -------------------------------------------------------
    var ANCHOR_RE = /记忆河流|Memo\s*River|memo-river/i;
    var BADGE_TEXT = "🌊 记忆河流";
    var PANEL_URL = "/memo-river/tuning/panel";
    var POLL_MS = 3000;
    var FRAME_W = 420;
    var FRAME_H = 520;
    var FRAME_GAP = 8;
    var BADGE_FLAG = "memoTunerBadge";

    // Candidate roots that may contain the header's preset label. The header
    // layout is「标题 → 当前预设显示」, so the label sits in the header.
    var ROOT_SEL = [
      "header",
      '[class*="header"]',
      '[class*="Header"]',
      '[class*="titleBar"]',
      '[class*="topBar"]',
    ].join(",");

    // ---- helpers ---------------------------------------------------------
    function isLeaf(el) {
      for (var i = 0; i < el.children.length; i++) {
        var child = el.children[i];
        if (child.textContent && child.textContent.trim().length > 0) {
          return false;
        }
      }
      return true;
    }

    function findAnchor() {
      var roots = document.querySelectorAll(ROOT_SEL);
      for (var r = 0; r < roots.length; r++) {
        var root = roots[r];
        // The badge itself must never be mistaken for the anchor.
        if (root.hasAttribute && root.hasAttribute("data-memo-tuner")) continue;
        var all = root.querySelectorAll("*");
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.hasAttribute("data-memo-tuner")) continue;
          if (!isLeaf(el)) continue;
          var text = (el.textContent || "").trim();
          if (text.length === 0 || text.length > 40) continue;
          if (ANCHOR_RE.test(text)) return el;
        }
      }
      return null;
    }

    function removeBadge() {
      var badges = document.querySelectorAll('[data-memo-tuner="badge"]');
      for (var i = 0; i < badges.length; i++) {
        var b = badges[i];
        if (b.parentNode) b.parentNode.removeChild(b);
      }
      closeFrame();
    }

    function closeFrame() {
      var frames = document.querySelectorAll('[data-memo-tuner="frame"]');
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        if (f.parentNode) f.parentNode.removeChild(f);
      }
      var open = document.querySelectorAll('[data-memo-tuner="badge"]');
      for (var j = 0; j < open.length; j++) {
        open[j].setAttribute("data-open", "false");
      }
    }

    function placeFrame(badge) {
      var rect = badge.getBoundingClientRect();
      var left = Math.min(
        Math.max(FRAME_GAP, rect.left),
        Math.max(FRAME_GAP, window.innerWidth - FRAME_W - FRAME_GAP)
      );
      var top = rect.bottom + FRAME_GAP;
      if (top + FRAME_H > window.innerHeight - FRAME_GAP) {
        top = Math.max(FRAME_GAP, rect.top - FRAME_H - FRAME_GAP);
      }
      var frame = document.querySelector('[data-memo-tuner="frame"]');
      if (!frame) return;
      frame.style.left = left + "px";
      frame.style.top = top + "px";
      frame.style.width = FRAME_W + "px";
      frame.style.height = FRAME_H + "px";
    }

    function toggleFrame(badge) {
      if (document.querySelector('[data-memo-tuner="frame"]')) {
        closeFrame();
        return;
      }
      var frame = document.createElement("div");
      frame.className = "memo-tuner-frame";
      frame.setAttribute("data-memo-tuner", "frame");
      frame.style.width = FRAME_W + "px";
      frame.style.height = FRAME_H + "px";
      var iframe = document.createElement("iframe");
      iframe.setAttribute("src", PANEL_URL);
      iframe.setAttribute("title", "记忆河流 · 调参面板");
      frame.appendChild(iframe);
      document.body.appendChild(frame);
      placeFrame(badge);
      badge.setAttribute("data-open", "true");
    }

    function ensureBadge(anchor) {
      var existing = document.querySelector('[data-memo-tuner="badge"]');
      if (existing) {
        // Follow re-renders: re-home the badge if its anchor was replaced.
        if (existing.previousSibling === anchor) return;
        if (existing.parentNode) existing.parentNode.removeChild(existing);
      }
      var badge = document.createElement("span");
      badge.className = "memo-tuner-badge";
      badge.setAttribute("data-memo-tuner", "badge");
      badge.setAttribute("data-open", "false");
      badge.setAttribute("role", "button");
      badge.setAttribute("tabindex", "0");
      badge.setAttribute("title", "记忆河流调参面板");
      badge.textContent = BADGE_TEXT;
      badge.addEventListener("click", function (ev) {
        ev.stopPropagation();
        toggleFrame(badge);
      });
      badge.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          toggleFrame(badge);
        }
      });
      if (anchor.parentNode) {
        anchor.parentNode.insertBefore(badge, anchor.nextSibling);
      }
    }

    function sync() {
      if (typeof document === "undefined" || !document.body) return;
      var anchor = findAnchor();
      if (!anchor) {
        removeBadge();
        return;
      }
      ensureBadge(anchor);
      var badge = document.querySelector('[data-memo-tuner="badge"]');
      var frame = document.querySelector('[data-memo-tuner="frame"]');
      if (badge && frame) placeFrame(badge);
    }

    // ---- plugin ----------------------------------------------------------
    var inject = [];

    // Guards against a second apply() installing a duplicate observer / timer
    // (e.g. a hot reload). Reset by the disposer so dispose-then-reapply works.
    var mounted = false;

    function apply(ctx) {
      if (mounted) return;
      mounted = true;
      ctx.effect(() => {
        var observer = null;
        var timer = null;
        var onResize = function () {
          var badge = document.querySelector('[data-memo-tuner="badge"]');
          if (badge) placeFrame(badge);
        };
        var onKey = function (ev) {
          if (ev.key === "Escape") closeFrame();
        };
        try {
          observer = new MutationObserver(sync);
          observer.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
          });
          timer = setInterval(sync, POLL_MS);
          window.addEventListener("resize", onResize);
          document.addEventListener("keydown", onKey);
          sync();
        } catch (err) {
          if (typeof console !== "undefined" && console.warn) {
            console.warn("[dsh-memo-tuner] badge mount failed:", err);
          }
        }
        return () => {
          try {
            if (observer) observer.disconnect();
            if (timer !== null) clearInterval(timer);
            window.removeEventListener("resize", onResize);
            document.removeEventListener("keydown", onKey);
          } catch (e) {}
          removeBadge();
          mounted = false;
        };
      }, "dsh-memo-tuner: preset badge");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
