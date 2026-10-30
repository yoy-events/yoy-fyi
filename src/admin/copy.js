// Copies a short link to the clipboard. Pages work without this script: the link sits in a
// read-only field that can be selected and copied by hand. The page's <body> carries the
// "Copied" texts in its language; the button gets its own label back afterwards.
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const text = document.body.dataset;
  button.dataset.label ??= button.textContent;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.textContent = text.copied ?? "Copied";
  } catch {
    button.textContent = text.copyFailed ?? "Select and copy";
  }
  setTimeout(() => {
    button.textContent = button.dataset.label;
  }, 1500);
});

document.addEventListener("focusin", (event) => {
  if (event.target.matches("input[readonly]")) event.target.select();
});
