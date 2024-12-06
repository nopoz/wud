const component = require('./component');
const registry = require('../registry');

/**
 * Run a specific trigger on a specific container provided in the payload.
 * @param {*} req
 * @param {*} res
 * @returns
 */
async function runTrigger(req, res) {
    const triggerType = req.params.type;
    const triggerName = req.params.name;
    const containerToTrigger = req.body;

    const triggerToRun = registry.getState().trigger[`trigger.${triggerType}.${triggerName}`];
    if (!triggerToRun) {
        res.status(404).json({
            error: `Error when running trigger ${triggerType}.${triggerName} (trigger not found)`,
        });
        return;
    }
    if (!containerToTrigger) {
        res.status(400).json({
            error: `Error when running trigger ${triggerType}.${triggerName} (container is undefined)`,
        });
        return;
    }

    try {
        await triggerToRun.trigger(containerToTrigger);
        res.status(200).json({});
    } catch (e) {
        res.status(500).json({
            error: `Error when running trigger ${triggerType}.${triggerName} (${e.message})`,
        });
    }
}

/**
 * Init Router.
 * @returns {*}
 */
function init() {
    const router = component.init('trigger');
    router.post('/:type/:name', (req, res) => runTrigger(req, res));
    return router;
}

module.exports = {
    init,
};
