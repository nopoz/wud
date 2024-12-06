const component = require('./component');

/**
 * Init Router.
 * @returns {*}
 */
function init() {
    const router = component.init('registry');
    router.get('/:name', (req, res) => component.getById(req, res, 'registry'));
    return router;
}

module.exports = {
    init,
};
