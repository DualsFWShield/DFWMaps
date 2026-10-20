export function focusTrap(modal) {
  if (!modal) return () => {};
  const focusable = modal.querySelectorAll('a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
  const first = focusable[0], last = focusable[focusable.length - 1];
  function handle(e){
    if (e.key !== "Tab") return;
    if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first?.focus(); }
  }
  modal.addEventListener("keydown", handle);
  setTimeout(()=>{ first?.focus(); }, 0);
  return ()=>modal.removeEventListener("keydown", handle);
}
