'use strict';
// Shared by the Node (REST) adapter and the Worker (AI binding) adapter. Pure: no I/O.
class ModelError extends Error {
  constructor(message, { status = null, kind = 'error', retryable = false } = {}) {
    super(message); this.name = 'ModelError'; this.status = status; this.kind = kind; this.retryable = retryable;
  }
}

module.exports = { ModelError };
