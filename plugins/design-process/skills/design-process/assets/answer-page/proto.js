/* proto.js: turns a static board into a click-through prototype. The answer page injects it into
   each same-origin board iframe; boards carry no script of their own. What a board can rely on:
   - [role=tab]: a click selects it among the tabs of its [role=tablist] (else its parent). aria-selected
     moves, and the selected and unselected inline styles swap, so draw one tab of each. The panel stays.
     Arrow keys, Home and End move focus along the tabs (roving tabindex); Enter or Space selects.
   - buttons, links and tabs: hover and keyboard-focus feedback. Text fields work as normal.
   - href="#": does nothing.
   - data-goto="B4" on any element: a click asks the page to show board B4 (a tab with it navigates
     instead of switching). A link whose text is another screen's title (or its first words) does the same.
   - [data-goto] elements are outlined on touch screens and pulse once on load elsewhere, so mark only live ones.
     On touch, they and tabs get an invisible hit area of at least 60px around them.
   Nothing else moves: menus (aria-haspopup) do not open, and any other button or link asks the page to say
   it is not wired. */
(() => {
  if (window.__proto) return;
  window.__proto = true;
  const css = document.createElement("style");
  css.textContent = `
    a[href],button,[role=tab],[data-goto]{cursor:pointer;transition:box-shadow .12s}
    a[href]:hover,button:hover,[role=tab]:hover,[data-goto]:hover{box-shadow:inset 0 0 0 999px rgba(120,120,140,.14)}
    a[href]:active,button:active,[role=tab]:active{box-shadow:inset 0 0 0 999px rgba(120,120,140,.26)}
    :focus-visible{outline:2px solid #05585f!important;outline-offset:2px}
    [data-goto]{outline:2px solid transparent;outline-offset:3px}
    @media (prefers-reduced-motion:no-preference){[data-goto]{animation:proto-live 1s 2}}
    @keyframes proto-live{50%{outline-color:#05585f}}
    @media (any-pointer:coarse){[data-goto]{outline:2px dashed #05585f;animation:none}
      .proto-hit::after{content:"";position:absolute;left:50%;top:50%;width:max(100%,60px);height:max(100%,60px);transform:translate(-50%,-50%)}}`;
  document.head.append(css);
  // Touch: live controls get a hit area of at least 60 board px, which is 45px on screen at the 75% default.
  if (matchMedia("(any-pointer:coarse)").matches) document.querySelectorAll("[data-goto],[role=tab]").forEach(el => {
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    el.classList.add("proto-hit");
  });
  const ask = msg => parent.postMessage({ proto: 1, ...msg }, location.origin);
  const tabsOf = t => [...(t.closest("[role=tablist]") || t.parentElement).querySelectorAll("[role=tab]")];
  const rove = t => tabsOf(t).forEach(x => x.tabIndex = x === t ? 0 : -1);
  document.querySelectorAll("[role=tab][aria-selected=true]").forEach(rove);

  document.addEventListener("keydown", e => {
    const t = e.target.closest?.("[role=tab]");
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!t || (!step && e.key !== "Home" && e.key !== "End")) return;
    e.preventDefault();
    const all = tabsOf(t), i = all.indexOf(t);
    const next = all[e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (i + step + all.length) % all.length];
    rove(next); next.focus();
  });

  document.addEventListener("click", e => {
    const el = e.target.closest("a,button,[role=tab],[data-goto]");
    if (!el) return;
    if (el.matches('a[href="#"]')) e.preventDefault();
    const goto = el.closest("[data-goto]")?.dataset.goto;
    if (goto) return ask({ goto });
    if (el.getAttribute("role") === "tab" && el.getAttribute("aria-selected") !== "true") {
      const list = el.closest("[role=tablist]") || el.parentElement;
      const old = [...list.querySelectorAll("[role=tab]")].find(t => t.getAttribute("aria-selected") === "true");
      if (old) {
        const style = old.getAttribute("style") || "";
        old.setAttribute("style", el.getAttribute("style") || "");
        el.setAttribute("style", style);
        old.setAttribute("aria-selected", "false");
      }
      el.setAttribute("aria-selected", "true");
      rove(el);
    }
    const text = (el.textContent.replace(/\s+/g, " ").trim() || el.getAttribute("aria-label") || "");
    if (el.tagName === "A") ask({ link: text });
    else if (el.getAttribute("role") !== "tab" && !el.disabled) ask({ dead: text });
  });
})();
