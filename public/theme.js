// Apply the saved theme before the page paints (kept in a file so the security policy can forbid inline scripts).
try { var t = localStorage.getItem('aux-theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
