/* toast.js — the little message that slides up from the bottom. */
import { $ } from "./util.js";

let timer = null;

export function toast(text, ms = 2800) {
  const node = $("#toast");
  if (!node) return;
  node.textContent = text;
  node.classList.add("is-shown");
  clearTimeout(timer);
  timer = setTimeout(() => node.classList.remove("is-shown"), ms);
}
