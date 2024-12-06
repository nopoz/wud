const component = require('./component');

/**
 * Init Router.
 * @returns {*}
 */
function init() {
    return component.init('authentication');
}

module.exports = {
    init,
};
