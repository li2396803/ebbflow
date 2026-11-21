/* ==========================================================================
   ui：浮层管理（modal / drawer / popover）、toast、命令面板、焦点管理
   ========================================================================== */

import { $, $$, esc, trapFocus } from "./util.js";

/* ------------------------------- Toast ------------------------------- */
export function toast(msg, kind = "info", ms = 2600) {
  const host = $("#toastHost");
  if (!host) return;
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.kind = kind;
  const ico = kind === "error" ? "i-alert" : kind === "ok" ? "i-check" : "i-info";
  node.innerHTML = `<svg aria-hidden="true"><use href="#${ico}"/></svg><span>${esc(msg)}</span>`;
  host.append(node);
  setTimeout(() => {
    node.dataset.leaving = "1";
    setTimeout(() => node.remove(), 220);
  }, ms);
}

/* ==========================================================================
   浮层：mask + panel 成对管理，支持叠层 Esc 关闭、滚动锁、焦点还原
   ========================================================================== */
const stack = [];
let lockCount = 0;

function lockScroll(on) {
  if (on) {
    lockCount += 1;
    if (lockCount === 1) {
      const sb = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = "hidden";
      if (sb > 0) document.body.style.paddingRight = sb + "px";
    }
  } else {
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) {
      document.body.style.overflow = "";
      document.body.style.paddingRight = "";
    }
  }
}

/**
 * @param {HTMLElement} mask
 * @param {HTMLElement} panel
 * @param {object} opt { onClose, initialFocus, className }
 */
export function openOverlay(mask, panel, opt = {}) {
  if (!mask || !panel) return;
  if (stack.some((s) => s.panel === panel)) return;
  const prevFocus = document.activeElement;
  mask.hidden = false;
  panel.hidden = false;
  // 强制 reflow 后加 data-open，触发过渡
  void mask.offsetWidth;
  mask.dataset.open = "1";
  panel.dataset.open = "1";
  lockScroll(true);
  const releaseTrap = trapFocus(panel);
  const entry = {
    mask,
    panel,
    onClose: opt.onClose,
    close: () => closeOverlay(panel),
    release: () => {
      releaseTrap();
      lockScroll(false);
      mask.dataset.open = "0";
      panel.dataset.open = "0";
      setTimeout(() => {
        mask.hidden = true;
        panel.hidden = true;
      }, 230);
      try {
        prevFocus?.focus?.({ preventScroll: true });
      } catch (e) {}
    },
  };
  stack.push(entry);
  setTimeout(() => {
    const target =
      (opt.initialFocus && panel.querySelector(opt.initialFocus)) ||
      panel.querySelector("input,button,[tabindex='0']") ||
      panel;
    try {
      target.focus({ preventScroll: true });
    } catch (e) {}
  }, 30);
  return entry;
}

export function closeOverlay(panel) {
  const i = stack.findIndex((s) => s.panel === panel);
  if (i < 0) return;
  const [entry] = stack.splice(i, 1);
  entry.onClose?.();
  entry.release();
}

export function closeTopOverlay() {
  const top = stack[stack.length - 1];
  if (top) closeOverlay(top.panel);
  return !!top;
}

export const hasOverlay = () => stack.length > 0;

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (closeTopOverlay()) {
    e.preventDefault();
    e.stopPropagation();
  }
});

/** 每个遮罩对应的面板（用于点击遮罩关闭） */
export const maskPanel = (mask) => {
  if (!mask) return null;
  if (mask.id === "drawerMask") return document.getElementById("drawer");
  if (mask.id === "paletteMask") return mask.querySelector(".palette");
  return mask.firstElementChild;
};

for (const sel of ["#allMask", "#qMask", "#paletteMask", "#drawerMask"]) {
  const node = document.querySelector(sel);
  if (!node) continue;
  node.addEventListener("click", (e) => {
    if (e.target !== node) return;
    const panel = maskPanel(node);
    if (panel) closeOverlay(panel);
  });
}

/* ------------------------------- Popover ------------------------------- */
let popState = null;

export function openPopover(pop, anchor, build) {
  closePopover();
  pop.innerHTML = "";
  build(pop);
  pop.hidden = false;
  void pop.offsetWidth;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth || 220;
  const h = pop.offsetHeight || 200;
  let left = Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  pop.dataset.open = "1";
  anchor.setAttribute("aria-expanded", "true");
  const onDoc = (e) => {
    if (pop.contains(e.target) || anchor.contains(e.target)) return;
    closePopover();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePopover();
      anchor.focus?.();
    }
  };
  setTimeout(() => {
    document.addEventListener("pointerdown", onDoc, { capture: true });
    document.addEventListener("keydown", onKey, { capture: true });
  }, 0);
  popState = { pop, anchor, onDoc, onKey };
}

