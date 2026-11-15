const g = globalThis as Record<string, any>;
const panelsApi = g.chrome?.devtools?.panels ?? g.browser?.devtools?.panels;

if (panelsApi && typeof panelsApi.create === 'function') {
  panelsApi.create('OmniBuf', 'icons/icon-32.png', 'panel.html', () => {
    // Panel registered in browser Developer Tools
  });
}
