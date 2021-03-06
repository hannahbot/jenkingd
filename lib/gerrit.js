var RSVP = require('rsvp');
var webpage = require('webpage');
var K = require('./constants');
var getPatches = require('./gerrit/get_patches');
var getPatch = require('./gerrit/get_patch');

var page, xsrfKey;
var connected = false;

/**
 * @internal Reset state.
 */
var reset = function() {
  if (page) {
    page.close();
    page = xsrfKey = undefined;
  }

  connected = false;
};

var sniffXSRFToken = function(xhr) {
  console.log('Sniffing XSRF token...');

  var authHeader = xhr.headers.filter(function(header) {
    return header.name === 'X-Gerrit-Auth';
  })[0];

  if (authHeader) {
    return authHeader.value;
  }

  return page.evaluate(function() {
    if ('gerrit_hostpagedata' in window) {
      try {
        return window.gerrit_hostpagedata.xGerritAuth;
      }
      catch (e) {
        return undefined;
      }
    }
  });
};

/**
 * @private
 *
 * Get the XSRF token from the gerrit page once it's visited. The promise will
 * be resolved only when the connection to gerrit is successful, *and* the token
 * has been sniffed.
 *
 * @param {Function} reject
 *        Called if the page could not be opened with a 200 status. The result
 *        will be an object with "status" and "message" fields from the XHR
 *        error.
 */
var prepareSession = function(resolve, reject, xhr) {
  console.log('Resource:', xhr.status, xhr.url);

  if (xhr.url === K.GERRIT_URL) {
    if (xhr.status === 200) {
      console.log('Connected to Gerrit, now sniffing XSRF token...');
      connected = true;
    }
    else {
      reset();

      reject({
        status: xhr.status,
        code: xhr.statusText
      });
    }
  }
  // Keep sniffing until we get the XSRF token:
  else if (!xsrfKey) {
    xsrfKey = sniffXSRFToken(xhr);
  }

  if (connected && xsrfKey) {
    console.log('XSRF token:', xsrfKey);
    resolve();
  }
};

var connect = function(authToken) {
  if (connected) {
    return disconnect().finally(connect.bind(null, authToken));
  }

  page = webpage.create();
  page.settings.loadImages = false;
  page.customHeaders = {
    'Authorization': authToken
  };

  return new RSVP.Promise(function(resolve, reject) {
    page.onResourceReceived = prepareSession.bind(null, resolve, reject);
    page.open(K.GERRIT_URL);
  }).then(function() {
    page.onResourceReceived = null; // stop sniffing
    return true;
  });
};

var disconnect = function() {
  return new RSVP.Promise(function(resolve, reject) {
    if (connected) {
      reset();
      resolve();
    }
    else {
      reject({
        status: 400,
        code: K.ERROR_DISCONNECTED
      });
    }
  });
};

module.exports = {
  /**
   * Connect to gerrit and start a new session. If a session already exists,
   * it will be discarded first and then a new one created.
   *
   * @return {RSVP.Promise}
   *         Resolves once the session is active, and rejected if the connection
   *         could not be made for any reason (connectivity or auth failures.)
   */
  connect: connect,

  /**
   * Destroy the active gerrit session.
   *
   * @return {RSVP.Promise}
   *         Resolves once the session has been destroyed, rejected if there
   *         is no active session.
   */
  disconnect: disconnect,

  isConnected: function() {
    return !!connected;
  },

  getPatches: function(query) {
    if (!connected) {
      return RSVP.reject({
        status: 400,
        code: K.ERROR_DISCONNECTED
      });
    }

    return getPatches(page, xsrfKey, query).then(function(patchIds) {
      return RSVP.all(
        patchIds.map(function(patchId) {
          return getPatch(patchId, page, xsrfKey);
        })
      );
    });
  },

  getPatch: function(patchId) {
    return getPatch(patchId, page, xsrfKey);
  }
};