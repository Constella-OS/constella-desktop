/* eslint import/prefer-default-export: off */
import { URL } from 'url';
import path from 'path';

export function resolveHtmlPath(htmlFileName: string, route: string = '') {
  if (process.env.NODE_ENV === 'development') {
    const port = process.env.PORT || 1212;
    const url = new URL(`http://localhost:${port}${'?view=' + route}`);
    url.pathname = htmlFileName;
    return url.href;
  }
  // Packaged (file://) builds must carry the same `?view=` query the dev server
  // does — otherwise the secondary windows (search, search-overlay) load
  // index.html with an empty location.search and App.getView() falls through to
  // <MainView />, rendering the full DashboardHome inside the overlay panel.
  const filePath = path.resolve(__dirname, '../renderer/', htmlFileName);
  const query = route ? `?view=${encodeURIComponent(route)}` : '';
  return `file://${filePath}${query}`;
}
