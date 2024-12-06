const component = require('./component');

/**
 * Init Router.
 * @returns {*}
 */
function init() {
    return component.init('watcher');
}

module.exports = {
    init,
};
