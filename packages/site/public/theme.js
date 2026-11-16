// This classic script sets the theme before the first paint: the choice of the visitor, else the theme of the system.
// It is a file and not an inline script, because the policy of the runtime refuses each inline script.
try {
  const theme = localStorage.getItem("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // A browser with no storage keeps the theme of the system.
}