export function closePopover() {
  if (!popState) return;
  const { pop, anchor, onDoc, onKey } = popState;
  popState = null;
  document.removeEventListener("pointerdown", onDoc, { capture: true });
  document.removeEventListener("keydown", onKey, { capture: true });
  pop.dataset.open = "0";
  anchor?.setAttribute("aria-expanded", "false");
  setTimeout(() => {
    if (!popState) pop.hidden = true;
  }, 160);
}

export const popoverOpen = () => !!popState;

/* ------------------------------- 小工具 ------------------------------- */
export function setBusy(node, on) {
  if (!node) return;
  node.classList.toggle("busy", !!on);
  node.setAttribute("aria-busy", on ? "true" : "false");
}

/* ==========================================================================
   命令面板（搜索 / 对比选择）
   ========================================================================== */
export function createPalette({ maskSel = "#paletteMask", inputSel = "#paletteInput", listSel = "#paletteList", hintSel = "#paletteHint" } = {}) {
  const mask = $(maskSel);
  const input = $(inputSel);
  const list = $(listSel);
  const hint = $(hintSel);
  if (!mask || !input || !list) return null;

  let mode = "search"; // search | compare
  let provider = () => ({ groups: [] });
  let onPick = () => {};
  let flat = [];
  let active = 0;

  const makeList = () => {};

  const renderRows = () => {
    const q = input.value.trim();
    const { groups, hint: h } = provider(q, mode);
    flat = [];
    if (!groups.length) {
      list.innerHTML = `<div class="state state--sm" style="padding:var(--sp-6) var(--sp-4)">
        <div class="state-ico" aria-hidden="true"><svg width="18" height="18"><use href="#i-search"/></svg></div>
        <p class="state-title">没有匹配项</p>
        <p class="state-desc">试试小类中文名、拼音首字母（如 bdxt）或 6 位 ETF 代码。</p>
      </div>`;
      if (hint) hint.textContent = h || "";
      return;
    }
    let html = "";
    for (const g of groups) {
      html += `<div class="palette-group">${esc(g.label)}</div>`;
      for (const it of g.items) {
        const idx = flat.length;
        flat.push(it);
        html += `<button class="palette-item" type="button" role="option" id="popt-${idx}" aria-selected="${idx === active}" data-idx="${idx}">
          ${it.color ? `<span class="cat-dot" style="background:${esc(it.color)}"></span>` : ""}
          <span class="pi-main">${esc(it.label)}</span>
          ${it.code ? `<span class="pi-code">${esc(it.code)}</span>` : ""}
          <span class="pi-meta">${esc(it.meta || "")}</span>
        </button>`;
      }
    }
    list.innerHTML = html;
    if (hint) hint.textContent = h || "";
    scrollActiveIntoView();
  };

  const scrollActiveIntoView = () => {
    const node = list.querySelector(`.palette-item[data-idx="${active}"]`);
    if (!node) return;
    const top = node.offsetTop;
    if (top < list.scrollTop || top + node.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top - list.clientHeight / 2 + node.offsetHeight / 2;
    }
    list.setAttribute("aria-activedescendant", node.id);
  };

  const setActive = (i) => {
    if (!flat.length) return;
    active = (i + flat.length) % flat.length;
    $$(".palette-item", list).forEach((n) => n.setAttribute("aria-selected", String(+n.dataset.idx === active)));
    scrollActiveIntoView();
  };

  const panel = mask.querySelector(".palette") || mask;
  const pick = (i) => {
    const it = flat[i];
    if (!it) return;
    const keepOpen = onPick(it, mode);
    if (!keepOpen) {
      closeOverlay(panel);
    } else {
      input.value = "";
      active = 0;
      renderRows();
      input.focus();
    }
  };

  input.addEventListener("input", () => {
    active = 0;
    renderRows();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(flat.length - 1);
    }
  });
  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".palette-item");
    if (!btn) return;
    pick(+btn.dataset.idx);
  });
  list.addEventListener("pointermove", (e) => {
    const btn = e.target.closest(".palette-item");
    if (!btn) return;
    const i = +btn.dataset.idx;
    if (i !== active) setActive(i);
  });

  return {
    open(opts = {}) {
      mode = opts.mode || "search";
      provider = opts.provider || provider;
      onPick = opts.onPick || onPick;
      active = 0;
      input.value = opts.query || "";
      input.placeholder = opts.placeholder || "搜索小类 / 拼音首字母 / ETF 代码或名称…";
      makeList();
      renderRows();
      openOverlay(mask, panel, {
        onClose: opts.onClose,
        initialFocus: "#paletteInput",
      });
      setTimeout(() => {
        input.focus();
        input.select();
      }, 40);
    },
    close() {
      closeOverlay(panel);
    },
    get mode() {
      return mode;
    },
  };
}
