'use strict';

// Zoho exposes has_more_page, not a reliable total-page count. Small contact
// lists stay sequential; large lists read three pages at a time. Consume each
// batch in page order so duplicate handling and required-page errors retain the
// same meaning as a sequential scan. All started reads settle before returning.
async function visitContactPages({ fetchPage, visitPage, incompleteError, maxPages = 100 }) {
  for (let firstPage = 1; firstPage <= maxPages;) {
    const count = Math.min(firstPage <= 2 ? 1 : 3, maxPages - firstPage + 1);
    const results = await Promise.allSettled(Array.from({ length: count }, (_, offset) =>
      Promise.resolve().then(() => fetchPage(firstPage + offset))));

    for (let offset = 0; offset < results.length; offset += 1) {
      const result = results[offset];
      if (result.status === 'rejected') throw result.reason;
      const page = firstPage + offset;
      const data = result.value;
      await visitPage(data, page);
      // Any already-fetched pages after this confirmed end are speculative.
      // Their records and errors must not change the completed lookup result.
      if (!data?.page_context?.has_more_page) return;
      if (page === maxPages) throw incompleteError();
    }
    firstPage += count;
  }
}

module.exports = { visitContactPages };
