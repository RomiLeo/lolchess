"use strict";
(() => {
  const root = document.documentElement;
  const key = "lolchess-theme";
  const requested = new URLSearchParams(location.search).get("theme");
  let theme = "dark";
  if (requested === "light" || requested === "dark") {
    theme = requested;
  } else {
    try {
      if (localStorage.getItem(key) === "light") theme = "light";
    } catch { /* Storage can be unavailable in private browsing. */ }
  }
  root.dataset.theme = theme;

  function remember() {
    try { localStorage.setItem(key, theme); } catch { /* The URL retains the selection. */ }
  }
  if (requested === theme) remember();

  document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("theme-toggle");
    const link = document.getElementById("tool-link");
    function render() {
      const light = theme === "light";
      root.dataset.theme = theme;
      button.setAttribute("aria-pressed", String(light));
      button.title = light ? "다크 테마로 전환" : "라이트 테마로 전환";
      button.firstElementChild.textContent = light ? "☾" : "☀";
      const target = new URL(link.href);
      target.searchParams.set("theme", theme);
      link.href = target.href;
    }
    button.addEventListener("click", () => {
      theme = theme === "light" ? "dark" : "light";
      render();
      remember();
      const current = new URL(location.href);
      current.searchParams.set("theme", theme);
      history.replaceState(history.state, "", current);
    });
    render();
  });
})();
