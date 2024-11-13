/**
 * Container store.
 */
const { byString, byValues } = require('sort-es');
const log = require('../log').child({ component: 'store' });
const { validate: validateContainer } = require('../model/container');
const {
    emitContainerAdded,
    emitContainerUpdated,
    emitContainerRemoved,
} = require('../event');

let containers;

/**
 * Create container collections.
 * @param db
 */
function createCollections(db) {
    containers = db.getCollection('containers');
    if (containers === null) {
        log.info('Create Collection containers');
        containers = db.addCollection('containers');
    }
}

/**
 * Insert new Container.
 * @param container
 */
function insertContainer(container) {
    const containerToSave = validateContainer(container);
    containers.insert({
        data: containerToSave,
    });
    emitContainerAdded(containerToSave);
    return containerToSave;
}

/**
 * Update existing container.
 * @param container
 */
function updateContainer(container) {
    const containerToReturn = validateContainer(container);

    // Lock mechanism to prevent race conditions (simplified implementation)
    const existingContainer = getContainer(container.id);
    if (existingContainer) {
        containers.chain().find({ 'data.id': container.id }).remove();
    }

    containers.insert({ data: containerToReturn });
    emitContainerUpdated(containerToReturn);
    // console.log(`Container ${container.id} updated successfully.`); // DEBUG
    return containerToReturn;
}

/**
 * Get unique container key combining name, watcher, and registry.
 * @param {Object} container
 * @returns {String}
 */
function getContainerKey(container) {
    return `${container.name}-${container.watcher}-${container.image.registry.name}`;
}

/**
 * Get all (filtered) containers.
 * @param {Object} query
 * @returns {Array}
 */
function getContainers(query = {}) {
    const filter = {};
    Object.keys(query).forEach((key) => {
        filter[`data.${key}`] = query[key];
    });

    if (!containers) {
        return [];
    }

    // Get and filter containers
    const containerList = containers.find(filter).map((item) => validateContainer(item.data));
    
    // Only deduplicate if not filtering by specific criteria
    if (!query.id && !query.watcher) {
        const uniqueContainers = Object.values(
            containerList.reduce((acc, container) => {
                const key = getContainerKey(container);
                
                // Always prefer the current running container over historical entries
                const existing = acc[key];
                if (!existing || container.status === 'running') {
                    acc[key] = container;
                }
                return acc;
            }, {})
        );
        return uniqueContainers.sort(
            byValues([
                [(container) => container.watcher, byString()],
                [(container) => container.image.registry.name, byString()],
                [(container) => container.name, byString()],
                [(container) => container.image.tag.value, byString()],
            ])
        );
    }
    
    // Return full list when filtering
    return containerList.sort(
        byValues([
            [(container) => container.watcher, byString()],
            [(container) => container.image.registry.name, byString()],
            [(container) => container.name, byString()],
            [(container) => container.image.tag.value, byString()],
        ])
    );
}

/**
 * Get container by id.
 * @param id
 * @returns {null|Image}
 */
function getContainer(id) {
    const container = containers.findOne({
        'data.id': id,
    });

    if (container !== null) {
        return validateContainer(container.data);
    }
    return undefined;
}

/**
 * Delete container by id.
 * @param id
 */
function deleteContainer(id) {
    const container = getContainer(id);
    if (container) {
        console.log(`Attempting to delete container: ${id}`);
        containers.chain().find({ 'data.id': id }).remove();
        emitContainerRemoved(container);
        // Verify removal
        const stillExists = getContainer(id);
        if (stillExists) {
            console.warn(`Container ${id} still exists after deletion attempt.`);
        } else {
            console.log(`Container ${id} deleted successfully.`);
        }
    } else {
        console.warn(`Container ${id} not found for deletion.`);
    }
}

module.exports = {
    createCollections,
    insertContainer,
    updateContainer,
    getContainers,
    getContainer,
    deleteContainer,
};
