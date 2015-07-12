var _ = require('lodash');
var wrapError = require('./wrap-error');
var app = require('ampersand-app');
var raf = require('raf');

module.exports = {
  fetch: function(options) {
    var model = this;
    model.client = app.client;
    var handler = _.result(model, 'scout');

    if (!handler || !_.isFunction(handler)) {
      throw new TypeError('No scout handler function declared on model or collection.');
    }

    options = options ? _.clone(options) : {};
    if (!options.parse) {
      options.parse = true;
    }

    var success = options.success;
    options.success = function(resp) {
      if (!model.set(model.parse(resp, options), options)) return false;
      if (success) {
        success(model, resp, options);
      }
      model.trigger('sync', model, resp, options);
    };

    wrapError(this, options);

    var done = function(err, res) {
      if (err) return options.error({}, 'error', err.message);
      raf(function call_scout_client_success() {
        options.success(res, 'success', res);
      });
    };
    raf(function call_scout_client() {
      handler.call(model, done);
    });
  }
};
