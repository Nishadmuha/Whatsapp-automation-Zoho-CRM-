'use strict';

const { MongoMessageStore, createMongoMessageStore } = require('./mongoStore');

function createMessageStore(options = {}) {
  return createMongoMessageStore(options);
}

const MessageStore = MongoMessageStore;

module.exports = {
  createMessageStore,
  MessageStore,
  MongoMessageStore,
  createMongoMessageStore
};
