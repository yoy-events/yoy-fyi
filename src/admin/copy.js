// Copies a short link to the clipboard. Pages work without this script: the link sits in a
// read-only field that can be selected and copied by hand.
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Select and copy";
  }
  setTimeout(() => {
    button.textContent = "Copy";
  }, 1500);
});

document.addEventListener("focusin", (event) => {
  if (event.target.matches("input[readonly]")) event.target.select();
});
