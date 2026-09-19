'use strict';

const { MongoMessageStore, createMongoMessageStore } = require('./mongoStore');
const { BillStore, createBillStore } = require('./billStore');

function createMessageStore(options = {}) {
  return createMongoMessageStore(options);
}

const MessageStore = MongoMessageStore;

module.exports = {
  createMessageStore,
  MessageStore,
  MongoMessageStore,
  createMongoMessageStore,
  BillStore,
  createBillStore,
};
