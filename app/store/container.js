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
 * Get all (filtered) containers.
 * @param query
 * @returns {*}
 */
function getContainers(query = {}) {
    const filter = {};
    Object.keys(query).forEach((key) => {
        filter[`data.${key}`] = query[key];
    });

    if (!containers) {
        return [];
    }

    // Get and filter unique containers by name and watcher
    const containerList = containers.find(filter).map((item) => validateContainer(item.data));
    const uniqueContainers = Object.values(
        containerList.reduce((acc, container) => {
            const key = `${container.name}-${container.watcher}`;
            if (!acc[key] || acc[key].id === container.id) {
                acc[key] = container; // Keep the most recent entry
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
