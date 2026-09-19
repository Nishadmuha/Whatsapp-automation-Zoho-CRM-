'use strict';

const { readFileSync } = require('node:fs');
const path = require('node:path');

const pages = {
  overview: { title: 'Command Center · Voltronix Automation Dashboard', breadcrumb: 'Overview', styles: ['overview'] },
  leads: { title: 'Leads · Voltronix', breadcrumb: 'Leads', styles: ['leads'] },
  chats: { title: 'Chats · Voltronix', breadcrumb: 'Chats', styles: ['chats'] },
  books: { title: 'Bills &amp; Invoices · Voltronix Automation Dashboard', breadcrumb: 'Bills', styles: ['leads', 'books'] },
};

// Only trusted, local templates are interpolated. Request parameters never become HTML.
function renderAdminPage(page, { billDashboard = false } = {}) {
  if (!Object.hasOwn(pages, page)) throw new Error('Unknown admin page');
  const definition = pages[page];
  const values = {
    page,
    title: definition.title,
    breadcrumb: page === 'books' && billDashboard ? 'Bill Dashboard' : definition.breadcrumb,
    styles: definition.styles.map(name => `  <link rel="stylesheet" href="/admin/${name}.css">`).join('\n'),
    scripts: `  <script src="/admin/${page}.js" defer></script>`,
    content: readFileSync(path.join(__dirname, '../admin', `${page}.html`), 'utf8'),
  };
  return readFileSync(path.join(__dirname, 'adminShell.html'), 'utf8')
    .replace(/\{\{(title|page|breadcrumb|styles|scripts|content)\}\}/g, (_match, key) => values[key]);
}

function sendAdminPage(page) {
  return (req, res) => res.type('html').send(renderAdminPage(page, { billDashboard: req.query.tab === 'dashboard' }));
}

module.exports = { renderAdminPage, sendAdminPage };
