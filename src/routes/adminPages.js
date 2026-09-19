'use strict';

const express = require('express');
const { sendAdminPage } = require('../views/adminPage');

// The admin shell is rendered by one route table. Feature routers must not own
// complete dashboard documents; they only own their API and static page assets.
function createAdminPagesRouter({ adminAccess }) {
  const router = express.Router();

  router.get(['/dashboard', '/overview', '/admin/dashboard', '/admin/overview',
    '/overview.html', '/admin/overview.html'], adminAccess.requireUiOverviewAuth, sendAdminPage('overview'));
  router.get(['/leads', '/leads/', '/admin/leads', '/admin/leads/',
    '/leads.html', '/admin/leads.html'], adminAccess.requireUiLeadsAuth, sendAdminPage('leads'));
  router.get(['/chats', '/chats/', '/admin/chats', '/admin/chats/',
    '/chats.html', '/admin/chats.html'], adminAccess.requireUiChatsAuth, sendAdminPage('chats'));
  router.get(['/bills', '/bills/', '/books', '/books/', '/admin/bills',
    '/admin/bills/', '/admin/books', '/admin/books/', '/books.html',
    '/admin/books.html'], adminAccess.requireUiBooksAuth, sendAdminPage('books'));

  return router;
}

module.exports = { createAdminPagesRouter };
