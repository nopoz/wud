const express = require('express');
const nocache = require('nocache');
const storeContainer = require('../store/container');
const registry = require('../registry');
const { getServerConfiguration, getTriggerConfigurations } = require('../configuration');
const HttpTrigger = require('../triggers/providers/http/Http');
const ScriptTrigger = require('../triggers/providers/script/Script');

const router = express.Router();

const serverConfiguration = getServerConfiguration();
const triggerConfigurations = getTriggerConfigurations();

/**
 * Initialize a trigger based on its type.
 * @param {String} triggerType - Type of the trigger ('http' or 'script').
 * @param {Object} triggerConfig - The trigger configuration.
 * @returns {HttpTrigger|ScriptTrigger} - Initialized trigger instance.
 */
function initializeTrigger(triggerType, triggerConfig) {
    if (!triggerConfig) {
        throw new Error(`No configuration provided for ${triggerType} trigger`);
    }
    switch (triggerType) {
        case 'http':
            return new HttpTrigger('http', triggerConfig);
        case 'script':
            return new ScriptTrigger('script', triggerConfig);
        default:
            throw new Error(`Unknown trigger type: ${triggerType}`);
    }
}

/**
 * Extract triggers with 'install' enabled.
 * @returns {Array} - List of trigger objects with install enabled.
 */
function getTriggersWithInstall() {
    const triggersWithInstall = [];

    ['http', 'script'].forEach((triggerType) => {
        const triggers = triggerConfigurations[triggerType] || {};
        Object.keys(triggers).forEach((triggerName) => {
            const triggerConfig = triggers[triggerName];
            if (String(triggerConfig.install).toLowerCase() === 'true') {
                triggersWithInstall.push({ triggerType, triggerName, triggerConfig });
            }
        });
    });

    return triggersWithInstall;
}

/**
 * Get all containers with 'install' flags.
 * @param {Object} req
 * @param {Object} res
 */
function getContainers(req, res) {
    const { query } = req;
    const containers = getContainersFromStore(query);

    const triggersWithInstall = getTriggersWithInstall();
    let installEnabled = false;

    if (triggersWithInstall.length === 1) {
        installEnabled = true;
    } else if (triggersWithInstall.length > 1) {
        installEnabled = 'multiple';
        console.warn('Multiple triggers have install enabled; install action will be disabled.');
    }

    const containersWithInstallFlag = containers.map((container) => ({
        ...container,
        install: installEnabled,
    }));

    res.status(200).json(containersWithInstallFlag);
}

/**
 * Install a container by ID.
 * @param {Object} req
 * @param {Object} res
 */
async function installContainer(req, res) {
    const { id } = req.params;

    const triggersWithInstall = getTriggersWithInstall();

    if (triggersWithInstall.length === 0) {
        return res.status(403).json({ error: 'Install not enabled' });
    } else if (triggersWithInstall.length > 1) {
        return res.status(400).json({
            error: 'Multiple install triggers are configured. Please ensure only one trigger has install enabled.',
        });
    }

    const { triggerType, triggerName, triggerConfig } = triggersWithInstall[0];
    const container = storeContainer.getContainer(id);

    if (!container) {
        console.warn(`Container with ID ${id} not found.`);
        return res.sendStatus(404);
    }

    try {
        const trigger = initializeTrigger(triggerType, triggerConfig);
        await trigger.install(container);

        // Set notification in container
        container.notification = {
            message: `Update for ${container.name} completed successfully.`,
            level: 'success',
        };
        // Update the container in the store
        storeContainer.updateContainer(container);

        res.status(200).json({ success: true });
    } catch (e) {
        // Log the error separately
        console.error(`Error installing container ${id}: ${e.message}`);

        // Set error notification in container
        container.notification = {
            message: `Update for ${container.name} failed: ${e.message}`,
            level: 'error',
        };
        // Update the container in the store
        storeContainer.updateContainer(container);

        // Return error response
        res.status(500).json({
            error: `Error when installing container ${id} (${e.message})`,
        });
    }
}

/**
 * Clear notification for a container by ID.
 * @param {Object} req
 * @param {Object} res
 */
function clearContainerNotification(req, res) {
    const { id } = req.params;
    const container = storeContainer.getContainer(id);

    if (container) {
        delete container.notification;
        storeContainer.updateContainer(container);
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
}

/**
 * Watch all containers.
 * @param {Object} req
 * @param {Object} res
 */
async function watchContainers(req, res) {
    try {
        await Promise.all(Object.values(getWatchers()).map((watcher) => watcher.watch()));
        getContainers(req, res);
    } catch (e) {
        res.status(500).json({ error: `Error when watching images (${e.message})` });
    }
}

/**
 * Watch a specific container by ID.
 * @param {Object} req
 * @param {Object} res
 */
async function watchContainer(req, res) {
    const { id } = req.params;
    const container = storeContainer.getContainer(id);

    if (!container) {
        return res.sendStatus(404);
    }

    const watcher = getWatchers()[`watcher.docker.${container.watcher}`];
    if (!watcher) {
        return res.status(500).json({ error: `No provider found for container ${id}` });
    }

    try {
        const containers = await watcher.getContainers();
        const containerFound = containers.find((c) => c.id === container.id);

        if (!containerFound) {
            return res.sendStatus(404);
        }

        const containerReport = await watcher.watchContainer(container);
        res.status(200).json(containerReport.container);
    } catch (e) {
        res.status(500).json({ error: `Error when watching container ${id} (${e.message})` });
    }
}

/**
 * Get a specific container by ID.
 * @param {Object} req
 * @param {Object} res
 */
function getContainer(req, res) {
    const { id } = req.params;
    const container = storeContainer.getContainer(id);

    if (container) {
        res.status(200).json(container);
    } else {
        res.sendStatus(404);
    }
}

/**
 * Delete a container by ID.
 * @param {Object} req
 * @param {Object} res
 */
function deleteContainer(req, res) {
    if (!serverConfiguration.feature.delete) {
        return res.sendStatus(403);
    }

    const { id } = req.params;
    const container = storeContainer.getContainer(id);

    if (!container) {
        return res.sendStatus(404);
    }

    storeContainer.deleteContainer(id);
    res.sendStatus(204);
}

/**
 * Get all watchers.
 * @returns {Object}
 */
function getWatchers() {
    return registry.getState().watcher;
}

/**
 * Get containers from the store.
 * @param {Object} query
 * @returns {Array}
 */
function getContainersFromStore(query) {
    return storeContainer.getContainers(query);
}

/**
 * Initialize the router.
 * @returns {Router}
 */
function init() {
    router.use(nocache());
    router.get('/', getContainers);
    router.post('/watch', watchContainers);
    router.get('/:id', getContainer);
    router.delete('/:id', deleteContainer);
    router.post('/:id/watch', watchContainer);
    router.post('/:id/install', installContainer);
    router.post('/:id/clear-notification', clearContainerNotification);
    return router;
}

module.exports = {
    init,
    getContainersFromStore,
};
